import { EventEmitter } from "node:events";
import { Types } from "mongoose";
import { makeLecture, type LectureProgressEvent, type LessonContext } from "../agents/lecture-maker/index.js";
import { withTokenLedger } from "../agents/shared/tokenLedger.js";
import { LECTURE_VERSION } from "../agents/lecture-maker/sections.js";
import {
  findQuiz,
  toLectureJson,
  type LectureAudience,
  type LectureDocShape,
  type LectureJson,
} from "./lectureProjection.js";
import { buildStudentContext } from "./studentMemory.service.js";
import { getLearnerProfile } from "./learnerProfile.service.js";
import { CourseModel, type Course } from "../database/models/course.model.js";
import { EnrollmentModel } from "../database/models/enrollment.model.js";
import { LectureModel } from "../database/models/lecture.model.js";
import { LecturePositionModel } from "../database/models/lecturePosition.model.js";
import { ProjectModel } from "../database/models/project.model.js";
import { QuizAttemptModel } from "../database/models/quizAttempt.model.js";
import { ApiError } from "../utils/apiError.js";
import { logger } from "../utils/logger.js";
import { assertCourseEnterable } from "./activeSelection.service.js";
import { projectLock } from "./projectGate.js";

export type { LectureProgressEvent } from "../agents/lecture-maker/index.js";

/**
 * The seeded, ownerless demo lectures (scripts/seed-lectures.ts).
 *
 * These belong to no student and are what the Classroom falls back to when it
 * is opened with no lesson. They are the ONLY lesson ids allowed to resolve
 * without an owning course — everything else must be reachable from a course
 * the caller owns, or it is somebody else's.
 */
export const DEMO_LESSON_IDS: ReadonlySet<string> = new Set([
  "multi-agent-communication",
  "dom-in-react",
  "python-introduction",
]);

/**
 * Resolves the caller's owning course for a lesson, or refuses.
 *
 * This is the authorization gate for every lesson-scoped route. It exists
 * because the lesson id alone is not a capability: `LectureModel` is a global
 * collection keyed by `lessonId` with no owner column, so any query that starts
 * from a client-supplied lessonId and does not pass through here is reading
 * whatever student happens to own it.
 *
 * Returns null for the ownerless demo lectures, which every account may read.
 */
export async function requireOwnedLesson(
  userId: string,
  lessonId: string,
): Promise<{ _id: Types.ObjectId } | null> {
  const course = await CourseModel.findOne({
    userId: new Types.ObjectId(userId),
    "chapters.modules.topics.lessonId": lessonId,
  })
    .select("_id")
    .lean();
  if (course) return course as { _id: Types.ObjectId };

  if (DEMO_LESSON_IDS.has(lessonId)) return null;

  // Deliberately the same 404 an unknown lesson gets: distinguishing "exists but
  // is not yours" from "does not exist" would turn this into an oracle for
  // enumerating other students' lesson ids.
  throw new ApiError(404, "Lesson not found in your courses");
}

/**
 * Enforces the active-course rule for a lesson, and that it is the caller's.
 *
 * Must be called at every entry point rather than inside startJob(): both
 * generate paths return early for an already-generated lecture, so a gate
 * buried in the job would only ever fire on a cold cache.
 *
 * This used to `return` silently when no owning course was found, on the
 * reasoning that an unowned lesson had nothing to block on. That was the bug:
 * another student's lesson also finds no course owned by the caller, so the
 * gate opened for exactly the case it existed to stop.
 */
export async function assertLessonEnterable(userId: string, lessonId: string): Promise<void> {
  const course = await requireOwnedLesson(userId, lessonId);
  if (!course) return; // demo lecture — no course to gate on
  await assertCourseEnterable(userId, String(course._id));
}

export type { LectureAudience } from "./lectureProjection.js";
export type { LectureJson };


/**
 * Reads a lecture the caller is entitled to.
 *
 * `LectureModel` has no owner field, so the ownership question is answered
 * against the caller's courses before the document is touched at all.
 */
export async function getLectureByLessonId(
  userId: string,
  lessonId: string,
  audience: LectureAudience = "student",
): Promise<LectureJson> {
  await requireOwnedLesson(userId, lessonId);
  const doc = await LectureModel.findOne({ lessonId, version: LECTURE_VERSION }).lean();
  if (!doc) throw new ApiError(404, "Lecture not found");
  return toLectureJson(doc as LectureDocShape, audience);
}

export interface GradedQuestion {
  correct: boolean;
  correctIndex: number;
  explanation: string;
  concept: string;
}

export interface QuizResult {
  score: number;
  correctCount: number;
  total: number;
  questions: GradedQuestion[];
  /** Per-concept outcome, for the knowledge profile. Empty on untagged lectures. */
  concepts: { concept: string; correct: boolean }[];
}

/**
 * Grades a submitted attempt against the stored lecture — the only place the
 * answer key is read. `answers` holds the picked option index per question;
 * anything out of range simply counts as wrong rather than erroring, so a
 * partially-answered or malformed submission still yields a usable score.
 *
 * Ownership is checked first. Without it this route handed the full answer key
 * — `correctIndex` and `explanation` for every question — of ANY lesson id to
 * ANY signed-in account, which is both a cross-tenant leak and, since the key
 * comes back on a wrong submission, a way to score 100 on the retake.
 */
export async function gradeLectureQuiz(
  userId: string,
  lessonId: string,
  answers: number[],
): Promise<QuizResult> {
  await requireOwnedLesson(userId, lessonId);

  const doc = await LectureModel.findOne({ lessonId, version: LECTURE_VERSION }).lean();
  if (!doc) throw new ApiError(404, "Lecture not found");

  const questions = findQuiz(doc as unknown as LectureDocShape);
  if (!Array.isArray(questions) || questions.length === 0) {
    throw new ApiError(404, "This lecture has no quiz");
  }

  const graded = questions.map((q, i) => {
    const correct = answers[i] === q.correctIndex;
    return {
      correct,
      correctIndex: q.correctIndex,
      explanation: q.explanation ?? "",
      concept: q.concept ?? "",
    };
  });
  const correctCount = graded.filter((g) => g.correct).length;

  return {
    score: Math.round((correctCount / questions.length) * 100),
    correctCount,
    total: questions.length,
    questions: graded,
    concepts: graded
      .filter((g) => g.concept)
      .map((g) => ({ concept: g.concept, correct: g.correct })),
  };
}

function lessonContextFrom(
  course: Course,
  lessonId: string,
  learner = "",
  os?: LessonContext["os"],
): LessonContext {
  for (const chapter of course.chapters ?? []) {
    for (const module of chapter.modules ?? []) {
      for (const topic of module.topics ?? []) {
        if (topic.lessonId === lessonId) {
          return {
            lessonId,
            courseTitle: course.title,
            courseDesc: course.desc ?? "",
            level: course.level as LessonContext["level"],
            chapterTitle: chapter.title,
            moduleTitle: module.title,
            topicTitle: topic.title,
            // `||` not `??`: both fields default to "" in Mongo, so an empty
            // brief must fall through to the older one-line summary, and an
            // empty summary must fall through to undefined.
            topicBrief: topic.brief || topic.summary || undefined,
            siblingTopics: module.topics
              .filter((t) => t.lessonId !== lessonId)
              .map((t) => t.title),
            // Courses built before the intake existed have no language — the
            // lecture pipeline then falls back to English, as it always did.
            language: (course.language as LessonContext["language"]) ?? undefined,
            ...(learner ? { learner } : {}),
            // Only the setup lane reads this. Absent when they never answered
            // the intake's device question, which that lane handles by covering
            // every operating system rather than picking one.
            ...(os ? { os } : {}),
          };
        }
      }
    }
  }
  throw new ApiError(404, "Lesson not found in your courses");
}

/**
 * One generation run, shared by every caller currently waiting on this
 * lessonId. `history` lets a subscriber that joins mid-run catch up on the
 * stages it missed before switching to live events off `emitter`.
 */
interface GenerationJob {
  promise: Promise<LectureJson>;
  emitter: EventEmitter;
  history: LectureProgressEvent[];
}

/**
 * Same-process dedupe: concurrent generate calls for one lesson share a single
 * pipeline run. Cross-process races are absorbed by the unique lessonId index
 * (E11000 → read the winner).
 */
const jobs = new Map<string, GenerationJob>();

function startJob(userId: string, lessonId: string): GenerationJob {
  const emitter = new EventEmitter();
  // Unbounded on purpose: every open tab watching this lesson subscribes.
  emitter.setMaxListeners(0);
  const history: LectureProgressEvent[] = [];
  const onProgress = (event: LectureProgressEvent) => {
    history.push(event);
    emitter.emit("progress", event);
  };

  const promise = (async (): Promise<LectureJson> => {
    // The user-scoped lookup doubles as the authorization check.
    const course = await CourseModel.findOne({
      userId: new Types.ObjectId(userId),
      "chapters.modules.topics.lessonId": lessonId,
    }).lean();
    if (!course) throw new ApiError(404, "Lesson not found in your courses");

    // Who this lecture is being written for, and what they have been measured
    // on. The course already fixes the level and language; identity fixes the
    // register and the choice of examples, and mastery lets the writer move
    // faster over a concept they have proven and slow down on one they missed.
    //
    // No `state` or `narrative` slice on purpose: a lecture is about one lesson,
    // so study streaks and last week's chat topics are pure noise here.
    //
    // The OS is read as a VALUE as well as appearing in that prose block: the
    // setup lane branches on it (which install steps to write at all), and a
    // line inside a paragraph of background is not something a branch can read.
    const [learner, profile] = await Promise.all([
      buildStudentContext(userId, { include: ["identity", "mastery"] }),
      getLearnerProfile(userId),
    ]);
    const os = (profile?.operatingSystem || undefined) as LessonContext["os"];
    const ctx = lessonContextFrom(course as Course, lessonId, learner, os);
    const made = await withTokenLedger(`lecture ${lessonId}`, () => makeLecture(ctx, undefined, onProgress));
    const $set = {
      version: LECTURE_VERSION,
      language: made.language,
      kind: made.kind,
      title: made.title,
      course: { title: ctx.courseTitle, breadcrumb: [ctx.courseTitle, ctx.chapterTitle, ctx.moduleTitle] },
      outline: made.outline,
      sections: made.sections,
    };
    try {
      const doc = await LectureModel.findOneAndUpdate(
        { lessonId },
        { $set, $unset: { blocks: "", beats: "" } },
        { upsert: true, new: true },
      ).lean();
      return toLectureJson(doc as unknown as LectureDocShape);
    } catch (err: unknown) {
      if ((err as { code?: number }).code === 11000) {
        const doc = await LectureModel.findOne({ lessonId, version: LECTURE_VERSION }).lean();
        if (doc) return toLectureJson(doc as LectureDocShape);
      }
      throw err;
    }
  })().finally(() => jobs.delete(lessonId));

  // The only honest record of how a generation ended.
  //
  // `POST /:lessonId/generate/stream` flushes its SSE headers before any work
  // starts, so the access log reports 200 whether the lecture was written or the
  // pipeline threw 40 seconds in — a total failure and a success are
  // indistinguishable there. Without this line the sole trace of a failed run is
  // a `[lecture-maker] … rejected` warning that names a topic but never says the
  // lecture died, and the next clue is a 404 on a lesson that was just built.
  //
  // Attaching a rejection handler here also stops the job promise counting as an
  // unhandled rejection when every subscriber has disconnected.
  promise.then(
    () => logger.info({ lessonId }, "lecture generated"),
    (error: unknown) =>
      logger.error(
        { lessonId, err: error instanceof Error ? error.message : String(error) },
        "lecture generation failed — nothing persisted",
      ),
  );

  const job: GenerationJob = { promise, emitter, history };
  jobs.set(lessonId, job);
  return job;
}

export async function generateLectureForLesson(
  userId: string,
  lessonId: string,
): Promise<{ lecture: LectureJson; created: boolean }> {
  await assertLessonEnterable(userId, lessonId);
  const existing = await LectureModel.findOne({ lessonId, version: LECTURE_VERSION }).lean();
  if (existing) return { lecture: toLectureJson(existing as LectureDocShape), created: false };

  const job = jobs.get(lessonId) ?? startJob(userId, lessonId);
  return { lecture: await job.promise, created: true };
}

export type LectureStreamEvent =
  | { type: "progress"; event: LectureProgressEvent }
  | { type: "done"; lecture: LectureJson; cached: boolean }
  | { type: "error"; message: string };

/**
 * Streams generation progress for the classroom's loading screen. Multiple
 * concurrent viewers of one lesson (two tabs, a double-click) attach to the
 * same underlying job instead of starting a second pipeline run — a
 * subscriber that joins mid-run gets the stages it missed replayed first.
 * The job itself keeps running even if every subscriber disconnects.
 */
export async function* streamLectureGeneration(
  userId: string,
  lessonId: string,
): AsyncGenerator<LectureStreamEvent> {
  await assertLessonEnterable(userId, lessonId);
  const existing = await LectureModel.findOne({ lessonId, version: LECTURE_VERSION }).lean();
  if (existing) {
    yield { type: "done", lecture: toLectureJson(existing as LectureDocShape), cached: true };
    return;
  }

  const job = jobs.get(lessonId) ?? startJob(userId, lessonId);

  for (const event of job.history) yield { type: "progress", event };

  const queue: LectureProgressEvent[] = [];
  let wake: (() => void) | null = null;
  const onEvent = (event: LectureProgressEvent) => {
    queue.push(event);
    wake?.();
  };
  job.emitter.on("progress", onEvent);

  let settled: { lecture?: LectureJson; error?: unknown } | null = null;
  job.promise.then(
    (lecture) => {
      settled = { lecture };
      wake?.();
    },
    (error: unknown) => {
      settled = { error };
      wake?.();
    },
  );

  try {
    while (!settled || queue.length > 0) {
      if (queue.length > 0) {
        yield { type: "progress", event: queue.shift()! };
        continue;
      }
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
    const result = settled as { lecture?: LectureJson; error?: unknown };
    // Presence, not truthiness. A job that rejects with a falsy reason (an
    // aborted upstream call, `throw undefined`) used to fall through to the
    // `done` branch and hand the client `lecture: undefined` on a 200 — which
    // the classroom then tried to open, got a 404, and regenerated from scratch.
    if ("error" in result) {
      yield {
        type: "error",
        message: result.error instanceof Error ? result.error.message : "Lecture generation failed",
      };
      return;
    }
    yield { type: "done", lecture: result.lecture!, cached: false };
  } finally {
    job.emitter.off("progress", onEvent);
  }
}

/**
 * Where the student had reached inside a lecture.
 *
 * The voice agent keeps this in Redis too, keyed by room, but that entry
 * expires in hours — so leaving mid-lecture and returning the next day used to
 * restart the lesson from the beginning. This is the durable copy the agent
 * falls back to when the cache has gone.
 */
export async function getLecturePosition(
  userId: string,
  lessonId: string,
): Promise<{
  blockIndex: number;
  mode: string;
  beatId: string;
  beatPhase: string;
  knownBeats: string[];
  partlyBeats: string[];
} | null> {
  const doc = await LecturePositionModel.findOne({
    userId: new Types.ObjectId(userId),
    lessonId,
  }).lean();
  if (!doc) return null;
  return {
    blockIndex: doc.blockIndex ?? 0,
    mode: doc.mode ?? "lecture",
    beatId: doc.beatId ?? "",
    beatPhase: doc.beatPhase ?? "",
    knownBeats: doc.knownBeats ?? [],
    partlyBeats: doc.partlyBeats ?? [],
  };
}

export async function saveLecturePosition(
  userId: string,
  lessonId: string,
  input: {
    blockIndex: number;
    mode?: string;
    courseId?: string;
    beatId?: string;
    beatPhase?: string;
    knownBeats?: string[];
    partlyBeats?: string[];
  },
): Promise<void> {
  await LecturePositionModel.updateOne(
    { userId: new Types.ObjectId(userId), lessonId },
    {
      $set: {
        blockIndex: Math.max(0, Math.floor(input.blockIndex)),
        mode: input.mode ?? "lecture",
        ...(input.courseId ? { courseId: input.courseId } : {}),
        // Written unconditionally when the field is present, empty string
        // included: a v1 lecture has no beat, and leaving a previous one in
        // place would resume a concept the student is no longer in.
        ...(input.beatId !== undefined ? { beatId: input.beatId } : {}),
        ...(input.beatPhase !== undefined ? { beatPhase: input.beatPhase } : {}),
        ...(input.knownBeats !== undefined ? { knownBeats: input.knownBeats } : {}),
        ...(input.partlyBeats !== undefined ? { partlyBeats: input.partlyBeats } : {}),
      },
    },
    { upsert: true },
  );
}

/**
 * What the live tutor should assume about this student before they have said a
 * word: the course's level and how their last few exams in this course went.
 *
 * WHY THE TUTOR NEEDS IT. It decides whether to open each topic by asking "what
 * do you already know?" or by teaching (voice-service teaching_loop.py). Blind,
 * it asked a student who had scored 1/8 on the previous lesson's exam minutes
 * earlier what they knew — six topics in a row, six "I don't know"s.
 *
 * Numbers and enums only, never profile prose: this goes to a service that
 * branches on it, not to a prompt. Read by the agent on every join and never
 * cached with the lecture, because the most useful fact in it is the exam the
 * student sat five minutes ago.
 */
export interface LearnerSignal {
  level: "beginner" | "intermediate" | "advanced" | "";
  /** Mean of the last few graded exam scores in this course (0-100), or null if none. */
  recentExamPct: number | null;
  recentExams: number;
}

/** How many recent graded exams in the course the signal averages. */
const SIGNAL_RECENT_EXAMS = 3;

export async function getLearnerSignal(userId: string, lessonId: string): Promise<LearnerSignal> {
  const empty: LearnerSignal = { level: "", recentExamPct: null, recentExams: 0 };
  const owned = await requireOwnedLesson(userId, lessonId);
  if (!owned) return empty;
  const [course, attempts] = await Promise.all([
    CourseModel.findById(owned._id, { level: 1 }).lean(),
    // First attempts only (`graded`): a retake is sat with the key in hand.
    QuizAttemptModel.find(
      { userId: new Types.ObjectId(userId), courseId: String(owned._id), graded: { $ne: false } },
      { score: 1 },
    )
      .sort({ createdAt: -1 })
      .limit(SIGNAL_RECENT_EXAMS)
      .lean(),
  ]);
  const level = String(course?.level ?? "").toLowerCase();
  const scores = attempts.map((a) => Number(a.score)).filter((s) => Number.isFinite(s));
  return {
    level: level === "beginner" || level === "intermediate" || level === "advanced" ? level : "",
    recentExamPct: scores.length ? Math.round(scores.reduce((sum, s) => sum + s, 0) / scores.length) : null,
    recentExams: scores.length,
  };
}

export interface NextUp {
  nextLessonId: string;
  nextLessonTitle: string;
  /** The lesson's own exam, not yet attempted. */
  quizPending: boolean;
  /** Projects that finishing THIS lesson opens, with their deadline if any. */
  unlockedProjects: { id: string; title: string; dueInDays: number | null }[];
}

/**
 * What comes after this lesson — read by the tutor at the end of a class, for
 * its goodbye.
 *
 * A tutor that says "that's the lesson, well done" and stops is a narrator. The
 * difference is being able to say what to do next, by name: the lesson that
 * follows, the quiz still waiting, the project this one just opened. None of
 * that is knowable from the lecture document, which is why it is a round-trip
 * rather than something baked in at generation time — the answer depends on
 * what THIS student has finished.
 *
 * Every part is best-effort and independently omissible. This runs while the
 * student is sitting in the room waiting to be said goodbye to, so a missing
 * field costs one sentence and an exception would cost the goodbye.
 */
export async function getNextUp(userId: string, lessonId: string): Promise<NextUp> {
  const empty: NextUp = { nextLessonId: "", nextLessonTitle: "", quizPending: false, unlockedProjects: [] };
  // Ownership first, as everywhere else — and then the curriculum, which
  // requireOwnedLesson deliberately does not fetch (it selects `_id` only, so
  // the gate stays a single indexed lookup on every classroom read).
  const owned = await requireOwnedLesson(userId, lessonId);
  if (!owned) return empty;
  const course = await CourseModel.findById(owned._id).lean();
  if (!course) return empty;

  const courseId = String(course._id);
  const ordered = orderedTopics(course as Course);
  const at = ordered.findIndex((t) => t.lessonId === lessonId);
  const next = at >= 0 ? ordered[at + 1] : undefined;

  const [enrollment, attempt, projects, lecture] = await Promise.all([
    EnrollmentModel.findOne({ userId: new Types.ObjectId(userId), courseId }, { completedLessonIds: 1 }).lean(),
    QuizAttemptModel.findOne({ userId: new Types.ObjectId(userId), quizId: lessonId }, { _id: 1 }).lean(),
    ProjectModel.find({ userId: new Types.ObjectId(userId), courseId }, { title: 1, submitWithinDays: 1, unlockLessonId: 1, chapterIndex: 1, difficulty: 1, courseId: 1 }).lean(),
    LectureModel.findOne({ lessonId, version: LECTURE_VERSION }, { sections: 1 }).lean(),
  ]);

  // The lesson is being completed right now, so the student's stored set does
  // not contain it yet — which is exactly the set the gate must be asked about
  // to find what THIS lesson opens.
  const done = new Set([...(enrollment?.completedLessonIds ?? []), lessonId]);
  const before = new Set(enrollment?.completedLessonIds ?? []);

  const unlockedProjects: NextUp["unlockedProjects"] = [];
  for (const project of projects) {
    const gated = { courseId: project.courseId, chapterIndex: project.chapterIndex, difficulty: project.difficulty, unlockLessonId: project.unlockLessonId };
    // Newly open: shut before this lesson, open after it. A project that was
    // already open is not news and the tutor should not re-announce it.
    const shut = projectLock(gated, course as Pick<Course, "chapters">, [...before]).locked;
    const open = !projectLock(gated, course as Pick<Course, "chapters">, [...done]).locked;
    if (shut && open) {
      const days = project.submitWithinDays ?? 0;
      unlockedProjects.push({ id: String(project._id), title: project.title, dueInDays: days > 0 ? days : null });
    }
  }

  const hasQuiz = Boolean(lecture && findQuiz(lecture as unknown as LectureDocShape)?.length);
  return {
    nextLessonId: next?.lessonId ?? "",
    nextLessonTitle: next?.title ?? "",
    quizPending: hasQuiz && !attempt,
    unlockedProjects,
  };
}

/** Every topic of a course in reading order — the same order the roadmap uses. */
function orderedTopics(course: Course): { lessonId: string; title: string }[] {
  const out: { lessonId: string; title: string }[] = [];
  for (const chapter of course.chapters ?? []) {
    for (const module of chapter.modules ?? []) {
      for (const topic of module.topics ?? []) {
        out.push({ lessonId: topic.lessonId, title: topic.title });
      }
    }
  }
  return out;
}
