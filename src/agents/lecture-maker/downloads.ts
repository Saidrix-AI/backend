import { isResourcesEnabled } from "../../config/env.js";
import { DEFAULT_LANGUAGE, type Language } from "../../validation/language.js";
import { runWebSearch } from "../tools/web-search.js";
import { formatZodIssues, resolveLectureDeps, runForcedToolCall, type LlmDeps } from "./call.js";
import {
  PAID_COURSE_DOMAINS,
  dedupe,
  keepLive,
  numberedList,
  toCandidate,
  type LinkCandidate,
} from "./linkPicking.js";
import { lectureLanguageLine, type LessonContext } from "./prompt.js";
import {
  downloadsBlockSchema,
  emitDownloadPicksTool,
  type DownloadsBlock,
  type SetupBlueprint,
} from "./schema.js";

/**
 * The setup lecture's download section: where the student actually gets the
 * software.
 *
 * Built exactly like resources.ts and for a sharper version of the same reason.
 * A model asked to write a download URL writes one that does not exist — or,
 * worse, one that does and is not the vendor's. So the links come from a live
 * search, the model receives them as a NUMBERED LIST and may only answer with
 * numbers, and every url the student clicks is copied out of our own candidate
 * array afterwards. `emit_download_picks` has no url property at all.
 *
 * Best-effort throughout: this NEVER throws. `null` means the planner's
 * downloads entry is skipped and the guide ships without the section, which is
 * strictly better than shipping a link nobody checked.
 */

/**
 * Download aggregators, mirrors and "free software" portals. This is a SAFETY
 * list, not a tidiness one: these sites wrap the real installer in their own
 * downloader, and the student would run it with admin rights. Applied as
 * Tavily's `exclude_domains` and again as a post-filter, same as the paid-course
 * list it is combined with.
 */
export const UNTRUSTED_DOWNLOAD_DOMAINS = [
  "softonic.com", "filehippo.com", "uptodown.com", "download.cnet.com", "cnet.com",
  "soft112.com", "filepuma.com", "majorgeeks.com", "softpedia.com", "downloadastro.com",
  "oldversion.com", "filehorse.com", "malavida.com", "en.softonic.com", "getintopc.com",
  "filecr.com", "sourceforge.net", "softlay.com", "freedownloadmanager.org",
] as const;

const DOWNLOAD_BLOCKLIST = [...UNTRUSTED_DOWNLOAD_DOMAINS, ...PAID_COURSE_DOMAINS];

/** How many of the blueprint's tools get their own search. */
const MAX_TOOLS_SEARCHED = 3;
/** Candidates kept per tool before ranking. */
const PER_TOOL_CANDIDATES = 5;
/** Candidates shown to the picker in total. */
const MAX_CANDIDATES = 10;

/** Spoken/standfirst line used when the model's `intro` is unusable. */
const FALLBACK_INTRO: Record<Language, string> = {
  en: "Here is where to download everything you need. Grab the file for your computer before moving on.",
  bn: "যা যা লাগবে সব এখান থেকে ডাউনলোড করো। এগোনোর আগে তোমার কম্পিউটারের জন্য ঠিক ফাইলটা নামিয়ে নাও।",
  "bn-latn": "Ja ja lagbe sob ekhan theke download koro. Egonor age tomar computer er jonno thik file ta namiye nao.",
};

/** The word a search engine wants for each OS. */
const OS_QUERY_WORD: Record<string, string> = {
  windows: "Windows",
  macos: "macOS",
  linux: "Linux",
};

export interface DownloadsResult {
  /** Ready for assembly; `id` and `topicId` are stamped by index.ts. */
  block: Omit<DownloadsBlock, "id" | "topicId">;
}

/**
 * Word-ish tokens of a product name, for spotting the vendor's own host:
 * "Visual Studio Code" → ["visual", "studio", "code"], and
 * `code.visualstudio.com` contains both "visualstudio" and "code".
 */
function nameTokens(name: string): string[] {
  return name
    .toLowerCase()
    .split(/[^a-z0-9+]+/)
    .filter((t) => t.length >= 3);
}

/**
 * Ranks a tool's candidates so the vendor's own site comes first.
 *
 * A model told "prefer the official site" mostly complies, but "mostly" is the
 * wrong bar for a link someone runs as an installer — so the ordering is decided
 * here, in code, and the model only picks from a list already sorted that way.
 * Stable within a score, so search rank breaks ties.
 */
export function rankByVendor(candidates: LinkCandidate[], toolName: string): LinkCandidate[] {
  const tokens = nameTokens(toolName);
  const squashed = tokens.join("");
  const score = (c: LinkCandidate): number => {
    const host = c.domain.toLowerCase();
    const bare = host.replace(/[^a-z0-9]/g, "");
    // The whole product name in the host ("visualstudio.com" for Visual Studio
    // Code) is as close to "this is the vendor" as a heuristic gets.
    if (squashed && bare.includes(squashed)) return 3;
    if (tokens.some((t) => bare.includes(t))) return 2;
    // A generic host that at least looks like a project's own docs.
    if (/\.(org|dev|io)$/.test(host) || host.endsWith(".github.io")) return 1;
    return 0;
  };
  return candidates
    .map((c, i) => ({ c, i, s: score(c) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.c);
}

/** One search per tool, ranked vendor-first, merged in blueprint order. */
async function gatherCandidates(bp: SetupBlueprint, os: string | undefined): Promise<LinkCandidate[]> {
  const osWord = os ? (OS_QUERY_WORD[os] ?? "") : "";
  const tools = bp.tools.slice(0, MAX_TOOLS_SEARCHED);

  const results = await Promise.allSettled(
    tools.map((t) =>
      runWebSearch(`${t.name} official download${osWord ? ` ${osWord}` : ""}`, {
        maxResults: PER_TOOL_CANDIDATES + 3,
        excludeDomains: DOWNLOAD_BLOCKLIST,
      }),
    ),
  );

  const seen = new Set<string>();
  const merged: LinkCandidate[] = [];
  results.forEach((res, i) => {
    if (res.status !== "fulfilled") return;
    const ranked = rankByVendor(
      res.value.sources
        .map((s) => toCandidate(s, DOWNLOAD_BLOCKLIST))
        .filter((c): c is LinkCandidate => c !== null),
      tools[i]!.name,
    );
    merged.push(...dedupe(ranked, seen, PER_TOOL_CANDIDATES));
  });
  return merged.slice(0, MAX_CANDIDATES);
}

function buildSystemPrompt(ctx: LessonContext): string {
  return `${lectureLanguageLine(ctx)}

You choose the download links for one setup lesson of Saidrix AI Tutor. A web search has already found the candidates. You do NOT search and you do NOT write links: you answer with the NUMBER of a candidate, and the system fills in its address. Any URL you type is discarded.

The candidates are already ordered with the vendor's own site first. Choose accordingly:
- ALWAYS prefer the official site of the tool itself. A mirror, a blog post with a link in it, or a "download here" aggregator is never the right answer, however convenient it looks.
- One pick per tool being installed. Two links to the same tool confuses the student about which file to run.
- Skip anything that is not a place to GET the software: a review, a comparison article, a changelog, a forum thread.
- Fewer is better. One correct official link beats three hedged ones.
- If none of the candidates is the official source for a tool, leave that tool out rather than picking the closest thing.

"label" is what the student is clicking, in their language and naming the tool.
"note" is one short line: which file to choose on that page, or what they will see when they get there. Never restate the label.
"intro" is one short sentence introducing the section. The voice tutor SPEAKS it aloud, so no URLs and no domain names.`;
}

function buildUserMessage(ctx: LessonContext, bp: SetupBlueprint, candidates: LinkCandidate[]): string {
  return [
    `Setup lesson: "${ctx.topicTitle}" (course: ${ctx.courseTitle}, ${ctx.level})`,
    `Goal: ${bp.goal}`,
    ctx.os ? `The student is on: ${OS_QUERY_WORD[ctx.os] ?? ctx.os}` : "The student's operating system is unknown.",
    "",
    "Tools being installed in this lesson:",
    ...bp.tools.map((t) => `- ${t.name}: ${t.whatItIs}`),
    "",
    "DOWNLOAD candidates:",
    ...numberedList(candidates),
  ].join("\n");
}

interface DownloadPick {
  number: number;
  label: string;
  note: string;
  kind: "installer" | "page" | "docs";
}

/**
 * Reads one pick, ignoring every field the model was not supposed to send —
 * notably any `url` it invented anyway.
 */
export function readDownloadPick(raw: unknown): DownloadPick | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as { number?: unknown; label?: unknown; note?: unknown; kind?: unknown };
  const number = typeof o.number === "number" ? o.number : Number(o.number);
  if (!Number.isInteger(number)) return null;
  const text = (v: unknown, cap: number) =>
    typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, cap) : "";
  const label = text(o.label, 140);
  const note = text(o.note, 220);
  if (!label || !note) return null;
  const kind = o.kind === "installer" || o.kind === "page" || o.kind === "docs" ? o.kind : "page";
  return { number, label, note, kind };
}

export interface DownloadsInput {
  ctx: LessonContext;
  blueprint: SetupBlueprint;
  deps?: LlmDeps;
}

export async function buildDownloadsBlock(input: DownloadsInput): Promise<DownloadsResult | null> {
  const { ctx, blueprint } = input;
  // Same switch as the resources section: both need a live search key, and a
  // deployment without one should degrade rather than fail.
  if (!isResourcesEnabled()) return null;

  const lang = ctx.language ?? DEFAULT_LANGUAGE;

  try {
    const candidates = await gatherCandidates(blueprint, ctx.os);
    if (candidates.length === 0) {
      console.info(`[lecture-maker] no download candidates for "${ctx.topicTitle}"`);
      return null;
    }

    const live = await keepLive(candidates);
    if (live.length === 0) return null;

    const picked = await runForcedToolCall({
      deps: input.deps ?? resolveLectureDeps("resources"),
      tool: emitDownloadPicksTool,
      system: buildSystemPrompt(ctx),
      user: buildUserMessage(ctx, blueprint, live),
      parse: (raw) => {
        const o = (raw ?? {}) as { intro?: unknown; picks?: unknown };

        // Out-of-range and repeated numbers are dropped rather than rejected: a
        // repair round costs a call to recover a link we were happy to ship one
        // of anyway.
        const used = new Set<number>();
        const picks = (Array.isArray(o.picks) ? o.picks : [])
          .map(readDownloadPick)
          .filter((p): p is DownloadPick => p !== null)
          .filter((p) => p.number >= 1 && p.number <= live.length)
          .filter((p) => (used.has(p.number) ? false : (used.add(p.number), true)))
          .slice(0, 4);

        if (picks.length === 0) {
          return {
            success: false,
            issues:
              "no usable picks — every number was outside the candidate list. Answer with the [n] shown " +
              "beside a candidate.",
          };
        }

        const intro =
          typeof o.intro === "string" && o.intro.trim() ? o.intro.replace(/\s+/g, " ").trim().slice(0, 400) : "";
        return { success: true, data: { intro, picks } };
      },
      sizeHint: "Emit at most three picks, one short line each.",
      maxTokens: 700,
    });

    const links: DownloadsBlock["links"] = picked.picks.map((p) => {
      // The candidate's url and domain — never anything the model wrote.
      const c = live[p.number - 1]!;
      return { kind: p.kind, label: p.label, url: c.url, domain: c.domain, note: p.note };
    });

    const candidate = {
      type: "downloads" as const,
      intro: picked.intro || FALLBACK_INTRO[lang],
      os: (ctx.os ?? "any") as DownloadsBlock["os"],
      links,
    };

    // Belt and braces. assembledLectureSchema would catch a bad block too, but
    // there it is a 502 that loses the whole lecture; here it is a skip.
    const parsed = downloadsBlockSchema.safeParse(candidate);
    if (!parsed.success) {
      console.warn(`[lecture-maker] downloads block failed its own schema: ${formatZodIssues(parsed.error)}`);
      return null;
    }

    console.info(`[lecture-maker] downloads: ${links.length} link(s) for "${ctx.topicTitle}"`);
    return { block: parsed.data };
  } catch (err) {
    console.warn(
      `[lecture-maker] downloads skipped for "${ctx.topicTitle}":`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}
