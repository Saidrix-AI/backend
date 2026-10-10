import { randomBytes } from "node:crypto";
import { Types } from "mongoose";
import { CourseModel } from "../database/models/course.model.js";
import type { Language } from "../validation/language.js";
import { ApiError } from "../utils/apiError.js";

export interface TopicInput {
  title: string;
  lessonId: string;
  summary?: string;
  /** Course-maker's instruction to the lecture writer; never shown to the student. */
  brief?: string;
  durationMin?: number;
}
export interface ModuleInput {
  title: string;
  summary?: string;
  topics: TopicInput[];
}
export interface ChapterInput {
  title: string;
  summary?: string;
  outcomes?: string[];
  estimatedHours?: number;
  difficulty?: "Beginner" | "Intermediate" | "Advanced";
  modules: ModuleInput[];
}
export interface QuizInput {
  quizId: string;
  title: string;
}
export interface CourseInput {
  title: string;
  desc?: string;
  /** Why a student would take this — the "is this for me?" paragraph, not the card blurb. */
  whyTake?: string;
  /** What they can do at the end, one action per line. */
  outcomes?: string[];
  level?: "Beginner" | "Intermediate" | "Advanced";
  /** Content language chosen in the guided intake; lectures inherit it. */
  language?: Language;
  // Explicit lesson count — used only when no curriculum (chapters) is supplied,
  // e.g. the chat agent's simple create_course tool.
  lessons?: number;
  estimatedHours?: number;
  icon?: string;
  thumb?: string;
  chapters?: ChapterInput[];
  quizzes?: QuizInput[];
}

/** Total topic count across the curriculum. */
function countTopics(chapters: ChapterInput[] = []): number {
  return chapters.reduce(
    (sum, ch) => sum + ch.modules.reduce((s, m) => s + m.topics.length, 0),
    0,
  );
}

/** lessons = topic count when a curriculum is provided, else the explicit count. */
function resolveLessons(input: Partial<CourseInput>, fallback = 0): number {
  if (input.chapters && input.chapters.length) return countTopics(input.chapters);
  return input.lessons ?? fallback;
}

// ---------------------------------------------------------------------------
// Lesson ids are assigned here, never accepted from the caller.
//
// `lessonId` is the key of the global `LectureModel` collection, so it is not a
// label — it is a namespace. While clients could choose it, anyone could post a
// course claiming another student's lesson ids and thereby be treated as an
// owner of their lectures: enough to read a generated lecture, and enough to
// pre-empt one that had not been generated yet (the upsert is keyed on
// `lessonId` alone). Generating them server-side removes the possibility rather
// than policing it.
//
// Both writers land here — the HTTP route and the Course-maker agent — so there
// is one rule and no second path around it.
// ---------------------------------------------------------------------------

const ID_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";

function randomNamespace(len = 10): string {
  const bytes = randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += ID_CHARS[bytes[i]! % ID_CHARS.length];
  return out;
}

/**
 * Rewrites every lesson/quiz id in a curriculum into a fresh, server-owned
 * namespace. `keep` holds ids that already belong to this course, which are left
 * alone so an edit does not orphan the progress recorded against them.
 */
function assignCurriculumIds(
  chapters: ChapterInput[] | undefined,
  quizzes: QuizInput[] | undefined,
  keep: Set<string> = new Set(),
): { chapters?: ChapterInput[]; quizzes?: QuizInput[] } {
  const ns = randomNamespace();
  const out: { chapters?: ChapterInput[]; quizzes?: QuizInput[] } = {};

  if (chapters) {
    out.chapters = chapters.map((ch, i) => ({
      ...ch,
      modules: (ch.modules ?? []).map((m, j) => ({
        ...m,
        topics: (m.topics ?? []).map((t, k) => ({
          ...t,
          lessonId: keep.has(t.lessonId) ? t.lessonId : `${ns}-c${i + 1}m${j + 1}t${k + 1}`,
        })),
      })),
    }));
  }

  if (quizzes) {
    out.quizzes = quizzes.map((q, n) => ({
      ...q,
      quizId: keep.has(q.quizId) ? q.quizId : `${ns}-quiz${n + 1}`,
    }));
  }

  return out;
}

/** Every lesson and quiz id already stored on a course. */
function existingIds(course: {
  chapters?: ChapterInput[];
  quizzes?: QuizInput[];
}): Set<string> {
  const ids = new Set<string>();
  for (const ch of course.chapters ?? []) {
    for (const m of ch.modules ?? []) {
      for (const t of m.topics ?? []) ids.add(t.lessonId);
    }
  }
  for (const q of course.quizzes ?? []) ids.add(q.quizId);
  return ids;
}

/** Internal path linkage set by the Course-maker for multi-course paths (not part of the public create contract). */
export interface CoursePathMeta {
  pathId: string;
  pathTitle: string;
  order: number;
  pathTotal: number;
}

export async function createCourse(userId: string, input: CourseInput, meta?: CoursePathMeta) {
  const course = await CourseModel.create({
    userId: new Types.ObjectId(userId),
    ...input,
    // Ids the caller supplied are discarded; a new course always gets a fresh
    // server-owned namespace. See assignCurriculumIds.
    ...assignCurriculumIds(input.chapters, input.quizzes),
    lessons: resolveLessons(input),
    ...(meta
      ? {
          pathId: new Types.ObjectId(meta.pathId),
          pathTitle: meta.pathTitle,
          order: meta.order,
          pathTotal: meta.pathTotal,
        }
      : {}),
  });
  return course.toObject();
}

export async function listCourses(userId: string) {
  return CourseModel.find({ userId: new Types.ObjectId(userId) })
    .sort({ createdAt: -1 })
    .lean();
}

/**
 * Links the given courses into an ordered learning path: stamps pathId/pathTitle/
 * order (1-based, in the array order)/pathTotal on each course the user owns.
 * Returns how many were actually updated. Powers the organize_learning_path tool.
 */
export async function assignCoursesToPath(
  userId: string,
  pathId: string,
  pathTitle: string,
  orderedCourseIds: string[],
): Promise<number> {
  const uid = new Types.ObjectId(userId);
  const pid = new Types.ObjectId(pathId);
  const total = orderedCourseIds.length;
  let updated = 0;
  for (let i = 0; i < orderedCourseIds.length; i++) {
    const id = orderedCourseIds[i]!;
    if (!Types.ObjectId.isValid(id)) continue;
    const res = await CourseModel.updateOne(
      { _id: id, userId: uid },
      { $set: { pathId: pid, pathTitle, order: i + 1, pathTotal: total } },
    );
    if (res.matchedCount > 0) updated++;
  }
  return updated;
}

async function findOwned(userId: string, id: string) {
  if (!Types.ObjectId.isValid(id)) throw new ApiError(400, "Invalid course id");
  const course = await CourseModel.findOne({ _id: id, userId });
  if (!course) throw new ApiError(404, "Course not found");
  return course;
}

export async function getCourse(userId: string, id: string) {
  return (await findOwned(userId, id)).toObject();
}

export async function updateCourse(userId: string, id: string, patch: Partial<CourseInput>) {
  const course = await findOwned(userId, id);

  // Ids already on this course survive the edit — progress, lectures and quiz
  // attempts are all keyed by them. Anything else in the patch is a new topic
  // (or an attempt to claim someone else's id) and is renamed server-side.
  if (patch.chapters !== undefined || patch.quizzes !== undefined) {
    const keep = existingIds(course.toObject() as { chapters?: ChapterInput[]; quizzes?: QuizInput[] });
    Object.assign(patch, assignCurriculumIds(patch.chapters, patch.quizzes, keep));
  }

  Object.assign(course, patch);
  // Re-derive lessons when the curriculum changed; otherwise an explicit
  // `lessons` in the patch (agent tool path) is honored via Object.assign above.
  if (patch.chapters !== undefined) course.lessons = countTopics(patch.chapters);
  await course.save();
  return course.toObject();
}

export async function deleteCourse(userId: string, id: string) {
  await findOwned(userId, id);
  await CourseModel.deleteOne({ _id: id, userId });
}

/**
 * Deletes many courses in ONE operation, returning how many actually went.
 *
 * Mirrors routine.service.deleteRoutineItems, and exists for the same reason:
 * the single-id delete made "remove all my courses" cost one tool call per
 * course, which the chat agent's destructive-call cap refuses outright — so the
 * request could not be honoured at all.
 *
 * Leaves the same things behind that deleteCourse does (lectures, progress,
 * path entries). Cascading here and not there would make bulk and single
 * deletes mean different things, which is worse than either behaviour on its
 * own; if that cleanup is wanted it belongs in both.
 */
export async function deleteCourses(userId: string, ids: string[]): Promise<number> {
  const valid = ids.filter((id) => Types.ObjectId.isValid(id));
  if (valid.length === 0) return 0;
  const res = await CourseModel.deleteMany({ _id: { $in: valid }, userId });
  return res.deletedCount ?? 0;
}
