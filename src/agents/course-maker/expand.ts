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
    retrieveGrounding(`${chapter.title} ${gen.title}`, { topK: 4 }),
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
