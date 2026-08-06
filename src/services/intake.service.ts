import { Types } from "mongoose";
import { generateGoalQuestions } from "../agents/intake/index.js";
import {
  DEVICE_QUESTION,
  INTAKE_DONE_PREFIX,
  LANGUAGE_QUESTION,
  parseOperatingSystem,
} from "../agents/tools/prompts/intake.js";
import { routineTimingQuestions } from "../agents/tools/prompts/routine.js";
import type { AskQuestion } from "../agents/tools/types.js";
import {
  INTAKE_STAGES,
  LearningIntakeModel,
  type LearningIntake,
} from "../database/models/learningIntake.model.js";
import {
  DEFAULT_LANGUAGE,
  LANGUAGE_LABELS,
  parseLanguage,
  type Language,
} from "../validation/language.js";
import { ApiError } from "../utils/apiError.js";
import * as assessmentService from "./assessment.service.js";
import { upsertLearnerProfile } from "./learnerProfile.service.js";

/**
 * The guided intake's stage machine: goal & target → language → their computer
 * → knowledge check → timetable. Modelled on assessment.service.ts — the server
 * owns the state, the browser only posts answers, and the chat turn ends as soon
 * as the first stage is on screen. The knowledge-check stage is delegated to the
 * existing assessment service rather than reimplemented.
 */

export type IntakeStage = (typeof INTAKE_STAGES)[number];

const STAGE_LABELS: Record<IntakeStage, string> = {
  goal: "Goal & target",
  language: "Language",
  device: "Your computer",
  test: "Knowledge check",
  timetable: "Timetable",
};

export interface IntakeStagePayload {
  intakeId: string;
  stage: IntakeStage;
  /** 1-based position of this stage in INTAKE_STAGES, for the stage rail. */
  stageIndex: number;
  totalStages: number;
  stageLabel: string;
  questions: AskQuestion[];
  /** Test stage only — the knowledge check's own round counters. */
  round?: number;
  totalRounds?: number;
  answered?: number;
  totalQuestions?: number;
}

export interface IntakeDonePayload {
  intakeId: string;
  done: true;
  /** Everything the chat agent needs, already in one line per fact. */
  summary: string;
  nextAction: "propose_courses";
}

/** What generate_course reads back off the freshest intake. */
export interface IntakeContext {
  topic: string;
  objective: string;
  language: Language;
  /** "Finish by: … | Study days: … | Study time: …", ready to drop into a prompt. */
  timetable: string;
  goal: string;
}

type Doc = LearningIntake & { _id: Types.ObjectId; save: () => Promise<unknown> };

function stagePayload(doc: Doc, questions: AskQuestion[]): IntakeStagePayload {
  const stage = doc.stage as IntakeStage;
  return {
    intakeId: String(doc._id),
    stage,
    stageIndex: INTAKE_STAGES.indexOf(stage) + 1,
    totalStages: INTAKE_STAGES.length,
    stageLabel: STAGE_LABELS[stage],
    questions,
  };
}

/** The knowledge check's round payload, re-labelled as the intake's test stage. */
function testPayload(doc: Doc, round: assessmentService.RoundPayload): IntakeStagePayload {
  return {
    ...stagePayload(doc, round.questions),
    round: round.round,
    totalRounds: round.totalRounds,
    answered: round.answered,
    totalQuestions: round.totalQuestions,
  };
}

/** Server-written questions are stored so a reload re-serves exactly what was asked. */
function setPending(doc: Doc, questions: AskQuestion[]): AskQuestion[] {
  doc.pending = questions as unknown as typeof doc.pending;
  return questions;
}

function pendingOf(doc: Doc): AskQuestion[] {
  return (doc.pending ?? []) as unknown as AskQuestion[];
}

/**
 * Zips the questions that were on screen with the answers that came back. The
 * cast keeps mongoose's DocumentArray typing happy on assignment — the shape is
 * exactly the subdocument's.
 */
function recordAnswers(
  questions: AskQuestion[],
  answers: { answer: string }[],
): Doc["goal"] {
  return questions.map((q, i) => ({
    header: q.header,
    question: q.question,
    answer: answers[i]?.answer.trim() ?? "",
  })) as unknown as Doc["goal"];
}

export async function startIntake(
  userId: string,
  input: { topic: string; objective: string; scope?: "single" | "multi" },
): Promise<IntakeStagePayload> {
  const questions = await generateGoalQuestions({ topic: input.topic, objective: input.objective });

  const doc = new LearningIntakeModel({
    userId: new Types.ObjectId(userId),
    topic: input.topic,
    objective: input.objective,
    scope: input.scope ?? "single",
    stage: "goal",
  }) as unknown as Doc;

  setPending(doc, questions);
  await doc.save();
  return stagePayload(doc, questions);
}

async function findOwned(userId: string, id: string): Promise<Doc> {
  if (!Types.ObjectId.isValid(id)) throw new ApiError(404, "Intake not found");
  const doc = await LearningIntakeModel.findOne({ _id: id, userId: new Types.ObjectId(userId) });
  if (!doc) throw new ApiError(404, "Intake not found");
  return doc as unknown as Doc;
}

/** Where the student is right now — used to resume after a reload. */
export async function getIntake(
  userId: string,
  id: string,
): Promise<IntakeStagePayload | IntakeDonePayload> {
  const doc = await findOwned(userId, id);
  if (doc.status === "completed") return donePayload(doc);
  if (doc.stage === "test" && doc.assessmentId) {
    const round = await assessmentService.getAssessment(userId, String(doc.assessmentId));
    // A finished assessment whose timetable stage was never reached (e.g. the
    // tab closed on the last round) still has to move forward.
    if ("done" in round) return advanceToTimetable(doc, round.summary);
    return testPayload(doc, round);
  }
  return stagePayload(doc, pendingOf(doc));
}

async function advanceToTimetable(doc: Doc, profileSummary: string): Promise<IntakeStagePayload> {
  doc.profileSummary = profileSummary;
  doc.stage = "timetable";
  const questions = setPending(doc, routineTimingQuestions());
  await doc.save();
  return stagePayload(doc, questions);
}

function donePayload(doc: Doc): IntakeDonePayload {
  const language = (doc.language as Language | undefined) ?? DEFAULT_LANGUAGE;
  const lines = [
    ...doc.goal.map((g) => `${g.header}: ${g.answer}`),
    `Language: ${LANGUAGE_LABELS[language]} — write the whole course in this language`,
    `Knowledge check: ${doc.profileSummary || "not completed"}`,
    ...doc.timetable.map((t) => `${t.header}: ${t.answer}`),
  ];
  return {
    intakeId: String(doc._id),
    done: true,
    summary: lines.join("\n"),
    nextAction: "propose_courses",
  };
}

/**
 * Records one stage's answers and returns whatever comes next. `stage` is sent
 * by the client so a double-submit (or a stale tab) is rejected rather than
 * silently answering the wrong stage.
 */
export async function submitStage(
  userId: string,
  id: string,
  input: { stage: IntakeStage; round?: number; answers: { answer: string }[] },
): Promise<IntakeStagePayload | IntakeDonePayload> {
  const doc = await findOwned(userId, id);
  if (doc.status === "completed") return donePayload(doc);
  if (input.stage !== doc.stage) {
    throw new ApiError(409, `This intake is on the "${doc.stage}" stage.`);
  }

  switch (doc.stage) {
    case "goal": {
      doc.goal = recordAnswers(pendingOf(doc), input.answers);
      doc.stage = "language";
      const questions = setPending(doc, [LANGUAGE_QUESTION]);
      await doc.save();
      return stagePayload(doc, questions);
    }

    case "language": {
      // An unrecognised free-text answer (a language we don't generate in) falls
      // back to English rather than failing the intake.
      doc.language = parseLanguage(input.answers[0]?.answer ?? "") ?? DEFAULT_LANGUAGE;
      doc.stage = "device";
      const questions = setPending(doc, [DEVICE_QUESTION]);
      await doc.save();
      return stagePayload(doc, questions);
    }

    case "device": {
      // Unrecognised stays "" — the setup lane then covers all three operating
      // systems, which is the honest degradation. Guessing one would send the
      // student install steps for a machine they do not own.
      const os = parseOperatingSystem(input.answers[0]?.answer ?? "");
      doc.operatingSystem = os;
      // The durable home for this is the learner profile, where the lecture
      // pipeline reads it from. Written as "profile" because the student
      // answered it themselves — the chat extractor must never overwrite it.
      // Never allowed to sink the intake: a failed profile write costs the OS,
      // not the course.
      if (os) {
        await upsertLearnerProfile(userId, { operatingSystem: os }, "profile").catch((err: unknown) => {
          console.warn("[intake] could not save operatingSystem:", err instanceof Error ? err.message : err);
        });
      }
      const round = await assessmentService.startAssessment(userId, {
        topic: doc.topic,
        objective: intakeObjective(doc),
        scope: doc.scope as "single" | "multi",
        language: doc.language as Language,
      });
      doc.assessmentId = new Types.ObjectId(round.assessmentId);
      doc.stage = "test";
      setPending(doc, []);
      await doc.save();
      return testPayload(doc, round);
    }

    case "test": {
      if (!doc.assessmentId) throw new ApiError(409, "This intake has no knowledge check.");
      const result = await assessmentService.submitRound(userId, String(doc.assessmentId), {
        round: input.round ?? 1,
        answers: input.answers,
      });
      if ("done" in result) return advanceToTimetable(doc, result.summary);
      return testPayload(doc, result);
    }

    case "timetable": {
      doc.timetable = recordAnswers(pendingOf(doc), input.answers);
      doc.status = "completed";
      setPending(doc, []);
      await doc.save();
      return donePayload(doc);
    }
  }
}

/** The goal answers folded into the objective, so the knowledge check tests what they actually want. */
function intakeObjective(doc: Doc): string {
  const goal = doc.goal.map((g) => `${g.header}: ${g.answer}`).join("; ");
  return goal ? `${doc.objective} (${goal})` : doc.objective;
}

/** Lowercase, punctuation-free, single-spaced — for comparing two topic strings. */
function normalizeTopic(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}+#.\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Whether a finished intake covers the topic being asked about now. Deliberately
 * strict — whole-phrase containment only ("sql" ⊆ "sql for data analysis"), so
 * "python for data analysis" and "sql for data analysis" are NOT the same topic
 * despite sharing two words. Getting this wrong in the lenient direction is what
 * made a brand-new topic skip its interview, so it errs towards asking again.
 */
export function isSameTopic(a: string, b: string): boolean {
  const x = normalizeTopic(a);
  const y = normalizeTopic(b);
  if (!x || !y) return false;
  return x === y || x.includes(y) || y.includes(x);
}

/**
 * A recent completed intake for THIS topic, or null. Used by
 * start_learning_intake so a student who just finished the interview for a topic
 * isn't marched through it again — while a different topic always gets its own
 * goal, language and knowledge check.
 */
export async function findReusableIntake(
  userId: string,
  topic: string,
  maxAgeMinutes = 180,
): Promise<IntakeContext | null> {
  const recent = await latestIntake(userId, maxAgeMinutes);
  if (!recent) return null;
  return isSameTopic(recent.topic, topic) || isSameTopic(recent.objective, topic) ? recent : null;
}

/**
 * The freshest completed intake, so generate_course can pick up the chosen
 * language and the timetable without the chat model having to carry an id
 * around — the same trick assessment.service.latestProfile uses.
 */
export async function latestIntake(
  userId: string,
  maxAgeMinutes = 180,
): Promise<IntakeContext | null> {
  const since = new Date(Date.now() - maxAgeMinutes * 60_000);
  const doc = await LearningIntakeModel.findOne({
    userId: new Types.ObjectId(userId),
    status: "completed",
    updatedAt: { $gte: since },
  })
    .sort({ updatedAt: -1 })
    .lean();
  if (!doc) return null;
  return {
    topic: doc.topic,
    objective: doc.objective,
    language: (doc.language as Language | undefined) ?? DEFAULT_LANGUAGE,
    timetable: doc.timetable.map((t) => `${t.header}: ${t.answer}`).join(" | "),
    goal: doc.goal.map((g) => `${g.header}: ${g.answer}`).join("; "),
  };
}

export { INTAKE_DONE_PREFIX };
