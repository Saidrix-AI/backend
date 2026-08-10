import { EventEmitter } from "node:events";
import { Types } from "mongoose";
import { makeLecture, type LectureProgressEvent, type LessonContext } from "../agents/lecture-maker/index.js";
import { buildStudentContext } from "./studentMemory.service.js";
import { getLearnerProfile } from "./learnerProfile.service.js";
import { CourseModel, type Course } from "../database/models/course.model.js";
import { LectureModel } from "../database/models/lecture.model.js";
import { LecturePositionModel } from "../database/models/lecturePosition.model.js";
import { ApiError } from "../utils/apiError.js";
import { logger } from "../utils/logger.js";
import { assertCourseEnterable } from "./activeSelection.service.js";

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
async function requireOwnedLesson(
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

interface LectureDocShape {
  lessonId: string;
  version?: number;
  language?: string;
  kind?: string;
  course?: { title?: string; breadcrumb?: string[] };
  title: string;
  outline?: unknown[];
  blocks?: unknown[];
}

interface QuizQuestion {
  question: string;
  options: string[];
  correctIndex: number;
  explanation?: string;
  concept?: string;
}

/**
 * Removes the answer key from a lecture's quiz blocks.
 *
 * The closing quiz is the lesson's exam, so `correctIndex` (and the `concept`
 * tag, which hints at it) must never leave the server — the same rule
 * knowledgeAssessment.model documents for the intake diagnostics. Grading
 * happens in `gradeLectureQuiz` against a fresh read of the document.
 *
 * `explanation` goes too: it usually names the right answer in prose.
 */
function stripQuizAnswers(blocks: unknown[] | undefined): unknown[] | undefined {
  if (!blocks) return blocks;
  return blocks.map((block) => {
    const b = block as { type?: string; questions?: QuizQuestion[] };
    if (b?.type !== "quiz" || !Array.isArray(b.questions)) return block;
    return {
      ...b,
      questions: b.questions.map(({ correctIndex: _c, explanation: _e, concept: _k, ...rest }) => rest),
    };
  });
}

/**
 * The lecture JSON shape the Classroom and the voice agent both consume.
 * Every exit from this service goes through here, so the strip above applies
 * to the cached read, the generate call and the progress stream alike.
 */
function toLectureJson(doc: LectureDocShape) {
  return {
    id: doc.lessonId,
    version: doc.version,
    language: doc.language,
    // Absent on lectures cached before the setup lane existed — those are all
    // concept lectures, so the client's fallback is the correct answer.
    kind: doc.kind ?? "concept",
    course: doc.course,
    title: doc.title,
    outline: doc.outline,
    blocks: stripQuizAnswers(doc.blocks),
  };
}
export type LectureJson = ReturnType<typeof toLectureJson>;

/**
 * Reads a lecture the caller is entitled to.
 *
 * `LectureModel` has no owner field, so the ownership question is answered
 * against the caller's courses before the document is touched at all.
 */
export async function getLectureByLessonId(userId: string, lessonId: string): Promise<LectureJson> {
  await requireOwnedLesson(userId, lessonId);
  const doc = await LectureModel.findOne({ lessonId }).lean();
  if (!doc) throw new ApiError(404, "Lecture not found");
  return toLectureJson(doc as LectureDocShape);
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

  const doc = await LectureModel.findOne({ lessonId }).lean();
  if (!doc) throw new ApiError(404, "Lecture not found");

  const quiz = ((doc as LectureDocShape).blocks ?? []).find(
    (b) => (b as { type?: string })?.type === "quiz",
  ) as { questions?: QuizQuestion[] } | undefined;
  const questions = quiz?.questions;
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
    const made = await makeLecture(ctx, undefined, onProgress);
    const $set = {
      version: 1,
      language: made.language,
      kind: made.kind,
      title: made.title,
      course: { title: ctx.courseTitle, breadcrumb: [ctx.courseTitle, ctx.chapterTitle, ctx.moduleTitle] },
      outline: made.outline,
      blocks: made.blocks,
    };
    try {
      const doc = await LectureModel.findOneAndUpdate({ lessonId }, { $set }, { upsert: true, new: true }).lean();
      return toLectureJson(doc as unknown as LectureDocShape);
    } catch (err: unknown) {
      if ((err as { code?: number }).code === 11000) {
        const doc = await LectureModel.findOne({ lessonId }).lean();
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
  const existing = await LectureModel.findOne({ lessonId }).lean();
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
  const existing = await LectureModel.findOne({ lessonId }).lean();
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
): Promise<{ blockIndex: number; mode: string } | null> {
  const doc = await LecturePositionModel.findOne({
    userId: new Types.ObjectId(userId),
    lessonId,
  }).lean();
  if (!doc) return null;
  return { blockIndex: doc.blockIndex ?? 0, mode: doc.mode ?? "lecture" };
}

export async function saveLecturePosition(
  userId: string,
  lessonId: string,
  input: { blockIndex: number; mode?: string; courseId?: string },
): Promise<void> {
  await LecturePositionModel.updateOne(
    { userId: new Types.ObjectId(userId), lessonId },
    {
      $set: {
        blockIndex: Math.max(0, Math.floor(input.blockIndex)),
        mode: input.mode ?? "lecture",
        ...(input.courseId ? { courseId: input.courseId } : {}),
      },
    },
    { upsert: true },
  );
}
