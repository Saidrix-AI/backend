import { Types } from "mongoose";
import type { Course } from "../database/models/course.model.js";
import { CourseModel } from "../database/models/course.model.js";
import { EnrollmentModel } from "../database/models/enrollment.model.js";
import { courseEnterVerdict } from "./activeSelection.service.js";

/**
 * Whether a project is open to the student yet, and what would open it.
 *
 * Projects are gated on the lessons that teach them rather than on a flat
 * percentage: the project planner already maps each project to the chapter whose
 * skills it exercises (`chapterIndex`), so the gate can say exactly which chapter
 * to finish. That is what ties the projects page back to the curriculum instead
 * of leaving ten projects open on day one.
 */
export interface ProjectLock {
  locked: boolean;
  /** Student-facing sentence, empty when unlocked. */
  lockReason: string;
  /** 1-based chapter that must be finished, or null for a whole-course gate. */
  requiresChapter: number | null;
}

const OPEN: ProjectLock = { locked: false, lockReason: "", requiresChapter: null };

type Chapters = NonNullable<Course["chapters"]>;

/** Every lessonId in one chapter. */
function chapterLessonIds(chapter: Chapters[number]): string[] {
  return (chapter.modules ?? []).flatMap((m) => (m.topics ?? []).map((t) => t.lessonId));
}

/** True when every lesson in the list is done (an empty chapter counts as done). */
function allDone(lessonIds: string[], done: Set<string>): boolean {
  return lessonIds.every((id) => done.has(id));
}

export interface GatedProject {
  courseId?: string;
  chapterIndex?: number;
  difficulty?: string;
}

/**
 * The gate for one project. Pure — the caller supplies the course and the
 * student's completed lessons.
 *
 * Deliberately fails OPEN for anything unmapped: manually created projects, and
 * projects from before the planner existed, carry no `chapterIndex` and would
 * otherwise become permanently unreachable.
 */
export function projectLock(
  project: GatedProject,
  course: Pick<Course, "chapters"> | null | undefined,
  completedLessonIds: string[],
): ProjectLock {
  const chapters = course?.chapters ?? [];
  if (!project.courseId || chapters.length === 0) return OPEN;

  const done = new Set(completedLessonIds);

  // A capstone is the "you can now build the whole thing" project, so it waits
  // for the whole curriculum rather than for the one chapter it was filed under.
  if (project.difficulty === "capstone") {
    const every = chapters.flatMap(chapterLessonIds);
    if (allDone(every, done)) return OPEN;
    return {
      locked: true,
      lockReason: "Finish the course to unlock this capstone project",
      requiresChapter: null,
    };
  }

  const idx = project.chapterIndex ?? -1;
  const chapter = idx >= 0 ? chapters[idx] : undefined;
  if (!chapter) return OPEN;

  if (allDone(chapterLessonIds(chapter), done)) return OPEN;
  return {
    locked: true,
    lockReason: `Finish Chapter ${idx + 1} · ${chapter.title} to unlock this project`,
    requiresChapter: idx + 1,
  };
}

/**
 * Locks for many projects at once — one course query and one enrollment query
 * for the whole list, rather than a pair per project.
 */
export async function projectLocks<T extends GatedProject>(
  userId: string,
  projects: T[],
): Promise<Map<T, ProjectLock>> {
  const uid = new Types.ObjectId(userId);
  const courseIds = [...new Set(projects.map((p) => p.courseId).filter((id): id is string => !!id))];

  const out = new Map<T, ProjectLock>();
  if (courseIds.length === 0) {
    for (const p of projects) out.set(p, OPEN);
    return out;
  }

  const valid = courseIds.filter((id) => Types.ObjectId.isValid(id));
  const [courses, enrollments] = await Promise.all([
    CourseModel.find({ _id: { $in: valid }, userId: uid }, { chapters: 1 }).lean(),
    EnrollmentModel.find({ userId: uid, courseId: { $in: courseIds } }, { courseId: 1, completedLessonIds: 1 }).lean(),
  ]);

  // A project belongs to a course, so it inherits that course's commitment
  // gate: deactivate a path and its projects shut with its lessons. Resolved
  // once per course rather than per project — a course commonly has several.
  const verdicts = new Map(
    await Promise.all(
      courseIds.map(async (id) => [id, await courseEnterVerdict(userId, id)] as const),
    ),
  );

  const courseById = new Map(courses.map((c) => [String(c._id), c]));
  const doneByCourse = new Map(enrollments.map((e) => [e.courseId, e.completedLessonIds ?? []]));

  for (const p of projects) {
    // The commitment gate runs first: "activate the path" is the actionable
    // answer, and telling them to finish a chapter they cannot open would not be.
    const verdict = p.courseId ? verdicts.get(p.courseId) : undefined;
    if (verdict && !verdict.enterable) {
      out.set(p, { locked: true, lockReason: verdict.reason, requiresChapter: null });
      continue;
    }
    const course = p.courseId ? courseById.get(p.courseId) : null;
    out.set(p, projectLock(p, course as Pick<Course, "chapters"> | null, doneByCourse.get(p.courseId ?? "") ?? []));
  }
  return out;
}

/** The lock for a single project (detail pages and the write-path guards). */
export async function lockForProject(userId: string, project: GatedProject): Promise<ProjectLock> {
  return (await projectLocks(userId, [project])).get(project) ?? OPEN;
}
