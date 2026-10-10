import { env } from "../../config/env.js";
import { ApiError } from "../../utils/apiError.js";
import { getModelName, hasOpenAICompatProvider } from "../llm.js";
import {
  runForcedToolCall as runSharedForcedToolCall,
  type ForcedToolCallOptions,
  type LlmDeps,
} from "../shared/forcedToolCall.js";

/**
 * The course pipeline's LLM boundary: role → model resolution, plus the shared
 * forced-tool-call runner pre-bound to this agent's output cap and label.
 * `outline` keeps its own resolver in generator.ts (it predates this file and
 * is mocked wholesale by the tests); enrichment and project planning use this.
 */

export { formatZodIssues } from "../shared/forcedToolCall.js";
export type { LlmDeps, ParseResult } from "../shared/forcedToolCall.js";

export type CourseRole = "expand" | "projects";

export function resolveCourseDeps(role: CourseRole): LlmDeps {
  if (!hasOpenAICompatProvider()) {
    throw new ApiError(503, "Course generation needs an OpenAI-compatible LLM provider (vercel or openai).");
  }
  const override = role === "expand" ? env.COURSE_EXPAND_MODEL : env.PROJECT_PLANNER_MODEL;
  return { model: override ?? env.COURSE_MAKER_MODEL ?? getModelName() };
}

export type CourseToolCallOptions<T> = Omit<ForcedToolCallOptions<T>, "maxTokens" | "label">;

export function runForcedToolCall<T>(opts: CourseToolCallOptions<T>): Promise<T> {
  return runSharedForcedToolCall({
    ...opts,
    maxTokens: env.COURSE_MAX_OUTPUT_TOKENS,
    label: "Course generation",
  });
}
