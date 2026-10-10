import { Types } from "mongoose";
import { ApiError } from "../utils/apiError.js";
import { CourseModel } from "../database/models/course.model.js";
import { EnrollmentModel } from "../database/models/enrollment.model.js";
import { LearningPathModel } from "../database/models/learningPath.model.js";
import { ProjectModel } from "../database/models/project.model.js";
import { ProjectProgressModel } from "../database/models/projectProgress.model.js";
import { QuizAttemptModel } from "../database/models/quizAttempt.model.js";
import { AchievementModel } from "../database/models/achievement.model.js";
import { StudySessionModel } from "../database/models/studySession.model.js";
import { recentForCourse } from "./activity.service.js";
import { courseEnterVerdict, getActiveState } from "./activeSelection.service.js";
import { stripTopicBriefs } from "./course.projection.js";
import { projectLock } from "./projectGate.js";

const PASS_MARK = 60;

/** Consecutive-day streak ending at the most recent studied day. */
function streakFromDays(days: string[]): number {
  if (days.length === 0) return 0;
  const set = new Set(days);
  const sorted = days.slice().sort(); // ascending YYYY-MM-DD
  const last = sorted[sorted.length - 1]!;
  let streak = 0;
  const cursor = new Date(`${last}T00:00:00Z`);
  while (set.has(cursor.toISOString().slice(0, 10))) {
    streak += 1;
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return streak;
}

export async function getCourseDetail(userId: string, courseId: string) {
  if (!Types.ObjectId.isValid(courseId)) throw new ApiError(404, "Course not found");
  const uid = new Types.ObjectId(userId);
  const course = await CourseModel.findOne({ _id: courseId, userId: uid }).lean();
  if (!course) throw new ApiError(404, "Course not found");

  const [enrollment, courseProjects, quizAttempts, achievements, activity, studyAgg, studyDays, ppRows] =
    await Promise.all([
      EnrollmentModel.findOne({ userId: uid, courseId }).lean(),
      ProjectModel.find({ userId: uid, courseId }).lean(),
      QuizAttemptModel.find({ userId: uid, courseId }).lean(),
      AchievementModel.find({ userId: uid, courseId }).sort({ awardedAt: -1 }).lean(),
      recentForCourse(userId, courseId),
      StudySessionModel.aggregate<{ _id: null; total: number }>([
        { $match: { userId: uid, courseId } },
        { $group: { _id: null, total: { $sum: "$seconds" } } },
      ]),
      StudySessionModel.distinct("day", { userId: uid, courseId }),
      ProjectProgressModel.find({ userId: uid }).lean(),
    ]);

  // Path-lock: a course generated as step N of a learning path stays locked
  // until step N-1 is finished. Mirrors the progress formula the Courses page
  // uses to group/unlock roadmap steps, so both surfaces agree on "unlocked".
  let path: {
    pathId: string;
    title: string;
    order: number;
    total: number;
    unlocked: boolean;
    previousTitle: string | null;
  } | null = null;
  if (course.pathId && course.order) {
    if (course.order === 1) {
      path = {
        pathId: String(course.pathId),
        title: course.pathTitle ?? "Learning Path",
        order: course.order,
        total: course.pathTotal ?? 1,
        unlocked: true,
        previousTitle: null,
      };
    } else {
      const prevCourse = await CourseModel.findOne({
        userId: uid,
        pathId: course.pathId,
        order: course.order - 1,
      }).lean();
      let unlocked = true;
      if (prevCourse) {
        const prevEnrollment = await EnrollmentModel.findOne({
          userId: uid,
          courseId: String(prevCourse._id),
        }).lean();
        const doneCount = prevEnrollment?.completedLessonIds?.length ?? 0;
        const prevProgress = prevEnrollment
          ? Math.min(100, Math.round((doneCount / (prevCourse.lessons || 1)) * 100))
          : 0;
        unlocked = prevProgress >= 100;
      }
      path = {
        pathId: String(course.pathId),
        title: course.pathTitle ?? "Learning Path",
        order: course.order,
        total: course.pathTotal ?? course.order,
        unlocked,
        previousTitle: prevCourse?.title ?? null,
      };
    }
  }

  // The commitment's view of THIS course: is it the one to study now, is it
  // shut, and — the part the page acts on — what would open it. The verdict
  // comes from the same helper the server-side enter gate uses, so the button
  // the page offers and the answer the API gives can't disagree.
  const [state, verdict] = await Promise.all([
    getActiveState(userId),
    courseEnterVerdict(userId, courseId),
  ]);
  // Whether the Activate button on this page would actually work: only when the
  // plan still has a free slot of the right kind AND this course's own path is
  // not still cooling down from being switched off. Computed here rather than
  // in the browser so the button matches what the API would do.
  const ownLock = course.pathId
    ? ((await LearningPathModel.findById(course.pathId).select("lockedUntil").lean())?.lockedUntil ??
      null)
    : (course.lockedUntil ?? null);
  const ownLockRunning = Boolean(ownLock && ownLock.getTime() > Date.now());

  // Which commitment, if any, this course sits inside — a path course belongs
  // to its path's commitment, a standalone one to its own.
  const owning = course.pathId
    ? state.commitments.find((c) => c.pathId === String(course.pathId))
    : state.commitments.find((c) => c.courseId === courseId);
  const hasSlot = course.pathId ? state.canActivatePath : state.canActivateCourse;

  const active = {
    isCurrent: state.commitments.some((c) => c.currentCourseId === courseId),
    isInActivePath: Boolean(owning?.kind === "path"),
    blocked: !verdict.enterable,
    lockReason: verdict.reason,
    /** The path to activate to unblock this course, when that is the fix. */
    activatePathId: verdict.activatePathId,
    activatePathTitle: course.pathTitle ?? null,
    canActivate: !owning && hasSlot && !ownLockRunning,
    // These describe the commitment this course belongs to, not "the" one —
    // with several running, a global answer would be meaningless.
    canDeactivate: owning ? owning.canDeactivate : false,
    lockedUntil: owning?.lockedUntil ?? null,
  };

  const completedLessonIds: string[] = enrollment?.completedLessonIds ?? [];
  const doneSet = new Set(completedLessonIds);
  const lessonsTotal =
    course.lessons ||
    (course.chapters ?? []).reduce(
      (s, ch) => s + ch.modules.reduce((m, mod) => m + mod.topics.length, 0),
      0,
    );
  let lessonsDone = 0;
  for (const ch of course.chapters ?? [])
    for (const m of ch.modules)
      for (const t of m.topics) if (doneSet.has(t.lessonId)) lessonsDone += 1;
  const overallPct = lessonsTotal ? Math.round((lessonsDone / lessonsTotal) * 100) : 0;

  // Projects + user status, in the planner's build order (unplanned last).
  const ppMap = new Map(ppRows.map((p) => [p.projectId, p]));
  /** No row, or a row that only holds the deadline clock, both mean "not started". */
  const statusOf = (row?: { status?: string }) =>
    !row || row.status === "unlocked" ? "not_started" : row.status;
  /** Past its deadline and not handed in. A finished project is never overdue. */
  const isOverdue = (row?: { status?: string; dueAt?: Date | null }) =>
    Boolean(row?.dueAt && row.status !== "completed" && row.dueAt.getTime() < Date.now());
  const projects = courseProjects
    .slice()
    .sort((a, b) => (a.order || Number.MAX_SAFE_INTEGER) - (b.order || Number.MAX_SAFE_INTEGER))
    .map((p) => ({
      _id: String(p._id),
      title: p.title,
      desc: p.desc,
      icon: p.icon,
      thumb: p.thumb,
      tags: p.tags,
      chapterIndex: p.chapterIndex ?? -1,
      order: p.order ?? 0,
      difficulty: p.difficulty ?? "",
      estimatedHours: p.estimatedHours ?? 0,
      // "unlocked" means a row exists for the deadline clock and nothing else —
      // the project is open and untouched, which is what "not_started" has
      // always meant. Mapped back so nothing downstream has to learn a fourth
      // word for the same state.
      status: statusOf(ppMap.get(String(p._id))),
      // When the submission is due, and whether it already passed. Null when the
      // project has no deadline, which is every project planned before
      // `submitWithinDays` existed.
      dueAt: ppMap.get(String(p._id))?.dueAt ?? null,
      overdue: isOverdue(ppMap.get(String(p._id))),
      // The course and its completed lessons are already loaded here, so the
      // gate is the pure rule — no extra round trip per project.
      ...projectLock(
        {
          courseId: p.courseId,
          chapterIndex: p.chapterIndex,
          difficulty: p.difficulty,
          unlockLessonId: p.unlockLessonId,
        },
        course,
        completedLessonIds,
      ),
    }));
  const projectsDone = projects.filter((p) => p.status === "completed").length;

  // Assessments = the real exam that closes each lesson's lecture, one per
  // topic, keyed by lessonId (see lecture.controller.submitLectureQuiz).
  //
  // This used to list `course.quizzes` instead — a title-only "checkpoint per
  // chapter" the course-maker invents at creation time. Those have no
  // questions and no route to take them, so every row sat at "—" forever while
  // the exams students actually sat were nowhere to be seen.
  // `best` counts graded attempts only. Submitting returns the answer key so the
  // student can review their mistakes, which means a retake is sat knowing the
  // answers — scoring it would make every exam worth 100% on the second try.
  // Retakes still show in `attempts`. (`!== false` keeps pre-`graded` rows.)
  const best = new Map<string, number>();
  const attemptCount = new Map<string, number>();
  for (const a of quizAttempts) {
    if (a.graded !== false && (best.get(a.quizId) ?? -1) < a.score) best.set(a.quizId, a.score);
    attemptCount.set(a.quizId, (attemptCount.get(a.quizId) ?? 0) + 1);
  }

  const quizzes = (course.chapters ?? []).flatMap((chapter, chapterIndex) =>
    (chapter.modules ?? []).flatMap((module) =>
      (module.topics ?? []).map((topic) => {
        const bestScore = best.get(topic.lessonId) ?? null;
        return {
          quizId: topic.lessonId,
          title: topic.title,
          chapterTitle: chapter.title,
          chapterIndex,
          attempts: attemptCount.get(topic.lessonId) ?? 0,
          lessonDone: doneSet.has(topic.lessonId),
          bestScore,
          passed: bestScore != null && bestScore >= PASS_MARK,
        };
      }),
    ),
  );
  const assessmentsPassed = quizzes.filter((q) => q.passed).length;
  const assessmentsTaken = quizzes.filter((q) => q.attempts > 0).length;

  return {
    course: {
      _id: String(course._id),
      title: course.title,
      desc: course.desc,
      // Why take it, and what they can do at the end. Empty on courses
      // generated before these existed, so the page falls back to `desc`.
      whyTake: course.whyTake ?? "",
      outcomes: course.outcomes ?? [],
      level: course.level,
      icon: course.icon,
      thumb: course.thumb,
      estimatedHours: course.estimatedHours,
      lessons: lessonsTotal,
      chapters: stripTopicBriefs(course.chapters ?? []),
      quizzes: course.quizzes ?? [],
    },
    path,
    active,
    enrollment: enrollment
      ? { enrolledAt: enrollment.enrolledAt, lastAccessedAt: enrollment.lastAccessedAt }
      : null,
    progress: {
      overallPct,
      lessonsDone,
      lessonsTotal,
      chaptersTotal: (course.chapters ?? []).length,
      completedLessonIds,
    },
    projects,
    quizzes,
    stats: {
      projectsDone,
      projectsTotal: projects.length,
      assessmentsPassed,
      assessmentsTaken,
      assessmentsTotal: quizzes.length,
      studyTimeSeconds: studyAgg[0]?.total ?? 0,
      streakDays: streakFromDays(studyDays as string[]),
    },
    achievements: achievements.map((a) => ({
      key: a.key,
      name: a.name,
      desc: a.desc,
      awardedAt: (a.awardedAt ?? new Date()).toISOString(),
    })),
    activity: activity.map((a) => ({
      type: a.type,
      text: a.text,
      at: (a.at ?? new Date()).toISOString(),
    })),
  };
}
