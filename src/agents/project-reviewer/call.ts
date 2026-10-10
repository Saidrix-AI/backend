import { env } from "../../config/env.js";
import { ApiError } from "../../utils/apiError.js";
import { getModelName, hasOpenAICompatProvider } from "../llm.js";
import {
  runForcedToolCall as runSharedForcedToolCall,
  type ForcedToolCallOptions,
  type LlmDeps,
} from "../shared/forcedToolCall.js";

/**
 * The LLM boundary shared by the project reviewer and the project-requirements
 * author — the requirements ARE the contract the reviewer grades against, so
 * both run on one model (PROJECT_REVIEW_MODEL).
 */

export { formatZodIssues } from "../shared/forcedToolCall.js";
export type { LlmDeps, ParseResult } from "../shared/forcedToolCall.js";

export function resolveReviewDeps(): LlmDeps {
  if (!hasOpenAICompatProvider()) {
    throw new ApiError(503, "Project review needs an OpenAI-compatible LLM provider (openai or openrouter).");
  }
  return { model: env.PROJECT_REVIEW_MODEL ?? getModelName() };
}

export type ReviewToolCallOptions<T> = Omit<ForcedToolCallOptions<T>, "maxTokens" | "label"> &
  Partial<Pick<ForcedToolCallOptions<T>, "label">>;

export function runReviewToolCall<T>(opts: ReviewToolCallOptions<T>): Promise<T> {
  return runSharedForcedToolCall({
    ...opts,
    maxTokens: env.PROJECT_REVIEW_MAX_OUTPUT_TOKENS,
    label: opts.label ?? "Project review",
  });
}
