import { Types } from "mongoose";
import { decideProbe, type IntakeAnswer } from "../agents/intake/director.js";
import { buildIntakeReport, type IntakeReport } from "../agents/intake/report.js";
import type { TopicKind } from "../agents/intake/schema.js";
import { INTAKE_DONE_PREFIX } from "../agents/tools/prompts/intake.js";
import type { AskQuestion } from "../agents/tools/types.js";
import {
  INTAKE_STAGES,
  LearningIntakeModel,
  type IntakeStageName,
  type LearningIntake,
} from "../database/models/learningIntake.model.js";
import {
  DEFAULT_LANGUAGE,
  languageLabel,
  type Language,
} from "../validation/language.js";
import { ApiError } from "../utils/apiError.js";
import * as assessmentService from "./assessment.service.js";
import {
  nextSlot,
  questionCountFor,
  remainingSlots,
  slotFor,
  type IntakeSlot,
  type IntakeState,
} from "./intake.slots.js";
import { upsertLearnerProfile } from "./learnerProfile.service.js";

/**
 * The guided intake's stage machine. The server owns the state, the browser
 * only posts answers, and the chat turn ends as soon as the first card is on
 * screen.
 *
 * The slot table lives in ./intake.slots.ts — this file drives it: it decides
 * which slot comes next, runs each slot's interpretation, and handles the two
 * things the table cannot express on its own. Those are the diagnostic probe
 * (a multi-question, server-scored KnowledgeAssessment rather than a plain
 * batch) and the closing report.
 */

export type IntakeStage = IntakeStageName;

export interface IntakeStagePayload {
  intakeId: string;
  stage: IntakeStage;
  /** 1-based position among the slots THIS student is actually asked. */
  stageIndex: number;
  totalStages: number;
  stageLabel: string;
  /** Labels of the slots this student will see, for the transcript notice. */
  stages: string[];
  questions: AskQuestion[];
  /** Questions answered across the whole intake, not just this slot. */
  answered: number;
  /** Best estimate of the full length, so the dock can say "Question 4 of 9". */
  totalQuestions: number;
  /** Probe stage only — the assessment's own round counters. */
  round?: number;
  totalRounds?: number;
}

export interface IntakeDonePayload {
  intakeId: string;
  done: true;
  /** The compact brief, already in one line per fact. */
  summary: string;
  nextAction: "propose_courses";
}

/** What generate_course reads back off the freshest intake. */
export interface IntakeContext {
  topic: string;
  objective: string;
  language: Language;
  /** "Finish by: … | Daily time: …", ready to drop into a prompt. */
  timetable: string;
  goal: string;
  /** The finished brief, or null for an intake that predates it. */
  report: (IntakeReport & { needsSetupLesson: boolean }) | null;
  dailyMinutes: number;
  finishByDays: number;
  autoRoutine: boolean;
  routineTime: string;
}

type Doc = LearningIntake & { _id: Types.ObjectId; save: () => Promise<unknown> };

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

function stateOf(doc: Doc): IntakeState {
  const planned = (doc.plannedQuestions ?? {}) as IntakeState["plannedQuestions"];
  return {
    topic: doc.topic,
    objective: doc.objective,
    topicKind: (doc.topicKind as TopicKind) ?? "non-technical",
    needsLocalSetup: Boolean(doc.needsLocalSetup),
    language: (doc.language as Language) ?? DEFAULT_LANGUAGE,
    operatingSystem: (doc.operatingSystem as IntakeState["operatingSystem"]) ?? "",
    tooling: (doc.tooling as IntakeState["tooling"]) ?? "",
    foundation: (doc.foundation as IntakeState["foundation"]) ?? "",
    dailyMinutes: doc.dailyMinutes ?? 0,
    finishByDays: doc.finishByDays ?? 0,
    autoRoutine: Boolean(doc.autoRoutine),
    routineTime: doc.routineTime ?? "",
    plannedQuestions: planned,
    // The plan writes both questions in one call, so either one proves it ran.
    planKnown: Boolean(planned.goal ?? planned.background),
  };
}

/** Merges a slot's interpretation onto the document. */
function applyPatch(doc: Doc, patch: Partial<IntakeState>): void {
  if (patch.language !== undefined) doc.language = patch.language;
  if (patch.topicKind !== undefined) doc.topicKind = patch.topicKind;
  if (patch.needsLocalSetup !== undefined) doc.needsLocalSetup = patch.needsLocalSetup;
  if (patch.plannedQuestions !== undefined) {
    doc.plannedQuestions = patch.plannedQuestions as unknown as typeof doc.plannedQuestions;
  }
  if (patch.operatingSystem !== undefined) doc.operatingSystem = patch.operatingSystem;
  if (patch.tooling !== undefined) doc.tooling = patch.tooling;
  if (patch.foundation !== undefined) doc.foundation = patch.foundation;
  if (patch.dailyMinutes !== undefined) doc.dailyMinutes = patch.dailyMinutes;
  if (patch.finishByDays !== undefined) doc.finishByDays = patch.finishByDays;
  if (patch.autoRoutine !== undefined) doc.autoRoutine = patch.autoRoutine;
  if (patch.routineTime !== undefined) doc.routineTime = patch.routineTime;
}

/** Whether the probe has been decided yet, and how. */
function probeDecided(doc: Doc): boolean | null {
  if (doc.assessmentId) return true;
  return doc.skipped.includes("probe") ? false : null;
}

function transcript(doc: Doc): IntakeAnswer[] {
  return doc.answers.map((a) => ({
    header: a.header,
    question: a.question,
    answer: a.answer,
  }));
}

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

function stagePayload(
  doc: Doc,
  questions: AskQuestion[],
  extra: { round?: number; totalRounds?: number } = {},
): IntakeStagePayload {
  const stage = doc.stage as IntakeStage;
  const state = stateOf(doc);
  const decided = probeDecided(doc);
  const remaining = remainingSlots(stage, state, decided);
  const seen = INTAKE_STAGES.slice(0, INTAKE_STAGES.indexOf(stage)).filter(
    (key) => !doc.skipped.includes(key),
  );

  // Counted rather than assumed: the dock shows one question at a time across
  // nine mostly-single-question slots, so without a running total every card
  // would read "1 / 1" and the student would have no idea how much is left.
  const upcoming = remaining.reduce((sum, slot) => sum + questionCountFor(slot, state), 0);

  return {
    intakeId: String(doc._id),
    stage,
    stageIndex: seen.length + 1,
    totalStages: seen.length + remaining.length,
    stageLabel: slotFor(stage).label,
    stages: [...seen.map((key) => slotFor(key).label), ...remaining.map((s) => s.label)],
    questions,
    answered: doc.answers.length,
    totalQuestions: doc.answers.length + upcoming,
    ...extra,
  };
}

/**
 * The compact brief the chat agent reads. This replaced a dump of raw
 * "Header: answer" lines plus a profile summary — the course-maker had to
 * re-derive everything from prose, and half of it (the schedule, the setup
 * state, whether a routine was even wanted) was never stated at all.
 */
function donePayload(doc: Doc): IntakeDonePayload {
  const language = (doc.language as Language | undefined) ?? DEFAULT_LANGUAGE;
  const report = doc.report as IntakeReport | null;
  const lines: string[] = [`Topic: ${doc.topic}`];

  lines.push(`Language: ${languageLabel(language)} — write the whole course in this language`);

  if (report) {
    const measured =
      report.diagnosticScore == null
        ? "no diagnostic was asked"
        : `${report.diagnosticScore}% on a short diagnostic`;
    lines.push(`Level: ${report.level} (${measured})`);
    if (report.startFrom) lines.push(`Start from: ${report.startFrom}`);
    if (report.skip.length) lines.push(`Already knows, do not re-teach: ${report.skip.join(", ")}`);
    if (report.gapConcepts.length) {
      lines.push(`Spend real depth on: ${report.gapConcepts.join(", ")}`);
    }
    if (report.goal) lines.push(`Goal: ${report.goal}`);
  } else {
    lines.push(...doc.answers.map((a) => `${a.header}: ${a.answer}`));
  }

  const setup = [
    doc.operatingSystem || "",
    doc.tooling === "ready" ? "has an editor" : doc.tooling === "none" ? "no editor yet" : "",
    doc.tooling === "unknown" ? "does not know what a code editor is" : "",
    doc.foundation === "none" ? "no programming background" : "",
  ].filter(Boolean);
  if (setup.length) {
    const needs = doc.tooling === "none" || doc.tooling === "unknown";
    lines.push(`Setup: ${setup.join(" · ")}${needs ? " → include a setup lesson" : ""}`);
  }

  if (doc.dailyMinutes || doc.finishByDays) {
    lines.push(
      `Time: about ${doc.dailyMinutes || 60} minutes a day, wants to finish within ${doc.finishByDays || 30} days`,
    );
  }
  lines.push(
    doc.autoRoutine
      ? `Auto-routine: YES — build the study routine at ${doc.routineTime || "06:00 PM"} once the courses exist`
      : "Auto-routine: NO — the student will set up their own routine, do not build one",
  );
  if (report?.summary) lines.push(`Summary: ${report.summary}`);

  return {
    intakeId: String(doc._id),
    done: true,
    summary: lines.join("\n"),
    nextAction: "propose_courses",
  };
}

// ---------------------------------------------------------------------------
// Driving the machine
// ---------------------------------------------------------------------------

function setPending(doc: Doc, questions: AskQuestion[]): AskQuestion[] {
  doc.pending = questions as unknown as typeof doc.pending;
  return questions;
}

function pendingOf(doc: Doc): AskQuestion[] {
  return (doc.pending ?? []) as unknown as AskQuestion[];
}

/**
 * Opens on the language card, which is STATIC — so the first thing the student
 * sees appears with no model call in front of it. The topic-specific questions
 * are written once the language is known, which is also what stops them being
 * written in a language guessed from the script the student typed in.
 */
export async function startIntake(
  userId: string,
  input: { topic: string; objective: string; scope?: "single" | "multi" },
): Promise<IntakeStagePayload> {
  const doc = new LearningIntakeModel({
    userId: new Types.ObjectId(userId),
    topic: input.topic,
    objective: input.objective,
    scope: input.scope ?? "single",
    stage: "language",
  }) as unknown as Doc;

  const questions = await Promise.resolve(slotFor("language").build!(stateOf(doc)));
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
  if (doc.stage === "probe" && doc.assessmentId) {
    const round = await assessmentService.getAssessment(userId, String(doc.assessmentId));
    // A probe that finished while the tab was closed still has to move on.
    if ("done" in round) return advanceFrom(userId, doc, "probe");
    return stagePayload(doc, round.questions, { round: round.round, totalRounds: round.totalRounds });
  }
  return stagePayload(doc, pendingOf(doc));
}

/**
 * Moves to the next slot this student should be asked, recording everything
 * skipped on the way. Finishes the intake when nothing is left.
 */
async function advanceFrom(
  userId: string,
  doc: Doc,
  from: IntakeStage,
): Promise<IntakeStagePayload | IntakeDonePayload> {
  const state = stateOf(doc);
  const decided = probeDecided(doc);
  const { slot, skipped } = nextSlot(from, state, decided === true);
  if (skipped.length) doc.skipped = [...new Set([...doc.skipped, ...skipped])];

  if (!slot) return finishIntake(userId, doc);

  doc.stage = slot.key;

  // The probe has no `build`: its questions live on the KnowledgeAssessment,
  // where the answer key stays server-side and the round counter is owned.
  if (slot.key === "probe") {
    if (!doc.assessmentId) throw new ApiError(409, "This intake has no diagnostic.");
    const round = await assessmentService.getAssessment(userId, String(doc.assessmentId));
    if (!("done" in round)) {
      setPending(doc, []);
      await doc.save();
      return stagePayload(doc, round.questions, {
        round: round.round,
        totalRounds: round.totalRounds,
      });
    }
    // Already finished (a resumed tab) — carry straight on.
    return advanceFrom(userId, doc, "probe");
  }

  const questions = await Promise.resolve(slot.build!(state));
  setPending(doc, questions);
  await doc.save();
  return stagePayload(doc, questions);
}

/**
 * Records one slot's answers and returns whatever comes next. `stage` is sent
 * by the client so a double-submit (or a stale tab) is rejected rather than
 * silently answering the wrong slot.
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

  if (doc.stage === "probe") return submitProbe(userId, doc, input);

  const slot = slotFor(doc.stage as IntakeStage);
  const asked = pendingOf(doc);
  const answers = input.answers.map((a) => a.answer.trim());

  for (const [i, question] of asked.entries()) {
    doc.answers.push({
      stage: slot.key,
      header: question.header,
      question: question.question,
      answer: answers[i] ?? "",
    });
  }

  if (slot.interpret) {
    applyPatch(doc, await Promise.resolve(slot.interpret(answers, stateOf(doc))));
  }

  // The OS belongs on the learner profile, where the lecture pipeline reads it
  // from. Written as "profile" because the student answered it themselves — the
  // chat extractor must never overwrite it. Never allowed to sink the intake: a
  // failed profile write costs the OS, not the course.
  if (slot.key === "os" && doc.operatingSystem) {
    await upsertLearnerProfile(userId, { operatingSystem: doc.operatingSystem }, "profile").catch(
      (err: unknown) => {
        console.warn(
          "[intake] could not save operatingSystem:",
          err instanceof Error ? err.message : err,
        );
      },
    );
  }

  // The one applicability rule that is a judgement rather than a predicate.
  if (slot.key === "background") await resolveProbe(userId, doc);

  setPending(doc, []);
  return advanceFrom(userId, doc, slot.key);
}

/**
 * Asks the director whether a diagnostic is worth it, and starts one if so.
 * Either way the decision is recorded, so nextSlot knows what to do and a
 * reload does not ask again.
 */
async function resolveProbe(userId: string, doc: Doc): Promise<void> {
  const state = stateOf(doc);
  const decision = await decideProbe({
    topic: doc.topic,
    objective: intakeObjective(doc),
    topicKind: state.topicKind,
    answers: transcript(doc),
    language: state.language,
  });

  if (!decision.ask) {
    doc.skipped = [...new Set([...doc.skipped, "probe"])];
    console.info(`[intake] no diagnostic for "${doc.topic}": ${decision.reason}`);
    return;
  }

  const round = await assessmentService.startAssessment(userId, {
    topic: doc.topic,
    objective: intakeObjective(doc),
    scope: doc.scope as "single" | "multi",
    language: state.language,
    questions: decision.questions,
  });
  doc.assessmentId = new Types.ObjectId(round.assessmentId);
}

async function submitProbe(
  userId: string,
  doc: Doc,
  input: { round?: number; answers: { answer: string }[] },
): Promise<IntakeStagePayload | IntakeDonePayload> {
  if (!doc.assessmentId) throw new ApiError(409, "This intake has no diagnostic.");
  const assessmentId = String(doc.assessmentId);
  const recorded = await assessmentService.recordRound(userId, assessmentId, {
    round: input.round ?? 1,
    answers: input.answers,
  });

  // Record the probe in the intake transcript too, so the report reads one
  // continuous interview rather than having to be handed two sources.
  for (const answered of recorded.history.slice(doc.answers.filter((a) => a.stage === "probe").length)) {
    doc.answers.push({
      stage: "probe",
      header: answered.header,
      question: answered.question,
      answer: `${answered.answer}${answered.correct === undefined ? "" : answered.correct ? " (correct)" : " (wrong)"}`,
    });
  }

  if (!recorded.complete) {
    const next = await assessmentService.getAssessment(userId, assessmentId);
    if (!("done" in next)) {
      await doc.save();
      return stagePayload(doc, next.questions, {
        round: next.round,
        totalRounds: next.totalRounds,
      });
    }
  }
  return advanceFrom(userId, doc, "probe");
}

/**
 * Writes the brief and closes the intake.
 *
 * A completed KnowledgeAssessment is ALWAYS written, even when no diagnostic
 * was asked. Without it, skipping the probe would leave latestProfile() with
 * nothing to find and the course-maker would silently lose the entire learner
 * picture — see assessment.service.createCompletedAssessment.
 */
async function finishIntake(userId: string, doc: Doc): Promise<IntakeDonePayload> {
  const state = stateOf(doc);
  const answers = transcript(doc);

  // Zero-total when no diagnostic was asked, which the report prompt is told
  // about explicitly so it judges from what the student said rather than
  // inventing a measurement that never happened.
  const result = doc.assessmentId
    ? await assessmentService
        .diagnosticResult(userId, String(doc.assessmentId))
        .catch(() => ({ correct: 0, total: 0, score: null }))
    : { correct: 0, total: 0, score: null };

  const report = await buildIntakeReport({
    topic: doc.topic,
    objective: intakeObjective(doc),
    answers,
    diagnostic: result.total > 0 ? result : null,
    language: state.language,
  });

  const needsSetupLesson = doc.tooling === "none" || doc.tooling === "unknown";
  doc.report = { ...report, needsSetupLesson } as unknown as typeof doc.report;

  // The profile half of the report becomes the student's KnowledgeAssessment
  // profile, which is the single read path everything downstream already uses.
  const profile = {
    level: report.level,
    knownConcepts: report.knownConcepts,
    gapConcepts: report.gapConcepts,
    goal: report.goal,
    weeklyHours: report.weeklyHours,
    styleNotes: report.styleNotes,
    summary: report.summary,
    diagnosticScore: report.diagnosticScore,
  };

  try {
    if (doc.assessmentId) {
      await assessmentService.closeWithProfile(userId, String(doc.assessmentId), profile);
    } else {
      const id = await assessmentService.createCompletedAssessment(userId, {
        topic: doc.topic,
        objective: intakeObjective(doc),
        scope: doc.scope as "single" | "multi",
        language: state.language,
        profile,
      });
      doc.assessmentId = new Types.ObjectId(id);
    }
  } catch (err) {
    // The intake still completes: the report is on the intake document either
    // way, and course-maker reads it from there too.
    console.warn(
      "[intake] could not persist the knowledge profile:",
      err instanceof Error ? err.message : err,
    );
  }

  doc.status = "completed";
  setPending(doc, []);
  await doc.save();
  return donePayload(doc);
}

/** The goal answers folded into the objective, so the probe tests what they want. */
function intakeObjective(doc: Doc): string {
  const goal = doc.answers
    .filter((a) => a.stage === "goal" || a.stage === "background")
    .map((a) => `${a.header}: ${a.answer}`)
    .join("; ");
  return goal ? `${doc.objective} (${goal})` : doc.objective;
}

// ---------------------------------------------------------------------------
// Reuse
// ---------------------------------------------------------------------------

/** Lowercase, punctuation-free, single-spaced — for comparing two topic strings. */
function normalizeTopic(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}+#.\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Whether a finished intake covers the topic being asked about now.
 * Deliberately strict — whole-phrase containment only ("sql" ⊆ "sql for data
 * analysis"), so "python for data analysis" and "sql for data analysis" are NOT
 * the same topic despite sharing two words. Getting this wrong in the lenient
 * direction is what made a brand-new topic skip its interview, so it errs
 * towards asking again.
 */
export function isSameTopic(a: string, b: string): boolean {
  const x = normalizeTopic(a);
  const y = normalizeTopic(b);
  if (!x || !y) return false;
  return x === y || x.includes(y) || y.includes(x);
}

/**
 * A recent completed intake for THIS topic, or null. Used by
 * start_learning_intake so a student who just finished the interview for a
 * topic isn't marched through it again — while a different topic always gets
 * its own questions.
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
 * language, the brief and the timetable without the chat model having to carry
 * an id around — the same trick assessment.latestProfile uses.
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

  const timetable = [
    doc.finishByDays ? `Finish by: within ${doc.finishByDays} days` : "",
    doc.dailyMinutes ? `Daily time: about ${doc.dailyMinutes} minutes` : "",
  ]
    .filter(Boolean)
    .join(" | ");

  return {
    topic: doc.topic,
    objective: doc.objective,
    language: (doc.language as Language | undefined) ?? DEFAULT_LANGUAGE,
    timetable,
    goal: doc.answers
      .filter((a) => a.stage === "goal")
      .map((a) => `${a.header}: ${a.answer}`)
      .join("; "),
    report: (doc.report as IntakeContext["report"]) ?? null,
    dailyMinutes: doc.dailyMinutes ?? 0,
    finishByDays: doc.finishByDays ?? 0,
    autoRoutine: Boolean(doc.autoRoutine),
    routineTime: doc.routineTime ?? "",
  };
}

export { INTAKE_DONE_PREFIX };
export type { IntakeSlot };
