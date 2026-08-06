import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { ChatAnthropic } from "@langchain/anthropic";
import { ChatOpenAI } from "@langchain/openai";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import OpenAI from "openai";
import { env } from "../config/env.js";
import { ApiError } from "../utils/apiError.js";

const DEFAULT_MODELS = {
  anthropic: "claude-sonnet-4-5",
  openai: "gpt-5.6-luna",
  google: "gemini-2.0-flash",
  openrouter: "openai/gpt-5.6-luna",
  // The -free variant cannot make tool calls (probed 2026-07-23), and every
  // agent here forces one, so the paid model is the only usable default.
  tokenrouter: "openai/gpt-5.6-luna",
} as const;

/** OpenAI-compatible providers that route through a custom base URL + key. */
const OPENAI_COMPAT: Partial<Record<string, { baseURL: string; key: () => string }>> = {
  openrouter: { baseURL: "https://openrouter.ai/api/v1", key: () => requireKey(env.OPENROUTER_API_KEY, "OPENROUTER_API_KEY") },
  tokenrouter: { baseURL: "https://api.tokenrouter.com/v1", key: () => requireKey(env.TOKENROUTER_API_KEY, "TOKENROUTER_API_KEY") },
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
      });
    case "google":
      return new ChatGoogleGenerativeAI({
        model,
        apiKey: requireKey(env.GOOGLE_API_KEY, "GOOGLE_API_KEY"),
      });
    case "openrouter":
    case "tokenrouter": {
      // Both are OpenAI-compatible; model names are namespaced (e.g. "z-ai/glm-5.2").
      const compat = OPENAI_COMPAT[env.LLM_PROVIDER]!;
      return new ChatOpenAI({
        model,
        apiKey: compat.key(),
        configuration: { baseURL: compat.baseURL },
      });
    }
  }
}

/** The resolved model id for the active provider. */
export function getModelName(): string {
  return env.LLM_MODEL ?? DEFAULT_MODELS[env.LLM_PROVIDER];
}

/**
 * Returns a raw OpenAI-compatible client for streaming with reasoning tokens.
 * Only openai / openrouter expose reasoning deltas this way; other providers
 * return null and callers fall back to LangChain content-only streaming.
 */
export function getOpenAICompatClient(): { client: OpenAI; model: string } | null {
  const model = getModelName();
  const compat = OPENAI_COMPAT[env.LLM_PROVIDER];
  if (compat) {
    return { client: new OpenAI({ apiKey: compat.key(), baseURL: compat.baseURL }), model };
  }
  if (env.LLM_PROVIDER === "openai") {
    return {
      client: new OpenAI({ apiKey: requireKey(env.OPENAI_API_KEY, "OPENAI_API_KEY") }),
      model,
    };
  }
  return null;
}
