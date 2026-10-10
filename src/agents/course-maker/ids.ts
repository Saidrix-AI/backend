import type { CourseInput } from "../../services/course.service.js";
import { refineIcon } from "../../services/iconInference.js";
import type { ExpandedChapter, GeneratedCourse } from "./schema.js";

/** Lowercase-kebab slug; non-Latin titles (e.g. Bangla) can slug to "" → "course". */
export function slugify(s: string): string {
  const slug = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "course";
}

const RAND_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";

function rand4(): string {
  let out = "";
  for (let i = 0; i < 4; i++) out += RAND_CHARS[Math.floor(Math.random() * RAND_CHARS.length)];
  return out;
}

/**
 * One namespace per course. The rand4 makes lessonIds globally unique-ish —
 * required because Lecture.lessonId has a global unique index and the future
 * Lecture-maker will key lecture documents by these ids.
 */
export function courseIdSuffix(title: string): string {
  return `${slugify(title).slice(0, 40).replace(/-+$/, "")}-${rand4()}`;
}

/**
 * Outline + written chapters → the exact POST /api/courses contract shape.
 * Assigns lessonIds/quizIds (the LLM never emits ids); omits `lessons`
 * entirely — the course service derives it from the chapters.
 *
 * `written` is the expand pass output, positionally aligned with the outline's
 * chapters. A null entry (its writer failed twice) keeps the chapter with its
 * outline brief as the summary and no lessons, rather than losing the course.
 */
export function toCourseInput(
  gen: GeneratedCourse,
  suffix: string,
  written: (ExpandedChapter | null)[] = [],
): CourseInput {
  return {
    title: gen.title,
    desc: gen.desc,
    whyTake: gen.whyTake,
    outcomes: gen.outcomes,
    level: gen.level,
    estimatedHours: gen.estimatedHours,
    // Safety net: the model reaches for a vague generic ("book" on a course
    // titled "React Fundamentals") far more often than it picks the wrong brand,
    // so infer when it did NOT choose a brand. A deliberate brand pick is always
    // kept — see refineIcon.
    //
    // Title ONLY, deliberately: descriptions mention adjacent technologies and
    // drag the match off-subject — an "Autonomous Agent Engineering" course whose
    // description says "AI" infers `brain`, losing the better `robot`.
    icon: refineIcon(gen.icon, gen.title),
    thumb: gen.thumb,
    chapters: gen.chapters.map((ch, i) => {
      const chapter = written[i] ?? null;
      if (!chapter) return { title: ch.title, summary: ch.brief, modules: [] };
      return {
        title: ch.title,
        summary: chapter.summary,
        outcomes: chapter.outcomes,
        estimatedHours: chapter.estimatedHours,
        difficulty: chapter.difficulty,
        modules: chapter.modules.map((m, j) => ({
          title: m.title,
          summary: m.summary,
          topics: m.topics.map((t, k) => ({
            title: t.title,
            summary: t.summary,
            brief: t.brief,
            durationMin: t.durationMin,
            lessonId: `${suffix}-c${i + 1}m${j + 1}t${k + 1}`,
          })),
        })),
      };
    }),
    quizzes: gen.quizzes.map((q, n) => ({ quizId: `${suffix}-quiz${n + 1}`, title: q.title })),
  };
}

/** Case-insensitive title dedupe: append " II", " III"… while clashing (120-char cap). */
export function dedupeTitle(title: string, existing: string[]): string {
  const taken = new Set(existing.map((t) => t.trim().toLowerCase()));
  if (!taken.has(title.trim().toLowerCase())) return title;
  for (let n = 2; n <= 10; n++) {
    const roman = "I".repeat(n);
    const candidate = `${title.slice(0, 120 - roman.length - 1).trimEnd()} ${roman}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return `${title.slice(0, 115).trimEnd()} ${rand4()}`;
}
