import { Types } from "mongoose";
import {
  buildProfile,
  generateRound,
  QUESTIONS_PER_ROUND,
  TOTAL_ROUNDS,
  type AnsweredQuestion,
  type GeneratedQuestion,
  type KnowledgeProfile,
} from "../agents/knowledge-profiler/index.js";
import {
  KnowledgeAssessmentModel,
  type KnowledgeAssessment,
} from "../database/models/knowledgeAssessment.model.js";
import { QuizAttemptModel } from "../database/models/quizAttempt.model.js";
import { DEFAULT_LANGUAGE, type Language } from "../validation/language.js";
import { ApiError } from "../utils/apiError.js";

/** A question as the browser sees it — no correct answer, no concept tag. */
export interface ClientQuestion {
  header: string;
  question: string;
  options: string[];
  multiSelect: boolean;
}

export interface RoundPayload {
  assessmentId: string;
  round: number;
  totalRounds: number;
  /** How many questions have already been answered, for the running counter. */
  answered: number;
  /** Best estimate of the full length, so the UI can say "Question 5 of 16". */
  totalQuestions: number;
  questions: ClientQuestion[];
}

export interface DonePayload {
  assessmentId: string;
  done: true;
  answered: number;
  summary: string;
  profile: KnowledgeProfile;
  /** Which course tool the chat agent should run next. */
  nextAction: "generate_course" | "propose_courses";
}

type Doc = KnowledgeAssessment & { _id: Types.ObjectId };

function toClientQuestion(q: { header: string; question: string; options: string[]; multiSelect?: boolean }): ClientQuestion {
  return {
    header: q.header,
    question: q.question,
    options: [...q.options],
    multiSelect: Boolean(q.multiSelect),
  };
}

/** Answered so far + what is still to come — accurate even if a round is short. */
function estimateTotal(doc: Doc): number {
  const remainingRounds = Math.max(0, TOTAL_ROUNDS - doc.round);
  return doc.asked.length + remainingRounds * QUESTIONS_PER_ROUND;
}

function roundPayload(doc: Doc): RoundPayload {
  const questions = doc.asked.filter((q) => q.round === doc.round);
  return {
    assessmentId: String(doc._id),
    round: doc.round,
    totalRounds: TOTAL_ROUNDS,
    answered: doc.answers.length,
    totalQuestions: estimateTotal(doc),
    questions: questions.map(toClientQuestion),
  };
}

/** Prior rounds in the shape the profiler prompts expect. */
function history(doc: Doc): AnsweredQuestion[] {
  const out: AnsweredQuestion[] = [];
  for (const [i, answer] of doc.answers.entries()) {
    const asked = doc.asked[i];
    if (!asked) continue;
    out.push({
      round: asked.round,
      header: asked.header,
      question: asked.question,
      answer: answer.answer,
      kind: asked.kind as "self_report" | "diagnostic",
      ...(asked.concept ? { concept: asked.concept } : {}),
      ...(answer.correct === undefined || answer.correct === null ? {} : { correct: answer.correct }),
    });
  }
  return out;
}

function appendRound(doc: Doc, round: number, questions: GeneratedQuestion[]): void {
  for (const q of questions) {
    doc.asked.push({
      round,
      header: q.header,
      question: q.question,
      options: q.options,
      multiSelect: q.multiSelect,
      kind: q.kind,
      ...(q.correctIndex === undefined ? {} : { correctIndex: q.correctIndex }),
      ...(q.concept ? { concept: q.concept } : {}),
    });
  }
}

export async function startAssessment(
  userId: string,
  input: { topic: string; objective: string; scope?: "single" | "multi"; language?: Language },
): Promise<RoundPayload> {
  const language = input.language ?? DEFAULT_LANGUAGE;
  const questions = await generateRound({
    topic: input.topic,
    objective: input.objective,
    round: 1,
    history: [],
    diagnosticScore: null,
    language,
  });

  const doc = new KnowledgeAssessmentModel({
    userId: new Types.ObjectId(userId),
    topic: input.topic,
    objective: input.objective,
    scope: input.scope ?? "single",
    language,
    round: 1,
  }) as unknown as Doc & { save: () => Promise<unknown> };

  appendRound(doc, 1, questions);
  await doc.save();
  return roundPayload(doc);
}

async function findOwned(userId: string, id: string) {
  if (!Types.ObjectId.isValid(id)) throw new ApiError(404, "Assessment not found");
  const doc = await KnowledgeAssessmentModel.findOne({ _id: id, userId: new Types.ObjectId(userId) });
  if (!doc) throw new ApiError(404, "Assessment not found");
  return doc as unknown as Doc & { save: () => Promise<unknown> };
}

export async function getAssessment(userId: string, id: string): Promise<RoundPayload | DonePayload> {
  const doc = await findOwned(userId, id);
  if (doc.status === "completed" && doc.profile) return donePayload(doc);
  return roundPayload(doc);
}

function donePayload(doc: Doc): DonePayload {
  const profile = doc.profile as unknown as KnowledgeProfile;
  return {
    assessmentId: String(doc._id),
    done: true,
    answered: doc.answers.length,
    summary: profile.summary,
    profile,
    nextAction: doc.scope === "multi" ? "propose_courses" : "generate_course",
  };
}

/**
 * Records one round's answers, then either generates the next round or closes
 * the assessment with a profile. Diagnostics are scored here by matching the
 * submitted text against the stored options — the client is never told which
 * option was right, so it cannot be scored there.
 */
export async function submitRound(
  userId: string,
  id: string,
  input: { round: number; answers: { answer: string }[] },
): Promise<RoundPayload | DonePayload> {
  const doc = await findOwned(userId, id);
  if (doc.status === "completed") return donePayload(doc);
  if (input.round !== doc.round) {
    throw new ApiError(409, `This knowledge check is on round ${doc.round}.`);
  }

  const pending = doc.asked.filter((q) => q.round === doc.round);
  if (input.answers.length !== pending.length) {
    throw new ApiError(400, `Round ${doc.round} needs ${pending.length} answers.`);
  }

  for (const [i, asked] of pending.entries()) {
    const answer = input.answers[i]!.answer.trim();
    // A typed-in custom answer matches no option and is simply not scored.
    const picked = asked.options.findIndex((o) => o.trim().toLowerCase() === answer.toLowerCase());
    const correct =
      asked.kind === "diagnostic" && asked.correctIndex != null && picked >= 0
        ? picked === asked.correctIndex
        : undefined;
    doc.answers.push({
      round: asked.round,
      header: asked.header,
      answer,
      ...(correct === undefined ? {} : { correct }),
    });
  }

  const language = (doc.language as Language | undefined) ?? DEFAULT_LANGUAGE;

  if (doc.round >= TOTAL_ROUNDS) {
    const profile = await buildProfile({
      topic: doc.topic,
      objective: doc.objective,
      history: history(doc),
      language,
    });
    doc.profile = profile;
    doc.status = "completed";
    await doc.save();
    return donePayload(doc);
  }

  const nextRound = doc.round + 1;
  const scored = history(doc);
  const diagnostics = scored.filter((h) => h.correct !== undefined);
  const questions = await generateRound({
    topic: doc.topic,
    objective: doc.objective,
    round: nextRound,
    history: scored,
    diagnosticScore: diagnostics.length
      ? Math.round((diagnostics.filter((h) => h.correct).length / diagnostics.length) * 100)
      : null,
    language,
  });

  appendRound(doc, nextRound, questions);
  doc.round = nextRound;
  await doc.save();
  return roundPayload(doc);
}

/**
 * The freshest completed profile for this user, used to calibrate a course the
 * chat agent is about to generate. Scoped by recency rather than by an id the
 * model would have to carry around.
 */
export async function latestProfile(
  userId: string,
  maxAgeMinutes = 120,
): Promise<{ topic: string; profile: KnowledgeProfile } | null> {
  const since = new Date(Date.now() - maxAgeMinutes * 60_000);
  const doc = await KnowledgeAssessmentModel.findOne({
    userId: new Types.ObjectId(userId),
    status: "completed",
    updatedAt: { $gte: since },
  })
    .sort({ updatedAt: -1 })
    .lean();
  if (!doc?.profile) return null;
  return { topic: doc.topic, profile: doc.profile as unknown as KnowledgeProfile };
}

/** Below this a lecture exam counts as "did not hold up" for the level blend. */
const PASS_SCORE = 60;
/** How many recent exams the level is blended over, so one bad day can't demote. */
const LEVEL_WINDOW = 5;

function levelFor(average: number): KnowledgeProfile["level"] {
  if (average >= 85) return "Advanced";
  if (average >= 60) return "Intermediate";
  return "Beginner";
}

/**
 * Folds a lecture exam back into the student's knowledge profile.
 *
 * The profile used to be written once at intake and never again, so everything
 * the student actually proved afterwards was invisible to the course-maker.
 * Now each exam moves its concepts between known and gap, and nudges the level.
 *
 * `concepts` is empty for lectures generated before questions carried tags —
 * the score still counts, only the concept half is skipped.
 */
export async function recordQuizOutcome(
  userId: string,
  outcome: { score: number; concepts: { concept: string; correct: boolean }[] },
): Promise<void> {
  const doc = await KnowledgeAssessmentModel.findOne({
    userId: new Types.ObjectId(userId),
    status: "completed",
    profile: { $exists: true },
  }).sort({ updatedAt: -1 });
  // No completed knowledge check yet: the attempt is still recorded as a
  // QuizAttempt by the caller, there is simply no profile to fold it into.
  if (!doc?.profile) return;

  const profile = doc.profile as unknown as KnowledgeProfile;
  const known = new Set(profile.knownConcepts ?? []);
  const gaps = new Set(profile.gapConcepts ?? []);

  for (const { concept, correct } of outcome.concepts) {
    const name = concept.trim();
    if (!name) continue;
    if (correct) {
      // Proving a concept must clear it from the gaps, or a gap fixed months
      // ago keeps steering every future course.
      known.add(name);
      gaps.delete(name);
    } else {
      gaps.add(name);
      known.delete(name);
    }
  }

  // Blend over recent exams rather than reacting to the newest one.
  // Graded attempts only — a retake is taken with the answer key already shown,
  // so counting it would let anyone blend their level up to Advanced.
  const recent = await QuizAttemptModel.find({
    userId: new Types.ObjectId(userId),
    graded: { $ne: false },
  })
    .sort({ createdAt: -1 })
    .limit(LEVEL_WINDOW)
    .select("score")
    .lean();
  const scores = [outcome.score, ...recent.map((r) => r.score)].slice(0, LEVEL_WINDOW);
  const average = scores.reduce((sum, s) => sum + s, 0) / scores.length;

  doc.profile = {
    ...profile,
    knownConcepts: [...known],
    gapConcepts: [...gaps],
    level: levelFor(average),
    // Measured, like the intake diagnostics it sits beside.
    diagnosticScore: Math.round(average),
  } as unknown as typeof doc.profile;
  doc.markModified("profile");
  await doc.save();
}
