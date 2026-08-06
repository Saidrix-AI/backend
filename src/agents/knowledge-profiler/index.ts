import { env } from "../../config/env.js";
import type { Language } from "../../validation/language.js";
import { ApiError } from "../../utils/apiError.js";
import { getOpenAICompatClient } from "../llm.js";
import {
  formatZodIssues,
  runForcedToolCall,
  type LlmDeps,
} from "../shared/forcedToolCall.js";
import {
  buildProfileSystemPrompt,
  buildProfileUserMessage,
  buildRoundSystemPrompt,
  buildRoundUserMessage,
  type AnsweredQuestion,
  type RoundContext,
} from "./prompt.js";
import {
  emitProfileTool,
  emitQuestionsTool,
  emittedProfileSchema,
  normalizeProfile,
  normalizeRound,
  QUESTIONS_PER_ROUND,
  questionBatchSchema,
  type GeneratedQuestion,
  type KnowledgeProfile,
} from "./schema.js";

export type { AnsweredQuestion } from "./prompt.js";
export type { GeneratedQuestion, KnowledgeProfile } from "./schema.js";
export { QUESTIONS_PER_ROUND, TOTAL_ROUNDS } from "./schema.js";

const MAX_OUTPUT_TOKENS = 4096;

export function resolveProfilerDeps(): LlmDeps {
  const oai = getOpenAICompatClient();
  if (!oai) {
    throw new ApiError(503, "The knowledge check needs an OpenAI-compatible LLM provider (openai or openrouter).");
  }
  return { client: oai.client, model: env.ASSESSMENT_MODEL ?? env.COURSE_MAKER_MODEL ?? oai.model };
}

/** Generates one round's questions, trimmed to the round size. */
export async function generateRound(ctx: RoundContext, deps?: LlmDeps): Promise<GeneratedQuestion[]> {
  const batch = await runForcedToolCall({
    deps: deps ?? resolveProfilerDeps(),
    tool: emitQuestionsTool,
    system: buildRoundSystemPrompt(ctx.round),
    user: buildRoundUserMessage(ctx),
    parse: (raw) => {
      const r = questionBatchSchema.safeParse(normalizeRound(raw));
      return r.success
        ? { success: true, data: r.data }
        : { success: false, issues: formatZodIssues(r.error) };
    },
    sizeHint: "Keep every question and option short.",
    maxTokens: MAX_OUTPUT_TOKENS,
    label: "Knowledge check",
  });
  return batch.questions.slice(0, QUESTIONS_PER_ROUND);
}

/** Correct-answer rate over the diagnostic questions answered so far. */
export function scoreDiagnostics(history: AnsweredQuestion[]): {
  correct: number;
  total: number;
  score: number | null;
} {
  const diagnostics = history.filter((h) => h.kind === "diagnostic" && h.correct !== undefined);
  const correct = diagnostics.filter((h) => h.correct).length;
  return {
    correct,
    total: diagnostics.length,
    score: diagnostics.length ? Math.round((correct / diagnostics.length) * 100) : null,
  };
}

/**
 * The finished profile. The diagnostic score is computed here and handed to the
 * model as a fact — it is never asked to work out how well the student did.
 */
export async function buildProfile(
  ctx: { topic: string; objective: string; history: AnsweredQuestion[]; language?: Language },
  deps?: LlmDeps,
): Promise<KnowledgeProfile> {
  const { correct, total, score } = scoreDiagnostics(ctx.history);
  const emitted = await runForcedToolCall({
    deps: deps ?? resolveProfilerDeps(),
    tool: emitProfileTool,
    system: buildProfileSystemPrompt(),
    user: buildProfileUserMessage({
      topic: ctx.topic,
      objective: ctx.objective,
      history: ctx.history,
      diagnosticScore: score,
      diagnosticCorrect: correct,
      diagnosticTotal: total,
      ...(ctx.language ? { language: ctx.language } : {}),
    }),
    parse: (raw) => {
      const r = emittedProfileSchema.safeParse(normalizeProfile(raw));
      return r.success
        ? { success: true, data: r.data }
        : { success: false, issues: formatZodIssues(r.error) };
    },
    sizeHint: "Keep the summary to two sentences and list fewer concepts.",
    maxTokens: MAX_OUTPUT_TOKENS,
    label: "Knowledge check",
  });
  return { ...emitted, diagnosticScore: score };
}
