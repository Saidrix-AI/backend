import { DEFAULT_LANGUAGE, languageInstruction, type Language } from "../../validation/language.js";
import { QUESTIONS_PER_ROUND, TOTAL_ROUNDS } from "./schema.js";

/** One already-asked question with what the student picked. */
export interface AnsweredQuestion {
  round: number;
  header: string;
  question: string;
  answer: string;
  kind: "self_report" | "diagnostic";
  concept?: string;
  correct?: boolean;
}

export interface RoundContext {
  topic: string;
  objective: string;
  round: number;
  history: AnsweredQuestion[];
  /** Percentage correct on the diagnostics so far, or null before any were asked. */
  diagnosticScore: number | null;
  /** The language the student picked in the intake; defaults to English. */
  language?: Language;
}

const BASE = `You are the knowledge assessor for Saidrix AI Tutor. Before a course is built, you find out what the student actually knows so the curriculum starts in the right place. You ask ONE short round of ${QUESTIONS_PER_ROUND} multiple-choice questions.

You respond ONLY by calling the emit_questions function exactly once with exactly ${QUESTIONS_PER_ROUND} questions — never with plain text.

Always:
- Ask about ONE thing per question, in plain language, short enough to read on a phone.
- Give 2-4 short options that are all plausible.
- Write every question and option in the language the LANGUAGE line tells you. Never switch script mid-assessment.`;

/**
 * The one round. Everything else the four-round version asked — their goal,
 * their weekly hours, their pace preference, what blocks them — is now asked by
 * the intake's own slots, so re-asking it here was pure duplication.
 *
 * Note what is NOT here any more: the old round 2 instructed the model to test
 * a self-declared beginner "anyway". Whether to test at all is now the intake
 * director's call (agents/intake/director.ts), and by the time this prompt runs
 * that decision has already been made — so this round can assume the student
 * has something worth measuring and pitch at it.
 */
const ROUND_RULE = `All ${QUESTIONS_PER_ROUND} questions are kind "diagnostic": each has exactly one correct option and a "concept" tag, and multiSelect must be false.
- Pitch them AT the level the student's answers suggest, not below it. The job is to find their ceiling, not to confirm they can pass something easy.
- Real questions with real answers — "what does this code print", "which of these is a X", "when would you use Y". Never ask how confident they feel; they have already been asked that.
- Wrong options must be believable mistakes a learner actually makes, not jokes.
- Each question tests something different, so the three together map the subject rather than repeating one idea.
- Tag each with the concept it tests so their gaps can be named later.`;

export function buildRoundSystemPrompt(_round: number): string {
  return `${BASE}\n\n${ROUND_RULE}`;
}

/**
 * Models are unreliable at inferring which language to answer in — an English
 * objective came back with Bangla questions often enough that the instruction
 * has to be explicit. The student now picks the language on the intake's
 * language card (services/intake.service.ts) instead of it being guessed from
 * whichever script they happened to type their request in.
 */
export function languageLine(language: Language = DEFAULT_LANGUAGE): string {
  return `${languageInstruction(language)} Never switch language or script mid-assessment.`;
}

/** Prior rounds rendered for the model, with diagnostic outcomes made explicit. */
function historyBlock(history: AnsweredQuestion[]): string {
  if (history.length === 0) return "(nothing asked yet)";
  return history
    .map((h) => {
      const verdict =
        h.kind === "diagnostic" ? (h.correct ? " → CORRECT" : " → WRONG") : "";
      const concept = h.concept ? ` [concept: ${h.concept}]` : "";
      return `R${h.round} ${h.header}${concept}: ${h.question}\n   answered: ${h.answer}${verdict}`;
    })
    .join("\n");
}

export function buildRoundUserMessage(ctx: RoundContext): string {
  return [
    languageLine(ctx.language),
    "",
    `Topic: ${ctx.topic}`,
    `What the student asked for: ${ctx.objective}`,
    ctx.diagnosticScore != null ? `Diagnostic score so far: ${ctx.diagnosticScore}% correct` : "",
    "",
    "Asked and answered so far:",
    historyBlock(ctx.history),
    "",
    `Call emit_questions with round ${ctx.round}'s ${QUESTIONS_PER_ROUND} questions.`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildProfileSystemPrompt(): string {
  return `You are the knowledge assessor for Saidrix AI Tutor. The student has finished a ${TOTAL_ROUNDS}-round knowledge check. Turn their answers into the profile the curriculum designer will build from. You respond ONLY by calling emit_profile exactly once.

Rules:
- Judge "level" from what they got RIGHT, not from what they claimed. A student who calls themselves advanced but missed the fundamentals is Beginner; one who called themselves a beginner and answered everything correctly is not.
- knownConcepts: only concepts they actually demonstrated. gapConcepts: concepts they got wrong, plus anything the objective needs that was never covered.
- goal and styleNotes come from their own words in the self-report rounds.
- summary: 2-3 sentences addressed to the curriculum designer — where to start, what to skip, what to spend time on.
- Write the text fields in the language the LANGUAGE line tells you.`;
}

export function buildProfileUserMessage(ctx: {
  topic: string;
  objective: string;
  history: AnsweredQuestion[];
  diagnosticScore: number | null;
  diagnosticCorrect: number;
  diagnosticTotal: number;
  language?: Language;
}): string {
  return [
    languageLine(ctx.language),
    "",
    `Topic: ${ctx.topic}`,
    `What the student asked for: ${ctx.objective}`,
    ctx.diagnosticTotal > 0
      ? `Diagnostic result: ${ctx.diagnosticCorrect} of ${ctx.diagnosticTotal} correct (${ctx.diagnosticScore}%). This is measured, not self-reported — weight it heavily.`
      : "No diagnostic questions were answered.",
    "",
    "Full transcript:",
    historyBlock(ctx.history),
    "",
    "Call emit_profile with this student's profile.",
  ]
    .filter(Boolean)
    .join("\n");
}
