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

const BASE = `You are the knowledge assessor for Saidrix AI Tutor. Before a course is built, you find out what the student actually knows so the curriculum starts in the right place. You run ${TOTAL_ROUNDS} short rounds of ${QUESTIONS_PER_ROUND} multiple-choice questions.

You respond ONLY by calling the emit_questions function exactly once with exactly ${QUESTIONS_PER_ROUND} questions — never with plain text.

Always:
- Ask about ONE thing per question, in plain language, short enough to read on a phone.
- Give 2-4 short options that are all plausible. Never "I don't know" as the only escape — but do include an honest low-knowledge option on self_report questions.
- Never re-ask something an earlier round already established.
- Write every question and option in the language the LANGUAGE line tells you. Never switch script mid-assessment.`;

const ROUND_RULES: Record<number, string> = {
  1: `This is round 1 of ${TOTAL_ROUNDS}: orientation. All four questions are kind "self_report" (no correctIndex).
Cover, one question each: (a) what they want to be able to DO with this topic, (b) how much they have actually done with it already, (c) the closest related skill they do have, (d) how much time a week they can give it.`,

  2: `This is round 2 of ${TOTAL_ROUNDS}: first diagnostic. All four questions are kind "diagnostic" — each has exactly one correct option and a "concept" tag, and multiSelect must be false.
- Test the FOUNDATIONS of the topic at the level round 1 suggested. If they said they are a complete beginner, test the most basic prerequisite ideas anyway (a beginner who happens to know them should be moved up).
- These are real questions with real answers — "what does this code print", "which of these is a X", "when would you use Y". Never ask how confident they feel.
- Wrong options must be believable mistakes a learner actually makes, not jokes.
- Tag each with the concept it tests so the gaps can be named later.`,

  3: `This is round 3 of ${TOTAL_ROUNDS}: adaptive diagnostic. All four questions are kind "diagnostic", with a correctIndex and a concept, multiSelect false.
- Read the round 2 score. Scored high (3-4 right): go a clear step harder and probe the next layer of the topic to find the ceiling. Scored low (0-1 right): go simpler and find which prerequisite is actually missing — do not keep testing what they just failed.
- Cover concepts round 2 did not, so the two rounds together map the topic rather than repeating it.`,

  4: `This is round 4 of ${TOTAL_ROUNDS}: how they want to learn. All four questions are kind "self_report" (no correctIndex).
Cover, one question each: (a) pace and depth (fast overview vs thorough), (b) learning by building projects vs by explanation first, (c) what usually blocks them or made them stop before, (d) the outcome that would make this course worth it (a job, an exam, a personal build).
If a diagnostic round exposed an obvious gap, one of these may ask how they want to handle it — but keep all four about preferences, not knowledge.`,
};

export function buildRoundSystemPrompt(round: number): string {
  return `${BASE}\n\n${ROUND_RULES[round] ?? ROUND_RULES[1]}`;
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
