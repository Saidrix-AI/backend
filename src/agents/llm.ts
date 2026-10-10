import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { ChatAnthropic } from "@langchain/anthropic";
import { ChatOpenAI } from "@langchain/openai";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { env } from "../config/env.js";
import { ApiError } from "../utils/apiError.js";

const DEFAULT_MODELS = {
  anthropic: "claude-sonnet-4-5",
  openai: "gpt-5.6-luna",
  google: "gemini-2.0-flash",
  // Free-tier gateway accounts cannot call luna; gpt-5.4-nano is the newest
  // OpenAI model they can (probed 2026-10-09).
  vercel: "openai/gpt-5.4-nano",
} as const;

/** OpenAI-compatible providers that route through a custom base URL + key. */
const OPENAI_COMPAT: Partial<Record<string, { baseURL: string; key: () => string }>> = {
  vercel: { baseURL: "https://ai-gateway.vercel.sh/v1", key: () => requireKey(env.AI_GATEWAY_API_KEY, "AI_GATEWAY_API_KEY") },
};

function requireKey(key: string | undefined, name: string): string {
  if (!key) {
    throw new ApiError(500, `${name} is not configured for the selected LLM provider`);
  }
  return key;
}

/** Provider-agnostic chat model factory. Swap providers via LLM_PROVIDER env var. */
export function getChatModel(): BaseChatModel {
  const model = env.LLM_MODEL ?? DEFAULT_MODELS[env.LLM_PROVIDER];

  switch (env.LLM_PROVIDER) {
    case "anthropic":
      return new ChatAnthropic({
        model,
        apiKey: requireKey(env.ANTHROPIC_API_KEY, "ANTHROPIC_API_KEY"),
      });
    case "openai":
      return new ChatOpenAI({
        model,
        apiKey: requireKey(env.OPENAI_API_KEY, "OPENAI_API_KEY"),
        modelKwargs: reasoningParams(model),
      });
    case "google":
      return new ChatGoogleGenerativeAI({
        model,
        apiKey: requireKey(env.GOOGLE_API_KEY, "GOOGLE_API_KEY"),
      });
    case "vercel": {
      // OpenAI-compatible; model names are namespaced (e.g. "openai/gpt-5.4-nano").
      const compat = OPENAI_COMPAT[env.LLM_PROVIDER]!;
      return new ChatOpenAI({
        model,
        apiKey: compat.key(),
        configuration: { baseURL: compat.baseURL },
        modelKwargs: reasoningParams(model),
      });
    }
  }
}

/** The resolved model id for the active provider. */
export function getModelName(): string {
  return env.LLM_MODEL ?? DEFAULT_MODELS[env.LLM_PROVIDER];
}

/**
 * gpt-5.x refuses function tools on /v1/chat/completions unless reasoning is
 * off: "Function tools with reasoning_effort are not supported ... use
 * /v1/responses or set reasoning_effort to 'none'". Every agent here forces a
 * tool call, so without this the whole generation stack 400s.
 *
 * Probed against TokenRouter 2026-08-06 with a forced tool call:
 *   field absent -> 400   "minimal" -> 400 (unsupported value)   "none" -> 200
 * OpenRouter routes gpt-5.x to the Responses API itself and works either way,
 * so sending "none" there is a no-op, not a regression.
 *
 * Gated on the dotted gpt-5.N family on purpose: plain gpt-5 / gpt-5-mini
 * reject "none" (their floor is "minimal"), and non-reasoning models such as
 * gpt-4o-mini reject the field outright.
 */
const DOTTED_GPT5 = /(^|\/)gpt-5\.\d/i;

/*
 * Returns a spreadable body fragment, not a typed field: the openai SDK's
 * `ReasoningEffort` still reads 'minimal' | 'low' | 'medium' | 'high' and has
 * no 'none' or 'xhigh', so a precise type would not fit into the request
 * params. Same escape hatch the `include_reasoning` spread in stream.ts uses.
 */
export function reasoningParams(model: string): Record<string, unknown> {
  const effort = env.LLM_REASONING_EFFORT ?? (DOTTED_GPT5.test(model) ? "none" : undefined);
  return effort ? { reasoning_effort: effort } : {};
}

/**
 * A LangChain chat model bound to ONE named model id on the active provider.
 *
 * `getChatModel()` resolves the model from env, which is right for the chat
 * agent but wrong for the generation pipeline: every role there picks its own
 * (LECTURE_PLANNER_MODEL, COURSE_EXPAND_MODEL, LECTURE_SVG_MODEL, …), so the
 * caller has to name it. Returns null for providers with no OpenAI-compatible
 * endpoint, so the 503 guards in the agents' resolveXDeps read the same way
 * they always did (see hasOpenAICompatProvider below).
 *
 * `maxRetries: 1` is deliberate and must not be raised. LangChain's default is
 * SIX, and shared/llmGate.ts exists because this project's gateway counts
 * failed attempts against the quota — six automatic retries behind a 10/min cap
 * would spend the whole window on one call. Retrying is the gate's job, not the
 * SDK's.
 */
export function getChatModelFor(
  model: string,
  maxTokens?: number,
  extra?: { temperature?: number; modelKwargs?: Record<string, unknown> },
): ChatOpenAI | null {
  const { modelKwargs: extraKwargs, ...rest } = extra ?? {};
  const shared = {
    model,
    maxTokens,
    maxRetries: 1,
    // Merged, never replaced: reasoningParams is what keeps gpt-5.x accepting
    // function tools at all, so a caller adding its own kwarg must not drop it.
    modelKwargs: { ...reasoningParams(model), ...extraKwargs },
    ...rest,
  };
  const compat = OPENAI_COMPAT[env.LLM_PROVIDER];
  if (compat) {
    return new ChatOpenAI({
      ...shared,
      apiKey: compat.key(),
      configuration: { baseURL: compat.baseURL },
    });
  }
  if (env.LLM_PROVIDER === "openai") {
    return new ChatOpenAI({ ...shared, apiKey: requireKey(env.OPENAI_API_KEY, "OPENAI_API_KEY") });
  }
  return null;
}

/**
 * Whether the active provider speaks the OpenAI chat-completions dialect the
 * agent layer is built on (forced tool calls, streamed tool-call deltas).
 *
 * The generation agents refuse to run without it — anthropic and google reach
 * the chat agent's LangChain fallback instead, which answers but cannot use
 * tools. Replaces getOpenAICompatClient(), which the resolvers had been calling
 * purely for this yes/no and then throwing the client away.
 */
export function hasOpenAICompatProvider(): boolean {
  return Boolean(OPENAI_COMPAT[env.LLM_PROVIDER]) || env.LLM_PROVIDER === "openai";
}
