import { formatZodIssues, resolveCourseDeps, runForcedToolCall, type LlmDeps } from "./call.js";
import { retrieveGrounding } from "../../rag/retriever.js";
import { retrieveFreshness } from "../shared/freshness.js";
import { buildExpandSystemPrompt, buildExpandUserMessage } from "./prompt.js";
import {
  emitChapterTool,
  expandedChapterSchema,
  type CourseBrief,
  type ExpandedChapter,
  type GeneratedCourse,
} from "./schema.js";

/**
 * How many chapter writers may be in flight at once. Each is an independent
 * call, so this — not any token budget — is what bounds how big a course can be.
 */
const CONCURRENCY = 4;

/** Writes one chapter in full from its outline brief, within its lesson budget. */
async function expandChapter(
  gen: GeneratedCourse,
  brief: CourseBrief,
  index: number,
  deps: LlmDeps,
  budget: number,
): Promise<ExpandedChapter> {
  const chapter = gen.chapters[index]!;
  // Per-chapter grounding by the chapter's own topic (best-effort, empty when
  // RAG / freshness are off). The web search is per chapter rather than once
  // per course because "what is current" differs by chapter — a routing chapter
  // and a testing chapter of the same course have different current answers.
  // Chapters that search near-identical topics share the freshness cache.
  const [grounding, freshness] = await Promise.all([
    retrieveGrounding(`${chapter.title} ${gen.title}`, {
      topK: 4,
      ...(brief.template ? { sourcePath: brief.template.sourcePath } : {}),
    }),
    retrieveFreshness(`${gen.title} ${chapter.title}`, {
      intent: "current version deprecated best practices",
      label: "course-maker",
    }),
  ]);
  // eslint-disable-next-line no-console
  console.info(
    `[course-maker] chapter "${chapter.title}" grounding: ${grounding ? "used KB" : "none"}, ` +
      `web: ${freshness ? "current info" : "none"}`,
  );
  return runForcedToolCall({
    deps,
    tool: emitChapterTool,
    system: buildExpandSystemPrompt(),
    user: buildExpandUserMessage(gen, brief, gen.chapters, index, grounding, budget, freshness),
    parse: (raw) => {
      const r = expandedChapterSchema.safeParse(raw);
      return r.success
        ? { success: true, data: r.data }
        : { success: false, issues: formatZodIssues(r.error) };
    },
    sizeHint:
      "Keep each summary to one short sentence, each lesson brief to two short sentences, and stay within the lesson budget.",
  });
}

/** Total lesson (topic) count across written chapters. */
export function countLessons(chapters: (ExpandedChapter | null)[]): number {
  return chapters.reduce(
    (n, ch) => n + (ch?.modules.reduce((m, mod) => m + mod.topics.length, 0) ?? 0),
    0,
  );
}

/**
 * Guarantees the course stays under the lesson cap by trimming the least-critical
 * trailing lessons from the largest chapters — keeping every module non-empty and
 * every chapter with at least one module. Mutates in place; used as a safety net
 * when a writer overshoots its budget.
 */
export function enforceLessonCap(chapters: (ExpandedChapter | null)[], cap = 59): void {
  let guard = 0;
  while (countLessons(chapters) > cap && guard++ < 5000) {
    let biggest: ExpandedChapter | null = null;
    let most = -1;
    for (const ch of chapters) {
      if (!ch) continue;
      const t = ch.modules.reduce((m, mod) => m + mod.topics.length, 0);
      if (t > most) {
        most = t;
        biggest = ch;
      }
    }
    if (!biggest) break;

    let trimmed = false;
    for (let mi = biggest.modules.length - 1; mi >= 0; mi--) {
      if (biggest.modules[mi]!.topics.length > 1) {
        biggest.modules[mi]!.topics.pop();
        trimmed = true;
        break;
      }
    }
    if (!trimmed) {
      if (biggest.modules.length > 1) biggest.modules.pop();
      else break; // one module with one lesson — cannot trim without emptying it
    }
  }
}

/**
 * Lesson titles that are installation/setup work. Used only as a safety net on
 * chapter 1, after the prompts have already said "no setup lessons" — the one
 * setup lesson the course owes the student is inserted separately.
 */
const SETUP_TITLE = /\b(install|installing|installation|setup|set up|virtual env\w*|venv)\b|ইনস্টল|সেটআপ|ভার্চুয়াল এনভায়রনমেন্ট/i;

const SETUP_TEXT: Record<string, { module: string; title: string; brief: string; summary: string }> = {
  en: {
    module: "Getting set up",
    title: "Install the tools and run your first program",
    brief:
      "One short beginner lesson: install the language/runtime and one code editor with default settings, then write and run a first tiny program to prove it works. Nothing else — no virtual environments, no terminal tutorial, no extra configuration.",
    summary: "Install what this course needs and run a first program.",
  },
  bn: {
    module: "শুরু করার প্রস্তুতি",
    title: "প্রয়োজনীয় tool install করে প্রথম program চালানো",
    brief:
      "একটি ছোট beginner lesson: language/runtime এবং একটি code editor default setting-এ install করা, তারপর একটি ছোট প্রথম program লিখে চালিয়ে দেখা যে সব কাজ করছে। এর বাইরে কিছু নয় — virtual environment, terminal tutorial বা বাড়তি configuration নয়।",
    summary: "এই course-এর জন্য দরকারি tool install করে প্রথম program চালানো।",
  },
};

/**
 * Puts the course's ONE setup lesson first in chapter 1, and strips any other
 * installation lesson a writer produced there anyway.
 *
 * Called before the project planner, so "unlock after lesson N of chapter 1"
 * already counts the setup lesson. Mutates `written`.
 */
export function insertSetupLesson(
  gen: GeneratedCourse,
  brief: Pick<CourseBrief, "needsSetupLesson" | "language">,
  written: (ExpandedChapter | null)[],
): void {
  if (!brief.needsSetupLesson || gen.chapters.length === 0) return;
  const text = SETUP_TEXT[String(brief.language ?? "en")] ?? SETUP_TEXT.en!;
  const setup = {
    title: gen.setupLesson?.title ?? text.title,
    summary: text.summary,
    brief: gen.setupLesson?.brief ?? text.brief,
    durationMin: 20,
  };

  const first = written[0];
  if (!first) {
    // The chapter's writer failed: the chapter still exists, and now it at
    // least holds the lesson the student cannot start without.
    written[0] = {
      summary: gen.chapters[0]!.brief.slice(0, 600),
      outcomes: [text.summary],
      estimatedHours: 1,
      difficulty: "Beginner",
      modules: [{ title: text.module, summary: text.summary, topics: [setup] }],
    };
    return;
  }
  for (const mod of first.modules) {
    mod.topics = mod.topics.filter((t) => !SETUP_TITLE.test(t.title));
  }
  first.modules = first.modules.filter((m) => m.topics.length > 0);
  first.modules.unshift({ title: text.module, summary: text.summary, topics: [setup] });
}

/**
 * Phase 2: one writer per chapter, a few at a time. A chapter whose writer
 * fails twice resolves to `null`; the caller keeps the chapter with no lessons
 * rather than losing the whole course, and logs it.
 */
export async function expandChapters(
  gen: GeneratedCourse,
  brief: CourseBrief,
  deps?: LlmDeps,
): Promise<(ExpandedChapter | null)[]> {
  const resolved = deps ?? resolveCourseDeps("expand");
  const chapters: (ExpandedChapter | null)[] = new Array(gen.chapters.length).fill(null);
  // Per-chapter lesson budget so the whole course stays under ~60 lessons
  // (final guarantee is enforceLessonCap in the assembler).
  const budget = Math.max(3, Math.floor(55 / Math.max(1, gen.chapters.length)));

  for (let start = 0; start < gen.chapters.length; start += CONCURRENCY) {
    const batch = gen.chapters.slice(start, start + CONCURRENCY).map(async (_, offset) => {
      const index = start + offset;
      try {
        chapters[index] = await expandChapter(gen, brief, index, resolved, budget);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
          `[course-maker] chapter not written ("${gen.chapters[index]?.title}"):`,
          err instanceof Error ? err.message : err,
        );
      }
    });
    await Promise.all(batch);
  }

  return chapters;
}
