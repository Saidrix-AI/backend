import { z } from "zod";
import { LEVELS } from "../../validation/course.schema.js";
import { latestIntake } from "../../services/intake.service.js";
import {
  createLearningPath,
  getLearningPath,
  latestLearningPath,
} from "../../services/learningPath.service.js";
import { coursesOf, resolveRef, type CurriculumMatch } from "../../rag/curriculum.js";
import type { PathCourse } from "../../services/learningPath.service.js";
import { makeCourse } from "../course-maker/index.js";
import { buildCourseRequest, makePathCourse } from "../course-maker/request.js";
import { createPathCoursesTool, generateCourseTool, proposeCoursesTool } from "./prompts/course-maker.js";
import { failure, invalidArgs, type RegisteredTool, type ToolOutcome } from "./types.js";

const generateArgs = z.object({
  objective: z.string().min(1).max(500),
  level: z.enum(LEVELS).optional(),
  titleHint: z.string().min(1).max(120).optional(),
  seriesContext: z.string().max(500).optional(),
  // Multi-course path linkage: pathId returned by propose_courses + this
  // course's 1-based position in that path. Both must be present to take effect.
  pathId: z.string().min(1).optional(),
  order: z.coerce.number().int().min(1).optional(),
  priorKnowledge: z.string().max(500).optional(),
  withProjects: z.boolean().default(true),
});

/** The model-facing summary of a freshly generated course. */
function createdText(made: Awaited<ReturnType<typeof makeCourse>>): string {
  const { course, projects, projectErrors } = made;
  let text =
    `Created full course "${course.title}" (id: ${String(course._id)}, level: ${course.level}, ` +
    `~${course.estimatedHours} hours): ${course.chapters.length} chapters, ${course.lessons} lessons, ` +
    `${course.quizzes.length} quizzes.` +
    (projects.length ? ` Linked projects: ${projects.map((p) => `"${p.title}"`).join(", ")}.` : "") +
    " Note: this is the curriculum roadmap only — lecture pages for the lessons are generated later.";
  if (projectErrors.length) text += ` Some projects could not be created: ${projectErrors.join(", ")}.`;
  return text;
}

function projectPart(made: Awaited<ReturnType<typeof makeCourse>>): string {
  const n = made.projects.length;
  return n ? `, ${n} project${n > 1 ? "s" : ""}` : "";
}

const generateCourse: RegisteredTool = {
  schema: generateCourseTool,
  runningLabel: (a) =>
    a.titleHint
      ? `Building course "${String(a.titleHint)}"`
      : `Building a course: ${String(a.objective ?? "…").slice(0, 60)}`,
  run: async (ctx, args) => {
    const parsed = generateArgs.safeParse(args);
    if (!parsed.success) return invalidArgs("Couldn't generate course", parsed.error);
    try {
      const { brief, pathMeta } = await buildCourseRequest(ctx.userId, parsed.data);
      const made = await makeCourse(ctx.userId, brief, pathMeta);
      return {
        ok: true,
        changed: "course",
        label: `Course "${made.course.title}" created (${made.course.lessons} lessons${projectPart(made)})`,
        modelText: createdText(made),
      };
    } catch (err) {
      return failure("Couldn't generate course", err);
    }
  },
};

// ---------------------------------------------------------------- the path

/**
 * How many courses a path has is decided by the SERVER, not the chat model.
 *
 * When the intake matched one of Saidrix's curriculum templates, the courses
 * are that template's: a language's foundation is one course, a career
 * roadmap is exactly its steps, in its order, with its titles. The model's own
 * list is ignored; it only supplies the goal line and the step labels.
 *
 * With no template, a request is one course unless it is a career goal
 * ("career" breadth), which must cover the whole syllabus. The old middle
 * size ("subject", 2-3 courses) produced the filler courses students saw, so
 * it now means one course too.
 */
export const BREADTHS = ["topic", "subject", "career"] as const;
export type Breadth = (typeof BREADTHS)[number];

export const CAREER_RANGE: [number, number] = [4, 10];

export const MAX_PATH_COURSES = 16;

const proposeArgs = z.object({
  goal: z.string().min(1).max(200),
  summary: z.string().min(1).max(200).optional(),
  breadth: z.enum(BREADTHS),
  courses: z
    .array(
      z.object({
        title: z.string().min(1).max(120),
        objective: z.string().min(1).max(500),
        level: z.enum(LEVELS).optional(),
        covers: z.string().min(1).max(400).optional(),
        theme: z.string().min(1).max(40).optional(),
        note: z.string().min(1).max(200).optional(),
      }),
    )
    .min(1)
    .max(MAX_PATH_COURSES),
});
type ProposedCourse = z.infer<typeof proposeArgs>["courses"][number];

/** A path whose size does not fit its breadth — the model fixes it and retries. */
function breadthMismatch(breadth: Breadth, count: number, scope: "single" | "multi" | null): ToolOutcome | null {
  const retry = (why: string): ToolOutcome => ({
    ok: false,
    label: "Couldn't propose courses",
    modelText: `Invalid path: ${why} Fix the courses list and call propose_courses again.`,
  });
  if (scope === "single" && breadth === "career") {
    return retry('the student asked about ONE topic, so breadth cannot be "career". Use "topic" with exactly ONE course.');
  }
  if (breadth !== "career") {
    return count === 1
      ? null
      : retry(`${count} course(s) given, but anything short of a career goal is exactly ONE course — merge them into one course that covers the topic.`);
  }
  const [min, max] = CAREER_RANGE;
  if (count < min || count > max) {
    return retry(
      `${count} course(s) given, but breadth "career" is 4-10 courses covering the whole syllabus for that role — add the missing subjects, or if it is one topic use "topic" with one course.`,
    );
  }
  return null;
}

/** The template's courses as path steps; the model's step labels are kept by position. */
function templateCourses(match: CurriculumMatch, modelCourses: ProposedCourse[]) {
  const steps = coursesOf(match);
  return steps.map(({ course, index }, i) => {
    const modules = course.modules.map((m) => m.title).join(", ");
    const theme = steps.length === modelCourses.length ? modelCourses[i]?.theme : undefined;
    return {
      title: course.title,
      objective: [course.summary || course.title, course.status ? `(${course.status})` : ""].filter(Boolean).join(" "),
      covers: modules.slice(0, 400),
      theme: theme ?? "",
      template: { sourcePath: match.template.sourcePath, courseIndex: index },
    };
  });
}

const proposeCourses: RegisteredTool = {
  schema: proposeCoursesTool,
  runningLabel: () => "Preparing course suggestions",
  run: async (ctx, args) => {
    const parsed = proposeArgs.safeParse(args);
    if (!parsed.success) return invalidArgs("Couldn't propose courses", parsed.error);
    try {
      const intake = await latestIntake(ctx.userId).catch(() => null);
      const match = await resolveRef(intake?.curriculum);

      let courses: (PathCourse & { note?: string })[];
      if (match) {
        courses = templateCourses(match, parsed.data.courses);
        console.info(
          `[propose_courses] from template ${match.template.sourcePath}: ${courses.length} course(s) (model sent ${parsed.data.courses.length})`,
        );
      } else {
        const mismatch = breadthMismatch(parsed.data.breadth, parsed.data.courses.length, intake?.scope ?? null);
        if (mismatch) return mismatch;
        courses = parsed.data.courses.map((c) => ({
          title: c.title,
          objective: c.objective,
          ...(c.level ? { level: c.level } : {}),
          covers: c.covers ?? c.note ?? "",
          theme: c.theme ?? "",
          ...(c.note ? { note: c.note } : {}),
        }));
      }

      // Persist the ordered plan so each course generation can pull this step's
      // scope and its siblings' boundaries from one authoritative source.
      const path = await createLearningPath(
        ctx.userId,
        parsed.data.goal,
        courses.map(({ note: _note, ...c }) => c),
        parsed.data.summary ?? "",
      );
      const pathId = String(path._id);
      const titles = courses.map((c, i) => `${i + 1}. "${c.title}"`).join(", ");
      return {
        ok: true,
        label: `Proposed ${courses.length} course${courses.length === 1 ? "" : "s"}`,
        modelText:
          `Learning path saved (pathId=${pathId}, ${courses.length} courses in order): ${titles}. ` +
          (match ? "These courses come from the Saidrix curriculum, not from your list; describe these. " : "") +
          "Nothing was created yet. End your turn with one short line asking them to pick. " +
          `When they reply with their selection, call create_path_courses ONCE with pathId="${pathId}" and the ` +
          "1-based numbers of every course they chose (the numbers in the list above).",
        proposal: courses.map(({ template: _t, ...c }) => c),
      };
    } catch (err) {
      return failure("Couldn't propose courses", err);
    }
  },
};

// ------------------------------------------------------ creating the path

const createPathArgs = z.object({
  // Optional: the pathId lives in a tool message, which is not replayed into
  // later turns, so by the time the student picks the model may not have it.
  // Without it, the student's most recent proposal is the one they answered.
  pathId: z.string().min(1).optional(),
  orders: z.array(z.coerce.number().int().min(1).max(MAX_PATH_COURSES)).min(1).max(MAX_PATH_COURSES),
});

/**
 * Generates every chosen course of a proposed path, in learning order, in one
 * call. It replaces "generate_course once per course, at most 3 per turn" —
 * which left a student who picked five courses of an eight-course path having
 * to come back and ask twice more. Quota and idempotency live in
 * makePathCourse; a course that fails does not stop the ones after it.
 */
const createPathCourses: RegisteredTool = {
  schema: createPathCoursesTool,
  runningLabel: (a) => {
    const n = Array.isArray(a.orders) ? a.orders.length : 0;
    return n > 1 ? `Building ${n} courses` : "Building your course";
  },
  run: async (ctx, args) => {
    const parsed = createPathArgs.safeParse(args);
    if (!parsed.success) return invalidArgs("Couldn't create courses", parsed.error);
    const path = await (parsed.data.pathId
      ? getLearningPath(ctx.userId, parsed.data.pathId)
      : latestLearningPath(ctx.userId)
    ).catch(() => null);
    if (!path) {
      return {
        ok: false,
        label: "Couldn't create courses",
        modelText: "No learning path found. Call propose_courses first so the student can pick.",
      };
    }
    const pathId = String(path._id);
    const orders = [...new Set(parsed.data.orders)]
      .filter((o) => o <= path.courses.length)
      .sort((a, b) => a - b);

    const done: string[] = [];
    const failed: string[] = [];
    let lessons = 0;
    for (const order of orders) {
      const title = path.courses[order - 1]!.title;
      try {
        const result = await makePathCourse(ctx.userId, pathId, order);
        if (result.status === "exists") {
          done.push(`"${result.title}" (already existed)`);
        } else {
          lessons += result.made.course.lessons;
          done.push(createdText(result.made));
        }
      } catch (err) {
        // Out of quota stops the rest — every later one would fail the same way.
        const message = err instanceof Error ? err.message : "failed";
        failed.push(`"${title}": ${message}`);
        if (/limit|quota|allowance/i.test(message)) break;
      }
    }

    const skipped = orders.length - done.length - failed.length;
    const ok = done.length > 0;
    return {
      ok,
      ...(ok ? { changed: "course" as const } : {}),
      label: ok
        ? `${done.length} course${done.length === 1 ? "" : "s"} created${lessons ? ` (${lessons} lessons)` : ""}`
        : "Couldn't create courses",
      modelText: [
        done.length ? `Done: ${done.join(" | ")}` : "",
        failed.length ? `Failed: ${failed.join(" | ")}` : "",
        skipped > 0 ? `${skipped} not attempted after the monthly course limit was reached.` : "",
        "Courses that were not created stay on the student's path on the Courses page, where they can create them later.",
      ]
        .filter(Boolean)
        .join("\n"),
    };
  },
};

export const courseMakerTools = [generateCourse, proposeCourses, createPathCourses];
