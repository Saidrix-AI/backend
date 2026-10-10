import * as courseService from "../../services/course.service.js";
import * as projectService from "../../services/project.service.js";
import { assertCanGenerateCourse, recordCourseGenerated } from "../../services/quota.service.js";
import { ApiError } from "../../utils/apiError.js";
import { createCourseSchema } from "../../validation/course.schema.js";
import { planProjects, type OrderedProject } from "../project-planner/index.js";
import { expandChapters, enforceLessonCap, countLessons, insertSetupLesson } from "./expand.js";
import { generateCoursePayload } from "./generator.js";
import { courseIdSuffix, dedupeTitle, toCourseInput } from "./ids.js";
import { profileLines } from "./prompt.js";
import type { CourseBrief } from "./schema.js";

export type { CourseBrief } from "./schema.js";

const MAX_EXISTING_TITLES_IN_PROMPT = 50;

/**
 * Compact "already covered elsewhere" summary of the student's other courses —
 * each course's title plus its chapter titles — so a new course never re-teaches
 * ground they already have. Fed to the outline as a prerequisite boundary.
 */
function summarizeCoverage(
  courses: { title: string; chapters?: { title?: string }[] }[],
): string {
  return courses
    .slice(0, MAX_EXISTING_TITLES_IN_PROMPT)
    .map((c) => {
      const chapters = (c.chapters ?? [])
        .map((ch) => ch.title)
        .filter((t): t is string => Boolean(t))
        .slice(0, 20);
      return chapters.length ? `- "${c.title}": ${chapters.join(", ")}` : `- "${c.title}"`;
    })
    .join("\n");
}

export interface MadeCourse {
  course: Awaited<ReturnType<typeof courseService.createCourse>>;
  projects: Awaited<ReturnType<typeof projectService.createProject>>[];
  /** Titles of generated projects that failed to persist (course still created). */
  projectErrors: string[];
}

/**
 * The Course-maker pipeline:
 *   1. one outline call — course metadata plus every chapter's title and brief.
 *      Cheap, so the chapter list is never trimmed to fit a token budget.
 *   2. in parallel: one writer per chapter (its modules and lessons) + one
 *      project-planner call. Both need only the outline, and because each
 *      chapter is its own call, total course size has no single-response
 *      ceiling — it scales with chapter count instead.
 *   3. assign ids, validate against the shared create contract, persist.
 *
 * Throws ApiError only before/at course creation — every project failure
 * degrades into `projectErrors` so a good course is never lost.
 */
/**
 * The lessonId the planner's "unlock after lesson N of chapter M" refers to.
 *
 * Returns "" — meaning "fall back to the chapter rule" — for every case where
 * the answer would be a guess: no chapter, no such lesson, or the planner
 * saying 0. That fallback is the gate the project would have had anyway, so a
 * bad number costs precision and never reachability.
 */
function resolveUnlockLesson(
  course: { chapters?: { modules?: { topics?: { lessonId: string }[] }[] }[] },
  chapterIndex: number,
  topicNumber: number,
): string {
  if (chapterIndex < 0 || topicNumber < 1) return "";
  const chapter = (course.chapters ?? [])[chapterIndex];
  if (!chapter) return "";
  const lessons = (chapter.modules ?? []).flatMap((m) => m.topics ?? []);
  return lessons[topicNumber - 1]?.lessonId ?? "";
}

export async function makeCourse(
  userId: string,
  brief: CourseBrief,
  pathMeta?: courseService.CoursePathMeta,
): Promise<MadeCourse> {
  // The monthly allowance, checked BEFORE anything is generated. A course costs
  // one outline call plus one per chapter plus a project plan, so refusing
  // after the fact would mean the student pays nothing and we pay for all of
  // it. Throws an ApiError the chat agent reports verbatim.
  await assertCanGenerateCourse(userId);

  const existing = await courseService.listCourses(userId);
  const existingTitles = existing.map((c) => c.title).slice(0, MAX_EXISTING_TITLES_IN_PROMPT);
  // Every existing course's coverage becomes a "do not re-teach" boundary for
  // the new outline — the universal cross-course dedup (path or standalone).
  const existingCoverage = existing.length ? summarizeCoverage(existing) : "";

  const gen = await generateCoursePayload({ ...brief, existingCoverage }, existingTitles);
  gen.title = dedupeTitle(gen.title, existingTitles);

  const projectErrors: string[] = [];
  const written = await expandChapters(gen, brief);
  // Before the project planner, so its "unlock after lesson N of chapter 1"
  // counts the setup lesson the student actually sees first.
  insertSetupLesson(gen, brief, written);

  // The project planner runs AFTER the chapters are written, not alongside them.
  //
  // It used to run in parallel, which saved one call's wall clock on a course
  // generation that already takes a minute or two. The cost was that it could
  // only see chapter titles — so every project was gated on a whole chapter,
  // and a student who could have started building after three lessons sat
  // through nine first. Seeing the lessons is what lets a project name the one
  // that opens it, and that is worth more than fifteen seconds on a one-time
  // operation the student is already watching a progress screen for.
  const planned = brief.withProjects
    ? await planProjects({
        title: gen.title,
        desc: gen.desc,
        level: gen.level,
        objective: brief.objective,
        chapters: gen.chapters.map((ch, i) => ({
          title: ch.title,
          covers: ch.brief,
          topics: (written[i]?.modules ?? []).flatMap((m) => m.topics.map((t) => t.title)),
        })),
        profile: profileLines(brief).join(" ") || undefined,
      }).catch((err: unknown) => {
        // eslint-disable-next-line no-console
        console.warn("[course-maker] project planning failed:", err);
        projectErrors.push("the project plan could not be generated");
        return [] as OrderedProject[];
      })
    : ([] as OrderedProject[]);

  // Hard guarantee the "< 60 lessons" cap even if a chapter writer overshot its
  // budget: trim least-critical trailing lessons from the largest chapters.
  const before = countLessons(written);
  enforceLessonCap(written);
  const after = countLessons(written);
  if (after < before) {
    // eslint-disable-next-line no-console
    console.warn(`[course-maker] trimmed ${before - after} lessons to stay under the 60-lesson cap (${after}).`);
  }

  const input = {
    ...toCourseInput(gen, courseIdSuffix(gen.title), written),
    // Stamped on the course so its lectures are later written in the same
    // language the student picked in the intake.
    ...(brief.language ? { language: brief.language } : {}),
  };
  // Belt-and-braces: agent-created courses provably satisfy the exact
  // POST /api/courses contract. Unreachable when toCourseInput is correct.
  const valid = createCourseSchema.safeParse(input);
  if (!valid.success) {
    throw new ApiError(500, "Generated course failed contract validation.");
  }

  const course = await courseService.createCourse(userId, input, pathMeta);

  // Metered here rather than by counting Course rows: deleting a course must
  // not win its quota back, and generating it is what costs money. Recorded
  // after the course exists so a generation that failed is not charged for.
  await recordCourseGenerated(userId, String(course._id));

  // Every planned project already carries a `goal`, so createProject skips its
  // per-project requirements LLM call — these are DB writes only and can all
  // run at once. The requirement checklist is authored lazily on first open
  // (project.service.getProjectWithRequirements).
  const results = await Promise.all(
    planned.map(async (p) => {
      try {
        return await projectService.createProject(userId, {
          title: p.title,
          desc: p.desc,
          goal: p.goal,
          tags: p.tags,
          icon: p.icon,
          thumb: gen.thumb,
          courseId: String(course._id),
          chapterIndex: p.chapterIndex,
          // Resolved against the SAVED course, because lessonIds are minted
          // server-side inside createCourse — nothing before this point knows
          // them, including the plan that asked for one.
          unlockLessonId: resolveUnlockLesson(course, p.chapterIndex, p.unlockAfterTopic),
          submitWithinDays: p.submitWithinDays,
          order: p.order,
          difficulty: p.difficulty,
          estimatedHours: p.estimatedHours,
        });
      } catch {
        projectErrors.push(p.title);
        return null;
      }
    }),
  );

  return {
    course,
    projects: results.filter((p): p is NonNullable<typeof p> => p !== null),
    projectErrors,
  };
}
