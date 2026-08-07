import type OpenAI from "openai";
import { z } from "zod";
import { env } from "../../config/env.js";
import { languageInstruction, type Language } from "../../validation/language.js";
import { getOpenAICompatClient } from "../llm.js";
import { formatZodIssues, runForcedToolCall, type LlmDeps } from "../shared/forcedToolCall.js";
import {
  generatedQuestionSchema,
  normalizeRound,
  type GeneratedQuestion,
} from "../knowledge-profiler/schema.js";
import type { TopicKind } from "./schema.js";

/**
 * The intake director: after the student has said what they already know, it
 * decides whether a real diagnostic is worth asking — and if so, writes it.
 *
 * WHY IT IS A DECISION AT ALL. The old knowledge check fired sixteen questions
 * at everyone, eight of them code diagnostics, and its own prompt said to test
 * a self-declared beginner anyway ("test the most basic prerequisite ideas
 * anyway"). Someone who has never written a line of code was handed eight
 * "what does this print" MCQs. That is the single biggest source of the
 * nonsense questions this redesign exists to remove.
 *
 * The alternative — a hard `if (saidTheyKnowNothing) skip` rule — was
 * considered and rejected by the product owner: a student who says "I know a
 * little" is a judgement call, not a boolean. So the model that can read the
 * whole transcript makes it, and the same call writes the questions, so
 * deciding costs no extra round-trip.
 */

/** How many diagnostics the director may ask. Short by design. */
export const MAX_PROBE_QUESTIONS = 3;

export interface IntakeAnswer {
  header: string;
  question: string;
  answer: string;
}

export interface ProbeContext {
  topic: string;
  objective: string;
  topicKind: TopicKind;
  /** Everything the student has answered so far, in order. */
  answers: IntakeAnswer[];
  language: Language;
}

/** `ask: false` carries no questions; `ask: true` always carries at least one. */
export type ProbeDecision =
  | { ask: false; reason: string }
  | { ask: true; reason: string; questions: GeneratedQuestion[] };

const decisionSchema = z.object({
  ask: z.boolean(),
  reason: z.string().trim().max(300).default(""),
  questions: z.array(generatedQuestionSchema).max(MAX_PROBE_QUESTIONS).default([]),
});

const emitProbeDecisionTool: OpenAI.Chat.ChatCompletionFunctionTool = {
  type: "function",
  function: {
    name: "emit_probe_decision",
    description:
      "Decide whether this student needs diagnostic questions, and write them if they do. Call exactly once.",
    parameters: {
      type: "object",
      required: ["ask", "reason", "questions"],
      properties: {
        ask: {
          type: "boolean",
          description:
            "true only if testing them would actually change where the course starts. false when their answers already place them.",
        },
        reason: { type: "string", description: "One short line on why. Never shown to the student." },
        questions: {
          type: "array",
          description: `Empty when ask is false. Otherwise 2-${MAX_PROBE_QUESTIONS} real diagnostic questions.`,
          items: {
            type: "object",
            required: ["header", "question", "options", "kind", "correctIndex", "concept"],
            properties: {
              header: { type: "string", description: "Very short label, e.g. 'Loops'" },
              question: { type: "string", description: "The full question text" },
              options: { type: "array", description: "2-4 short answer choices", items: { type: "string" } },
              kind: { type: "string", enum: ["diagnostic"], description: "Always 'diagnostic' here" },
              correctIndex: { type: "integer", description: "0-based index of the one correct option" },
              concept: { type: "string", description: "The concept this tests, e.g. 'list slicing'" },
            },
          },
        },
      },
    },
  },
};

function buildSystemPrompt(): string {
  return `You are the intake director for Saidrix AI Tutor. A student has just answered a few short questions before their course is designed. You decide ONE thing: whether asking them real test questions now would change where the course starts.

You respond ONLY by calling emit_probe_decision exactly once — never with plain text.

Say ask=false — and emit no questions — when their answers already place them. In particular:
- They said they have never touched the subject, or have only read about it. A beginner cannot demonstrate anything, so testing them tells you nothing you were not just told, and it makes the setup feel like an exam they are failing.
- They said they do not know what a code editor is, or have no programming background at all.
- The subject is one where a multiple-choice question cannot measure anything real (a spoken language, a creative skill, an exam they have not started).

Say ask=true when they claim some real ground and the course would be built differently depending on how much of it is true — someone who "uses it at work" might be Intermediate or genuinely Advanced, and only a question can tell you which.

When ask=true, write 2-${MAX_PROBE_QUESTIONS} questions and follow these exactly:
- Pitch them AT the level they claimed, not below it. The point is to find the ceiling, not to confirm they can pass something easy.
- Real questions with real answers: "what does this print", "which of these is a X", "when would you use Y". Never ask how confident they feel — they already told you.
- Exactly one correct option, named by correctIndex, and a concept tag so their gaps can be named later.
- Wrong options must be believable mistakes a learner actually makes, not jokes.
- Each tests something different, so the set maps the subject rather than repeating one idea.
- Short enough to read on a phone.

Write every question and option in the language the LANGUAGE line gives you.`;
}

function buildUserMessage(ctx: ProbeContext): string {
  const transcript = ctx.answers.length
    ? ctx.answers.map((a) => `${a.header}: ${a.question}\n   answered: ${a.answer}`).join("\n")
    : "(nothing answered yet)";
  return [
    languageInstruction(ctx.language),
    "",
    `Topic: ${ctx.topic}`,
    `What the student asked for: ${ctx.objective}`,
    `Subject kind: ${ctx.topicKind}`,
    "",
    "What they have told you so far:",
    transcript,
    "",
    "Call emit_probe_decision.",
  ].join("\n");
}

function resolveDeps(): LlmDeps | null {
  const oai = getOpenAICompatClient();
  if (!oai) return null;
  return { client: oai.client, model: env.ASSESSMENT_MODEL ?? env.COURSE_MAKER_MODEL ?? oai.model };
}

/**
 * Never throws. Every failure path lands on `ask: false`, which skips the
 * diagnostics and lets the intake finish — the course is still built from
 * everything the student said, just without a measured score. A dead-ended
 * interview would be far worse than a missing probe.
 */
export async function decideProbe(ctx: ProbeContext, deps?: LlmDeps): Promise<ProbeDecision> {
  const resolved = deps ?? resolveDeps();
  if (!resolved) return { ask: false, reason: "no LLM provider configured" };

  try {
    const decision = await runForcedToolCall({
      deps: resolved,
      tool: emitProbeDecisionTool,
      system: buildSystemPrompt(),
      user: buildUserMessage(ctx),
      parse: (raw) => {
        const root = (raw ?? {}) as Record<string, unknown>;
        // The questions travel in the same shape a profiler round does, so they
        // get the same coercion — models name the right answer half a dozen
        // ways, and one malformed question must not cost the whole probe.
        const normalized = normalizeRound({ questions: root.questions ?? [] }) as {
          questions: unknown[];
        };
        const r = decisionSchema.safeParse({
          ask: root.ask,
          reason: root.reason,
          questions: normalized.questions,
        });
        return r.success
          ? { success: true, data: r.data }
          : { success: false, issues: formatZodIssues(r.error) };
      },
      sizeHint: "Ask fewer questions and keep every option short.",
      maxTokens: 2048,
      label: "Intake probe",
    });

    // A "yes" with nothing usable behind it is a "no". normalizeRound demotes a
    // diagnostic whose correct option cannot be resolved to self_report, so an
    // unscoreable question would otherwise be shown as if it measured something.
    const usable = decision.questions.filter((q) => q.kind === "diagnostic");
    if (!decision.ask || usable.length === 0) {
      return { ask: false, reason: decision.reason || "no usable diagnostics emitted" };
    }
    return { ask: true, reason: decision.reason, questions: usable };
  } catch (err) {
    console.warn(
      "[intake] probe decision failed, skipping diagnostics:",
      err instanceof Error ? err.message : err,
    );
    return { ask: false, reason: "probe decision failed" };
  }
}
