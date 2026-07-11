import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { ChatAnthropic } from "@langchain/anthropic";
import { ChatOpenAI } from "@langchain/openai";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { env } from "../config/env.js";
import { ApiError } from "../utils/apiError.js";

const DEFAULT_MODELS = {
  anthropic: "claude-sonnet-4-5",
  openai: "gpt-4o-mini",
  google: "gemini-2.0-flash",
} as const;

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
  }
}
