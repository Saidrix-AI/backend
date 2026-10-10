import { Types } from "mongoose";
import { CourseModel } from "../../database/models/course.model.js";
import { latestProfile } from "../../services/assessment.service.js";
import type { CoursePathMeta } from "../../services/course.service.js";
import { latestIntake } from "../../services/intake.service.js";
import { findPathEntryByObjective, getLearningPath } from "../../services/learningPath.service.js";
import { buildStudentContext } from "../../services/studentMemory.service.js";
import { ApiError } from "../../utils/apiError.js";
import type { Level } from "../../validation/course.schema.js";
import { makeCourse, type MadeCourse } from "./index.js";
import { buildPathBoundary } from "./prompt.js";
import type { CourseBrief } from "./schema.js";
import { coursesOf, formatCourse, resolveRef, type CurriculumRef } from "../../rag/curriculum.js";

/**
 * The template course a generation follows: the path step's own reference, or
 * the intake's match when it stands for exactly one course (a language's
 * foundation, or one named step of a roadmap). A whole roadmap is not one
 * course, so a standalone course from it gets no template.
 */
async function templateFor(ref: CurriculumRef | null | undefined): Promise<CourseBrief["template"] | undefined> {
  const match = await resolveRef(ref);
  if (!match) return undefined;
  const courses = coursesOf(match);
  if (courses.length !== 1) return undefined;
  const { course } = courses[0]!;
  return {
    sourcePath: match.template.sourcePath,
    block: `SAIDRIX CURRICULUM TEMPLATE — ${match.template.skill}\n${formatCourse(course)}`,
    modules: course.modules.map((m) => m.title),
  };
}

/**
 * Everything a course generation needs to know about the student, assembled in
 * ONE place — shared by the chat's generate_course / create_path_courses tools
 * and by the Courses page's "Create course" button, so a course made from
 * either door is written for the same student in the same way.
 */
export interface CourseRequestArgs {
  objective: string;
  level?: Level;
  titleHint?: string;
  seriesContext?: string;
  priorKnowledge?: string;
  /** Multi-course path linkage; both must be present to take effect. */
  pathId?: string;
  order?: number;
  withProjects: boolean;
}

export async function buildCourseRequest(
  userId: string,
  args: CourseRequestArgs,
): Promise<{ brief: CourseBrief; pathMeta?: CoursePathMeta }> {
  // A completed knowledge check outranks whatever the model typed into
  // priorKnowledge — it is measured rather than self-reported. The intake
  // supplies the content language the same way.
  //
  // 30 days, not the 120-minute default: that default exists for "the intake
  // just finished, generate the course now". Lecture exams keep folding results
  // into this profile (assessment.recordQuizOutcome), so here it is accumulated
  // evidence about the student rather than a stale guess.
  const [assessed, intake] = await Promise.all([
    latestProfile(userId, 30 * 24 * 60).catch(() => null),
    latestIntake(userId).catch(() => null),
  ]);

  // Who the student is, on top of what they know. The three overlapping keys
  // are dropped when a measured profile exists — profileLines is about to state
  // the assessed versions, and saying both invites the model to average two
  // different numbers of study hours.
  const learner = await buildStudentContext(userId, {
    include: ["identity", "narrative"],
    ...(assessed ? { omit: ["weeklyHours", "careerGoal", "preferredStyle"] } : {}),
  });

  // Path linkage: from the passed pathId+order, or by matching this course's
  // objective to a previously proposed path. The step's own objective/level
  // are authoritative, and its siblings become prerequisite/deferral boundaries
  // so path courses never repeat each other's ground.
  let pathBrief: { objective?: string; level?: Level; pathBoundary?: string } = {};
  let pathMeta: CoursePathMeta | undefined;
  let resolved: { path: NonNullable<Awaited<ReturnType<typeof getLearningPath>>>; order: number } | null = null;
  if (args.pathId && args.order) {
    const path = await getLearningPath(userId, args.pathId);
    if (path && path.courses[args.order - 1]) resolved = { path, order: args.order };
  }
  if (!resolved) {
    resolved = await findPathEntryByObjective(userId, args.objective, args.titleHint);
  }
  let templateRef: CurriculumRef | null = (!args.pathId && intake?.curriculum) || null;
  if (resolved) {
    const entry = resolved.path.courses[resolved.order - 1]!;
    templateRef = (entry as { template?: CurriculumRef | null }).template ?? null;
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

  // The setup lesson is owed once per path: when an earlier step's course
  // already exists, that course carried it and this one starts with the subject.
  const setUpEarlier = pathMeta
    ? Boolean(
        await CourseModel.exists({
          userId: new Types.ObjectId(userId),
          pathId: new Types.ObjectId(pathMeta.pathId),
          order: { $lt: pathMeta.order },
        }),
      )
    : false;

  const template = await templateFor(templateRef);

  const { pathId: _pathId, order: _order, ...rest } = args;
  const brief: CourseBrief = {
    ...rest,
    ...pathBrief,
    ...(assessed ? { profile: assessed.profile } : {}),
    ...(intake ? { language: intake.language } : {}),
    // The intake's brief: where to start, what not to re-teach, whether the
    // student owes a setup lesson, and how long they can sit down for.
    ...(intake?.report
      ? {
          ...(intake.report.startFrom ? { startFrom: intake.report.startFrom } : {}),
          ...(intake.report.skip?.length ? { skip: intake.report.skip } : {}),
          needsSetupLesson: Boolean(intake.report.needsSetupLesson) && !setUpEarlier,
        }
      : {}),
    ...(intake?.dailyMinutes ? { dailyMinutes: intake.dailyMinutes } : {}),
    ...(learner ? { learner } : {}),
    ...(template ? { template } : {}),
  };
  return { brief, pathMeta };
}

/** The course already generated for this step of this path, if any. */
export async function pathCourseAt(userId: string, pathId: string, order: number) {
  if (!Types.ObjectId.isValid(pathId)) return null;
  return CourseModel.findOne({
    userId: new Types.ObjectId(userId),
    pathId: new Types.ObjectId(pathId),
    order,
  })
    .select("title lessons")
    .lean();
}

export type PathCourseResult =
  | { status: "created"; made: MadeCourse }
  | { status: "exists"; courseId: string; title: string };

/**
 * Generates step `order` of a saved learning path — idempotently: a step that
 * already has its course returns that course instead of generating (and
 * charging for) a second one. Quota is enforced inside makeCourse.
 */
export async function makePathCourse(userId: string, pathId: string, order: number): Promise<PathCourseResult> {
  const path = await getLearningPath(userId, pathId);
  const entry = path?.courses[order - 1];
  if (!path || !entry) throw new ApiError(404, "That step of the learning path was not found.");

  const existing = await pathCourseAt(userId, pathId, order);
  if (existing) return { status: "exists", courseId: String(existing._id), title: existing.title };

  const { brief, pathMeta } = await buildCourseRequest(userId, {
    objective: entry.objective,
    ...(entry.level ? { level: entry.level } : {}),
    titleHint: entry.title,
    pathId,
    order,
    withProjects: true,
  });
  const made = await makeCourse(userId, brief, pathMeta);
  return { status: "created", made };
}
