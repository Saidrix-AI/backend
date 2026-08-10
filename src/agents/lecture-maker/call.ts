import { env } from "../../config/env.js";
import { ApiError } from "../../utils/apiError.js";
import { getOpenAICompatClient } from "../llm.js";
import {
  runForcedToolCall as runSharedForcedToolCall,
  type ForcedToolCallOptions,
  type LlmDeps,
} from "../shared/forcedToolCall.js";

/**
 * The lecture-maker's LLM boundary: role → model resolution, plus the shared
 * forced-tool-call runner pre-bound to this agent's output cap and label.
 */

export { formatZodIssues } from "../shared/forcedToolCall.js";
export type { LlmDeps, ParseAttempt, ParseResult } from "../shared/forcedToolCall.js";

export type LectureRole = "classifier" | "analyst" | "planner" | "worker" | "svg" | "resources";

/**
 * Default svg-worker model, namespaced per provider.
 *
 * Drawing a correct diagram is a spatial-reasoning task — SVGenius found
 * reasoning-trained models beat pure scaling on it, and on a "function scope
 * nests inside global scope" brief claude-sonnet-5 drew 4 nested boxes with 15
 * labels where gpt-4o managed 2 boxes with 5. But the render→measure→fix→vision
 * loop now cleans up a weaker drawing, so the cheap model is the better default:
 * a much lower per-diagram cost for a quality gap the pipeline closes anyway.
 * Override with LECTURE_SVG_MODEL to trade cost back for a stronger first draft.
 *
 * NOTE: this value is also the last fallback for the vision critic
 * (visionCritic.ts). gpt-4o-mini accepts images, so that fallback still
 * *functions* — but it is a weak critic (it missed an obviously clipped label
 * in testing), which is why the critic reads LECTURE_SVG_VISION_MODEL first and
 * the deploy sets it to google/gemini-2.5-flash. Leaving both unset gets a
 * cheap-but-dull critic, not a broken one.
 */
export function svgDefaultModel(provider: string): string {
  return provider === "openrouter" ? "openai/gpt-5.6-luna" : "gpt-5.6-luna";
}

export function resolveLectureDeps(role: LectureRole): LlmDeps {
  const oai = getOpenAICompatClient();
  if (!oai) {
    throw new ApiError(503, "Lecture generation needs an OpenAI-compatible LLM provider (openai or openrouter).");
  }
  // The analyst is one short call whose output sets the quality ceiling for the
  // whole lecture, so it is the cheapest place to buy a stronger model —
  // LECTURE_ANALYST_MODEL exists for that, and falls back to LLM_MODEL.
  const model =
    role === "classifier"
      ? // A two-way sort with a written-out rule for each side. The default
        // model does it well, and it runs on every lesson — so it is the one
        // role where an upgrade is pure cost.
        (env.LECTURE_CLASSIFIER_MODEL ?? oai.model)
      : role === "analyst"
      ? (env.LECTURE_ANALYST_MODEL ?? oai.model)
      : role === "planner"
        ? (env.LECTURE_PLANNER_MODEL ?? oai.model)
        : role === "worker"
          ? (env.LECTURE_WORKER_MODEL ?? oai.model)
          : role === "resources"
            ? // Ranking a supplied list is the easiest job in the pipeline — it
              // cannot author a link, only choose among ours — so the default
              // model is ample and an upgrade buys nothing.
              (env.LECTURE_RESOURCES_MODEL ?? oai.model)
            : (env.LECTURE_SVG_MODEL ?? svgDefaultModel(env.LLM_PROVIDER));
  return { client: oai.client, model };
}

/** `maxTokens` and `timeoutMs` may be overridden per role; the label is fixed. */
export type LectureToolCallOptions<T> = Omit<ForcedToolCallOptions<T>, "maxTokens" | "label"> &
  Partial<Pick<ForcedToolCallOptions<T>, "maxTokens">>;

export function runForcedToolCall<T>(opts: LectureToolCallOptions<T>): Promise<T> {
  return runSharedForcedToolCall({
    ...opts,
    maxTokens: opts.maxTokens ?? env.LECTURE_MAX_OUTPUT_TOKENS,
    label: "Lecture generation",
  });
}
