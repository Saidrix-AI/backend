import { z } from "zod";
import { LEVELS } from "../../validation/course.schema.js";
import { latestProfile } from "../../services/assessment.service.js";
import { latestIntake } from "../../services/intake.service.js";
import { buildStudentContext } from "../../services/studentMemory.service.js";
import {
  createLearningPath,
  getLearningPath,
  findPathEntryByObjective,
} from "../../services/learningPath.service.js";
import type { CoursePathMeta } from "../../services/course.service.js";
import { retrieveKnowledge, toSources } from "../../rag/retriever.js";
import { makeCourse } from "../course-maker/index.js";
import { buildPathBoundary } from "../course-maker/prompt.js";
import { generateCourseTool, proposeCoursesTool } from "./prompts/course-maker.js";
import { failure, invalidArgs, type RegisteredTool } from "./types.js";

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
      // A completed knowledge check outranks whatever the model typed into
      // priorKnowledge — it is measured rather than self-reported, and it means
      // the model never has to carry an assessment id around. The intake
      // supplies the content language the same way.
      //
      // 30 days, not the 120-minute default: that default exists for "the
      // intake just finished, generate the course now". Lecture exams keep
      // folding results into this profile (assessment.recordQuizOutcome), so
      // here it is accumulated evidence about the student rather than a stale
      // guess, and expiring it after two hours would throw that away.
      const [assessed, intake] = await Promise.all([
        latestProfile(ctx.userId, 30 * 24 * 60).catch(() => null),
        latestIntake(ctx.userId).catch(() => null),
      ]);

      // Who the student is, on top of what they know, plus what earlier sessions
      // were about — "they keep coming back to job interviews" changes which
      // examples a curriculum should be built around. The three overlapping keys
      // are dropped when a measured profile exists — profileLines is about to
      // state the assessed versions, and saying both invites the model to
      // average two different numbers of study hours.
      //
      // No `state` slice for the same reason: it would put logged study hours
      // beside the assessed weeklyHours. No `mastery` slice either — `assessed`
      // above already carries it into the prompt through profileLines.
      const learner = await buildStudentContext(ctx.userId, {
        include: ["identity", "narrative"],
        ...(assessed ? { omit: ["weeklyHours", "careerGoal", "preferredStyle"] } : {}),
      });

      // Multi-course path linkage. Resolve the plan either from the model-passed
      // pathId+order OR — so group creation "just works" without the model having
      // to carry pathId/order across turns — by matching this course's objective
      // to a previously proposed path. Then use this step's authoritative
      // objective/level and turn its siblings into prerequisite/deferral
      // boundaries so path courses never repeat each other's ground.
      let pathBrief: { objective?: string; level?: (typeof LEVELS)[number]; pathBoundary?: string } = {};
      let pathMeta: CoursePathMeta | undefined;

      let resolved: { path: NonNullable<Awaited<ReturnType<typeof getLearningPath>>>; order: number } | null = null;
      if (parsed.data.pathId && parsed.data.order) {
        const path = await getLearningPath(ctx.userId, parsed.data.pathId);
        if (path && path.courses[parsed.data.order - 1]) resolved = { path, order: parsed.data.order };
      }
      if (!resolved) {
        resolved = await findPathEntryByObjective(ctx.userId, parsed.data.objective, parsed.data.titleHint);
      }
      if (resolved) {
        const entry = resolved.path.courses[resolved.order - 1]!;
        pathBrief = {
          objective: entry.objective,
          ...(entry.level ? { level: entry.level } : {}),
          pathBoundary: buildPathBoundary(resolved.path.goal, resolved.path.courses, resolved.order),
        };
        pathMeta = {
          pathId: String(resolved.path._id),
          pathTitle: resolved.path.goal,
          order: resolved.order,
          pathTotal: resolved.path.courses.length,
        };
      }

      const { course, projects, projectErrors } = await makeCourse(
        ctx.userId,
        {
          ...parsed.data,
          ...pathBrief,
          ...(assessed ? { profile: assessed.profile } : {}),
          ...(intake ? { language: intake.language } : {}),
          ...(learner ? { learner } : {}),
        },
        pathMeta,
      );
      const projPart = projects.length
        ? `, ${projects.length} project${projects.length > 1 ? "s" : ""}`
        : "";
      let modelText =
        `Created full course "${course.title}" (id: ${String(course._id)}, level: ${course.level}, ` +
        `~${course.estimatedHours} hours): ${course.chapters.length} chapters, ${course.lessons} lessons, ` +
        `${course.quizzes.length} quizzes.` +
        (projects.length ? ` Linked projects: ${projects.map((p) => `"${p.title}"`).join(", ")}.` : "") +
        " Note: this is the curriculum roadmap only — lecture pages for the lessons are generated later.";
      if (projectErrors.length) {
        modelText += ` Some projects could not be created: ${projectErrors.join(", ")}.`;
      }

      // Surface which curriculum guides grounded this course, so the student can
      // see the knowledge base was used (chip + sources in the chat UI).
      const effObjective = pathBrief.objective ?? parsed.data.objective;
      const kb = await retrieveKnowledge(effObjective, { topK: 6 }).catch(() => []);
      const guides = [...new Set(kb.map((c) => c.skill))].filter(Boolean);
      if (guides.length) {
        modelText += ` Grounded in the Saidrix knowledge base (${guides.join(", ")}).`;
      }

      return {
        ok: true,
        changed: "course",
        label: `Course "${course.title}" created (${course.lessons} lessons${projPart})`,
        modelText,
        ...(kb.length ? { sources: toSources(kb) } : {}),
      };
    } catch (err) {
      return failure("Couldn't generate course", err);
    }
  },
};

const proposeArgs = z.object({
  goal: z.string().min(1).max(200),
  summary: z.string().min(1).max(200).optional(),
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
    // A single narrow topic is a one-step path — the roadmap UI and the path
    // linkage work the same either way, so one course is valid.
    .min(1)
    .max(5),
});

const proposeCourses: RegisteredTool = {
  schema: proposeCoursesTool,
  runningLabel: () => "Preparing course suggestions",
  run: async (ctx, args) => {
    const parsed = proposeArgs.safeParse(args);
    if (!parsed.success) return invalidArgs("Couldn't propose courses", parsed.error);
    try {
      // Persist the ordered plan so each generate_course call can pull this
      // step's scope and its siblings' boundaries from one authoritative source.
      const path = await createLearningPath(
        ctx.userId,
        parsed.data.goal,
        parsed.data.courses.map((c) => ({
          title: c.title,
          objective: c.objective,
          ...(c.level ? { level: c.level } : {}),
          covers: c.covers ?? c.note ?? "",
          theme: c.theme ?? "",
        })),
        parsed.data.summary ?? "",
      );
      const pathId = String(path._id);
      const titles = parsed.data.courses.map((c) => `"${c.title}"`).join(", ");
      return {
        ok: true,
        label: `Proposed ${parsed.data.courses.length} courses`,
        modelText:
          `Learning path saved (pathId=${pathId}, ${parsed.data.courses.length} courses in order): ${titles}. ` +
          "Nothing was created yet. End your turn with one short line asking them to pick. " +
          `When they reply with their selection, create each chosen course with generate_course, passing pathId="${pathId}" ` +
          "and order=<its 1-based position in the list above> — in learning order, at most 3 per turn.",
        proposal: parsed.data.courses,
      };
    } catch (err) {
      return failure("Couldn't propose courses", err);
    }
  },
};

export const courseMakerTools = [generateCourse, proposeCourses];
