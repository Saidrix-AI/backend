import { isResourcesEnabled } from "../../config/env.js";
import { DEFAULT_LANGUAGE, type Language } from "../../validation/language.js";
import { runWebSearch } from "../tools/web-search.js";
import { formatZodIssues, resolveLectureDeps, runForcedToolCall, type LlmDeps } from "./call.js";
import {
  PAID_COURSE_DOMAINS,
  canonicalize,
  dedupe,
  hostOf,
  isBlockedUrl,
  keepLive,
  numberedList,
  readPick,
  toCandidate as toLinkCandidate,
  type LinkCandidate,
  type NumberedPick,
} from "./linkPicking.js";
import { lectureLanguageLine, type LessonContext } from "./prompt.js";
import {
  emitResourcePicksTool,
  resourcesBlockSchema,
  type LessonBlueprint,
  type ResourcesBlock,
} from "./schema.js";

/**
 * The lecture's closing "Resources" section: free, topic-specific links the
 * student can go to next — official docs and good free writing, plus at most
 * one YouTube video.
 *
 * THE POINT OF THIS MODULE'S SHAPE: a model asked to write URLs writes ones
 * that do not exist, and the student finds that out by clicking. So the links
 * come from two live searches, the model receives them as a NUMBERED LIST and
 * can only answer with numbers, and every field the student ends up clicking is
 * copied out of our own candidate array afterwards. `emit_resource_picks` has
 * no url property at all, and step 7 below ignores anything else the model
 * invents. A hallucinated link is therefore not unlikely — it is unrepresentable.
 *
 * Best-effort throughout, like retrieveFreshContext: this NEVER throws, and
 * `null` simply means the lecture ships ending at its quiz, as it did before.
 */

// The candidate machinery (blocklist, canonicalisation, liveness, numbering)
// lives in linkPicking.ts, shared with the setup lane's downloads section.
// Re-exported here because this module was its original home.
export { PAID_COURSE_DOMAINS, isBlockedUrl };

/**
 * The appended outline topic's title. Deterministic rather than model-authored:
 * a section whose heading failed to generate is a hole in the page, and there
 * is nothing here worth an LLM's judgement.
 */
export const RESOURCES_TITLE: Record<Language, string> = {
  en: "Resources",
  bn: "আরও জানতে",
  "bn-latn": "Aro Jante Chao",
};

/** Spoken/standfirst line used when the model's `intro` is unusable. */
const FALLBACK_INTRO: Record<Language, string> = {
  en: "Here are a few free places to take this further when you are ready.",
  bn: "এই বিষয়ে আরও এগোতে চাইলে নিচের ফ্রি জায়গাগুলো দেখতে পারো।",
  "bn-latn": "Ei bishoye aro egote chaile niche er free jaygagulo dekhte paro.",
};

const READING_CANDIDATES = 10;
const VIDEO_CANDIDATES = 6;

export type ResourceCandidate = LinkCandidate;

export interface ResourcesResult {
  /** Ready for assembly; `id` and `topicId` are stamped by index.ts. */
  block: Omit<ResourcesBlock, "id" | "topicId">;
  /** Localized title for the outline topic this block gets. */
  topicTitle: string;
}

/**
 * The video id of a real watch page, or null. Channels, handles, playlists and
 * search-result pages all return null — none of them is "a video on this
 * topic", and Tavily returns all four.
 */
export function youtubeVideoId(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  const id = (v: string | null | undefined) => (v && /^[\w-]{11}$/.test(v) ? v : null);

  if (host === "youtu.be") return id(u.pathname.slice(1).split("/")[0]);
  if (host !== "youtube.com" && host !== "m.youtube.com") return null;
  if (u.pathname === "/watch") return id(u.searchParams.get("v"));
  // /shorts/<id> and /embed/<id> are real single videos; everything else
  // (/channel, /@handle, /playlist, /results, /c/…) is not.
  const m = u.pathname.match(/^\/(?:shorts|embed|v)\/([\w-]{11})/);
  return m ? id(m[1]) : null;
}

/** Cosmetic only — drives the badge the frontend shows next to each link. */
function readingKind(url: string): "doc" | "article" {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (/^(docs?|developer|devdocs|api|learn|reference)\./.test(host)) return "doc";
    if (/^\/(docs?|reference|api|manual|guide)(\/|$)/i.test(u.pathname)) return "doc";
    return "article";
  } catch {
    return "article";
  }
}

const toCandidate = (s: Parameters<typeof toLinkCandidate>[0]): ResourceCandidate | null =>
  toLinkCandidate(s, PAID_COURSE_DOMAINS);

function buildSystemPrompt(ctx: LessonContext): string {
  return `${lectureLanguageLine(ctx)}

You choose the further-reading links that close one lesson of Saidrix AI Tutor. You are given candidates that a web search already found. You do NOT search, and you do NOT write links: you answer with the NUMBER of a candidate, and the system fills in its address. Any URL you type is discarded.

Choose by what actually teaches THIS lesson:
- Prefer the primary source — the official documentation, specification or project guide — over a blog post restating it.
- Everything must be free and readable without an account, a trial or a paywall. If a candidate looks like a course landing page, a signup wall or a "premium" article, skip it.
- Skip anything that is merely adjacent. Three links that are exactly on this lesson beat six that are about the subject in general.
- Fewer is fine: two strong picks is a better answer than four padded ones.

THE VIDEO: pick one whenever the VIDEO list is not empty. Some students learn far better from watching than from reading, and this is the only video they are offered — leaving the slot empty because no candidate is perfect denies them that entirely. Choose the one that best covers this lesson, even if it also covers a little more. Omit the field ONLY when the list is empty, or when every candidate is plainly about a different subject.

"why" is one short line written to the student in your own words, saying what THEY will get from THAT link. Name the thing: what it covers, or when they would open it. Never restate the title, never write filler like "a useful resource", and never reuse a phrase from these instructions — every line must be about the specific link you picked.

"intro" is one warm sentence introducing the section. The voice tutor SPEAKS it aloud, so it must contain no URLs, no domain names and no list of titles.`;
}

function buildUserMessage(
  ctx: LessonContext,
  bp: LessonBlueprint,
  reading: ResourceCandidate[],
  videos: ResourceCandidate[],
): string {
  const list = numberedList;

  const lines = [
    `Lesson: "${ctx.topicTitle}" (course: ${ctx.courseTitle}, ${ctx.level})`,
    "",
    `What this lesson teaches: ${bp.scope}`,
    "",
    "The student should now be able to:",
    ...bp.objectives.map((o) => `- ${o}`),
    "",
    reading.length ? "READING candidates:" : "READING candidates: none — return an empty reading list.",
    ...list(reading),
  ];
  if (videos.length > 0) {
    lines.push("", "VIDEO candidates:", ...list(videos));
  } else {
    lines.push("", "VIDEO candidates: none — omit the video field.");
  }
  return lines.join("\n");
}

type Pick = NumberedPick;

export interface ResourcesInput {
  ctx: LessonContext;
  blueprint: LessonBlueprint;
  deps?: LlmDeps;
}

export async function buildResourcesBlock(input: ResourcesInput): Promise<ResourcesResult | null> {
  const { ctx, blueprint } = input;
  if (!isResourcesEnabled()) return null;

  const lang = ctx.language ?? DEFAULT_LANGUAGE;

  try {
    // No year in either query, unlike buildFreshnessQuery: further reading wants
    // the canonical evergreen documentation page, and a recency bias is exactly
    // what pushes that page out in favour of this month's blog chatter.
    const subject = `${ctx.topicTitle} ${ctx.courseTitle}`.replace(/\s+/g, " ").trim().slice(0, 120);

    // allSettled, not all: one dead search must not throw away the other's results.
    const [readingRes, videoRes] = await Promise.allSettled([
      runWebSearch(`${subject} official documentation guide`, {
        maxResults: READING_CANDIDATES,
        excludeDomains: [...PAID_COURSE_DOMAINS],
      }),
      runWebSearch(`${subject} tutorial explained`, {
        maxResults: VIDEO_CANDIDATES + 2,
        includeDomains: ["youtube.com", "youtu.be"],
      }),
    ]);

    const seen = new Set<string>();

    const readingRaw = readingRes.status === "fulfilled" ? readingRes.value.sources : [];
    const reading = dedupe(
      readingRaw.map(toCandidate).filter((c): c is ResourceCandidate => c !== null),
      seen,
      READING_CANDIDATES,
    );

    // Videos are NOT filtered on having a snippet, the way freshness.ts filters
    // its sources: YouTube results routinely come back with empty content, and
    // that filter would silently empty the video slot on every lecture.
    const videoRaw = videoRes.status === "fulfilled" ? videoRes.value.sources : [];
    const videos = dedupe(
      videoRaw
        .map(toCandidate)
        .filter((c): c is ResourceCandidate => c !== null)
        .map((c) => {
          const id = youtubeVideoId(c.url);
          return id ? { ...c, url: `https://www.youtube.com/watch?v=${id}` } : null;
        })
        .filter((c): c is ResourceCandidate => c !== null),
      seen,
      VIDEO_CANDIDATES,
    );

    if (reading.length === 0 && videos.length === 0) {
      console.info(`[lecture-maker] no resource candidates for "${ctx.topicTitle}"`);
      return null;
    }

    const liveReading = await keepLive(reading);
    if (liveReading.length === 0 && videos.length === 0) return null;

    const picked = await runForcedToolCall({
      deps: input.deps ?? resolveLectureDeps("resources"),
      tool: emitResourcePicksTool,
      system: buildSystemPrompt(ctx),
      user: buildUserMessage(ctx, blueprint, liveReading, videos),
      parse: (raw) => {
        const o = (raw ?? {}) as { intro?: unknown; reading?: unknown; video?: unknown };

        // Out-of-range and repeated numbers are dropped rather than rejected: a
        // repair round costs a call to recover a link we were happy to ship
        // three of anyway.
        const used = new Set<number>();
        const readingPicks: Pick[] = (Array.isArray(o.reading) ? o.reading : [])
          .map(readPick)
          .filter((p): p is Pick => p !== null)
          .filter((p) => p.number >= 1 && p.number <= liveReading.length)
          .filter((p) => (used.has(p.number) ? false : (used.add(p.number), true)))
          .slice(0, 5);

        const rawVideo = readPick(o.video);
        const videoPick =
          rawVideo && rawVideo.number >= 1 && rawVideo.number <= videos.length ? rawVideo : null;

        if (readingPicks.length === 0 && !videoPick) {
          return {
            success: false,
            issues:
              "no usable picks — every number was outside the candidate lists. Answer with the [n] " +
              "shown beside a candidate.",
          };
        }

        const intro =
          typeof o.intro === "string" && o.intro.trim() ? o.intro.replace(/\s+/g, " ").trim().slice(0, 400) : "";

        return { success: true, data: { intro, readingPicks, videoPick } };
      },
      sizeHint: "Emit at most four picks, one short line each.",
      // The emission is a handful of numbers and one-liners; a low cap turns a
      // runaway into a fast failure instead of a slow one.
      maxTokens: 700,
    });

    const links: ResourcesBlock["links"] = picked.readingPicks.map((p) => {
      const c = liveReading[p.number - 1]!;
      return { kind: readingKind(c.url), title: c.title, url: c.url, domain: c.domain, why: p.why };
    });
    if (picked.videoPick) {
      const c = videos[picked.videoPick.number - 1]!;
      links.push({ kind: "video", title: c.title, url: c.url, domain: c.domain, why: picked.videoPick.why });
    }

    const candidate = {
      type: "resources" as const,
      intro: picked.intro || FALLBACK_INTRO[lang],
      links: links.slice(0, 6),
    };

    // Belt and braces. assembledLectureSchema would catch a bad block too, but
    // there it is a 502 that loses the whole lecture; here it is a skip.
    const parsed = resourcesBlockSchema.safeParse(candidate);
    if (!parsed.success) {
      console.warn(`[lecture-maker] resources block failed its own schema: ${formatZodIssues(parsed.error)}`);
      return null;
    }

    console.info(
      `[lecture-maker] resources: ${links.length} link(s) for "${ctx.topicTitle}"` +
        `${picked.videoPick ? " (incl. video)" : ""}`,
    );
    return { block: parsed.data, topicTitle: RESOURCES_TITLE[lang] };
  } catch (err) {
    console.warn(
      `[lecture-maker] resources skipped for "${ctx.topicTitle}":`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}
