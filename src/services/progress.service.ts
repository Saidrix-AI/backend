import { Types } from "mongoose";
import { AchievementModel } from "../database/models/achievement.model.js";
import { EnrollmentModel } from "../database/models/enrollment.model.js";
import { QuizAttemptModel } from "../database/models/quizAttempt.model.js";
import { RoutineItemModel } from "../database/models/routineItem.model.js";
import { StudySessionModel } from "../database/models/studySession.model.js";
import { ProjectProgressModel } from "../database/models/projectProgress.model.js";
import { CourseModel } from "../database/models/course.model.js";
import { ApiError } from "../utils/apiError.js";
import { logActivity } from "./activity.service.js";

function oid(userId: string): Types.ObjectId {
  return new Types.ObjectId(userId);
}

/**
 * The caller's own course, or 404.
 *
 * Progress is keyed by a client-supplied `courseId`, and the Enrollment row it
 * writes is upserted — so an unvalidated id does not fail, it silently creates
 * progress against a course the caller does not own. Every mutation below
 * resolves the course through here first.
 */
async function requireOwnedCourse(userId: string, courseId: string) {
  if (!Types.ObjectId.isValid(courseId)) throw new ApiError(404, "Course not found");
  const course = await CourseModel.findOne({ _id: courseId, userId: oid(userId) }).lean();
  if (!course) throw new ApiError(404, "Course not found");
  return course;
}

/** Every lessonId that actually exists in a course document. */
function lessonIdsOf(course: { chapters?: { modules?: { topics?: { lessonId: string }[] }[] }[] }): Set<string> {
  const ids = new Set<string>();
  for (const chapter of course.chapters ?? []) {
    for (const module of chapter.modules ?? []) {
      for (const topic of module.topics ?? []) ids.add(topic.lessonId);
    }
  }
  return ids;
}

function today(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

export interface ProgressCounts {
  coursesEnrolled: number;
  lessonsCompleted: number;
  quizzesTaken: number;
  quizAvg: number;
  quizzes90: number;
  studyDays: number;
  studyTimeSeconds: number;
  tasksCompleted: number;
  projectsCompleted: number;
}

export async function getProgressCounts(userId: string): Promise<ProgressCounts> {
  const uid = oid(userId);

  const [
    coursesEnrolled,
    lessonAgg,
    quizzes,
    quizzes90,
    studyDaysArr,
    studyAgg,
    tasksCompleted,
    projectsCompleted,
  ] = await Promise.all([
    EnrollmentModel.countDocuments({ userId: uid }),
    EnrollmentModel.aggregate([
      { $match: { userId: uid } },
      { $project: { n: { $size: "$completedLessonIds" } } },
      { $group: { _id: null, total: { $sum: "$n" } } },
    ]),
    // Practice retakes are sat with the answer key in hand, so they are excluded
    // from every statistic. (`$ne: false` keeps pre-`graded` rows counting.)
    QuizAttemptModel.find({ userId: uid, graded: { $ne: false } }, { score: 1 }).lean(),
    QuizAttemptModel.countDocuments({ userId: uid, graded: { $ne: false }, score: { $gte: 90 } }),
    StudySessionModel.distinct("day", { userId: uid }),
    StudySessionModel.aggregate([
      { $match: { userId: uid } },
      { $group: { _id: null, total: { $sum: "$seconds" } } },
    ]),
    RoutineItemModel.countDocuments({ userId: uid, type: "task", completed: true }),
    ProjectProgressModel.countDocuments({ userId: uid, status: "completed" }),
  ]);

  const quizzesTaken = quizzes.length;
  const quizAvg =
    quizzesTaken === 0
      ? 0
      : Math.round(quizzes.reduce((sum, q) => sum + (q.score ?? 0), 0) / quizzesTaken);

  return {
    coursesEnrolled,
    lessonsCompleted: lessonAgg[0]?.total ?? 0,
    quizzesTaken,
    quizAvg,
    quizzes90,
    studyDays: studyDaysArr.length,
    studyTimeSeconds: studyAgg[0]?.total ?? 0,
    tasksCompleted,
    projectsCompleted,
  };
}

// --- Achievement catalog + evaluator ---

interface AchievementRule {
  key: string;
  name: string;
  desc: string;
  tone: string;
  earned: (c: ProgressCounts) => boolean;
}

const RULES: AchievementRule[] = [
  { key: "first_course", name: "First Steps", desc: "Enrolled in your first course", tone: "green", earned: (c) => c.coursesEnrolled >= 1 },
  { key: "ai_explorer", name: "AI Explorer", desc: "Enrolled in 3 courses", tone: "green", earned: (c) => c.coursesEnrolled >= 3 },
  { key: "dedicated", name: "Dedicated Learner", desc: "Completed 10 lessons", tone: "purple", earned: (c) => c.lessonsCompleted >= 10 },
  { key: "quiz_master", name: "Quiz Master", desc: "Scored 90%+ in 5 quizzes", tone: "amber", earned: (c) => c.quizzes90 >= 5 },
  { key: "consistent_learner", name: "Consistent Learner", desc: "Studied on 7 different days", tone: "purple", earned: (c) => c.studyDays >= 7 },
  { key: "project_builder", name: "Project Builder", desc: "Completed your first project", tone: "amber", earned: (c) => c.projectsCompleted >= 1 },
];

/** Idempotently awards any newly-earned achievements based on current progress. */
export async function evaluateAchievements(userId: string): Promise<void> {
  const counts = await getProgressCounts(userId);
  const uid = oid(userId);
  const earned = RULES.filter((r) => r.earned(counts));
  await Promise.all(
    earned.map((r) =>
      AchievementModel.updateOne(
        { userId: uid, key: r.key, courseId: "" },
        { $setOnInsert: { name: r.name, desc: r.desc, tone: r.tone, awardedAt: new Date() } },
        { upsert: true },
      ).catch(() => {
        // unique-index race on concurrent evaluations — safe to ignore
      }),
    ),
  );
}

// --- Course-scoped achievements ---

interface CourseAchievementRule {
  key: string;
  name: string;
  desc: string;
  tone: string;
  earned: (pct: number, done: number) => boolean;
}

const COURSE_RULES: CourseAchievementRule[] = [
  { key: "first_module", name: "First Module", desc: "Completed your first lesson in this course", tone: "green", earned: (_pct, done) => done >= 1 },
  { key: "course_25", name: "25% Complete", desc: "Reached 25% of this course", tone: "purple", earned: (pct) => pct >= 25 },
  { key: "course_50", name: "Halfway There", desc: "Reached 50% of this course", tone: "purple", earned: (pct) => pct >= 50 },
  { key: "course_100", name: "Course Complete", desc: "Completed 100% of this course", tone: "amber", earned: (pct) => pct >= 100 },
];

/** Awards course-scoped achievements idempotently based on course completion. */
export async function evaluateCourseAchievements(
  userId: string,
  courseId: string,
): Promise<void> {
  const uid = oid(userId);
  const [course, enrollment] = await Promise.all([
    // Scoped to the caller: this used to be a bare findById, which read whatever
    // course the supplied id named — including another student's.
    CourseModel.findOne({ _id: courseId, userId: uid }).lean(),
    EnrollmentModel.findOne({ userId: uid, courseId }).lean(),
  ]);
  if (!course) return;
  const total =
    course.lessons ||
    (course.chapters ?? []).reduce(
      (s, ch) => s + ch.modules.reduce((m, mod) => m + mod.topics.length, 0),
      0,
    );
  const done = enrollment?.completedLessonIds?.length ?? 0;
  const pct = total ? Math.round((done / total) * 100) : 0;

  const earned = COURSE_RULES.filter((r) => r.earned(pct, done));
  await Promise.all(
    earned.map((r) =>
      AchievementModel.updateOne(
        { userId: uid, key: r.key, courseId },
        { $setOnInsert: { name: r.name, desc: r.desc, tone: r.tone, awardedAt: new Date() } },
        { upsert: true },
      )
        .then((res) => {
          if (res.upsertedCount) return logActivity(userId, "achievement", r.name, courseId);
        })
        .catch(() => {}),
    ),
  );
}

// --- Progress mutations ---

export async function enroll(userId: string, courseId: string): Promise<void> {
  await requireOwnedCourse(userId, courseId);
  await EnrollmentModel.updateOne(
    { userId: oid(userId), courseId },
    { $setOnInsert: { enrolledAt: new Date() }, $set: { lastAccessedAt: new Date() } },
    { upsert: true },
  );
  await evaluateAchievements(userId);
  await logActivity(userId, "enroll", "Enrolled in the course", courseId);
  await evaluateCourseAchievements(userId, courseId);
}

export async function listEnrollments(userId: string) {
  return EnrollmentModel.find({ userId: oid(userId) }).lean();
}

/**
 * Marks a lesson done.
 *
 * Both ids are validated before anything is written. They were not, and the
 * consequence was not a bad row: completion percentage is what opens the next
 * path step, ends the commitment cooldown and unlocks a chapter's projects
 * (activeSelection.service, projectGate), so posting invented lesson ids until
 * the count reached 100% opened every gate the paid tiers sell.
 */
export async function completeLesson(
  userId: string,
  courseId: string,
  lessonId: string,
): Promise<void> {
  const course = await requireOwnedCourse(userId, courseId);
  if (!lessonIdsOf(course).has(lessonId)) {
    throw new ApiError(404, "That lesson is not part of this course");
  }

  const res = await EnrollmentModel.updateOne(
    { userId: oid(userId), courseId },
    {
      $addToSet: { completedLessonIds: lessonId },
      $set: { lastAccessedAt: new Date() },
      $setOnInsert: { enrolledAt: new Date() },
    },
    { upsert: true },
  );
  await evaluateAchievements(userId);
  // Only log/award when this lesson id was actually new.
  if (res.modifiedCount || res.upsertedCount) {
    await logActivity(userId, "lesson", "Completed a lesson", courseId);
    await evaluateCourseAchievements(userId, courseId);
  }
}

/**
 * Records one exam attempt. The score is computed server-side by
 * `lecture.service.gradeLectureQuiz` — it is never accepted from the client.
 *
 * Only the first attempt at a given lesson is graded. Grading hands back the
 * answer key so the student can review what they missed, which means every
 * later attempt is sat with the answers already known; recording those as
 * practice is what stops "submit blind, read the key, resubmit" from being
 * worth 100%.
 */
export async function submitQuiz(
  userId: string,
  quizId: string,
  score: number,
  courseId?: string,
): Promise<{ graded: boolean }> {
  const uid = oid(userId);
  // `$ne: false` rather than `true`: rows written before this field existed have
  // no `graded` key at all, and a Mongoose default only applies on write. They
  // are real first attempts, so they must count as graded.
  const priorGraded = await QuizAttemptModel.exists({ userId: uid, quizId, graded: { $ne: false } });
  const graded = !priorGraded;

  await QuizAttemptModel.create({ userId: uid, quizId, courseId, score, graded });
  await evaluateAchievements(userId);
  await logActivity(userId, "quiz", graded ? "Attempted a quiz" : "Retook a quiz", courseId ?? "");
  return { graded };
}

export async function logStudyTime(
  userId: string,
  seconds: number,
  courseId = "",
): Promise<void> {
  if (seconds <= 0) return;
  await StudySessionModel.create({ userId: oid(userId), seconds, day: today(), courseId });
  await evaluateAchievements(userId);
}
