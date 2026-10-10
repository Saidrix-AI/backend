import { afterEach, describe, expect, it } from "vitest";
import { getChatModelFor, reasoningParams } from "../src/agents/llm.js";
import { env } from "../src/config/env.js";
import { boundTool, fakeDeps, toolCallResponse } from "./helpers/fakeLlm.js";

/*
 * Regression guard for the 2026-08-06 outage: on TokenRouter, gpt-5.x refuses
 * function tools unless reasoning_effort is "none" —
 *   "Function tools with reasoning_effort are not supported for gpt-5.6-luna
 *    in /v1/chat/completions."
 * Every agent here forces a tool call, so dropping this field takes down course
 * generation, the lecture pipeline, intake, the profilers and the chat agent's
 * tool turns all at once.
 */

const original = env.LLM_REASONING_EFFORT;
const originalProvider = env.LLM_PROVIDER;
const originalKey = env.OPENAI_API_KEY;

afterEach(() => {
  env.LLM_REASONING_EFFORT = original;
  env.LLM_PROVIDER = originalProvider;
  env.OPENAI_API_KEY = originalKey;
});

/**
 * tests/setup.ts forces LLM_PROVIDER=google so no test can reach a real
 * provider by accident, and getChatModelFor returns null for it. These
 * assertions are about how the model is BUILT, so they need a provider that
 * builds one — openai, which needs no compat base URL or shared key.
 */
function withOpenAIProvider(): void {
  env.LLM_PROVIDER = "openai";
  env.OPENAI_API_KEY = "test-key";
}

describe("reasoningParams", () => {
  it("sends none for the dotted gpt-5.N family, namespaced or bare", () => {
    expect(reasoningParams("openai/gpt-5.6-luna")).toEqual({ reasoning_effort: "none" });
    expect(reasoningParams("gpt-5.6-luna")).toEqual({ reasoning_effort: "none" });
    expect(reasoningParams("openai/gpt-5.2")).toEqual({ reasoning_effort: "none" });
  });

  it("sends nothing for models that reject the field or reject 'none'", () => {
    // gpt-4o-mini rejects reasoning_effort outright; plain gpt-5 / gpt-5-mini
    // reject "none" specifically (their floor is "minimal").
    expect(reasoningParams("openai/gpt-4o-mini")).toEqual({});
    expect(reasoningParams("openai/gpt-5-mini")).toEqual({});
    expect(reasoningParams("z-ai/glm-5.2")).toEqual({});
    expect(reasoningParams("claude-sonnet-4-5")).toEqual({});
  });

  it("lets LLM_REASONING_EFFORT override the derivation in both directions", () => {
    env.LLM_REASONING_EFFORT = "low";
    expect(reasoningParams("openai/gpt-5.6-luna")).toEqual({ reasoning_effort: "low" });
    expect(reasoningParams("openai/gpt-4o-mini")).toEqual({ reasoning_effort: "low" });
  });
});

/*
 * The shared runner builds its model through getChatModelFor, which is where
 * the effort is now attached — as modelKwargs on the LangChain model rather
 * than a field the runner spreads into a hand-built request body. Asserting on
 * the model is the same guard one layer up: every forced tool call in the
 * project goes through this factory.
 */
describe("the shared runner's model carries the effort", () => {
  it("includes reasoning_effort for gpt-5.x", () => {
    withOpenAIProvider();
    expect(getChatModelFor("openai/gpt-5.6-luna", 256)?.modelKwargs).toEqual({ reasoning_effort: "none" });
  });

  it("omits the field for models that would reject it", () => {
    withOpenAIProvider();
    expect(getChatModelFor("openai/gpt-4o-mini", 256)?.modelKwargs ?? {}).not.toHaveProperty("reasoning_effort");
  });

  /*
   * LangChain's default is six automatic retries. shared/llmGate.ts exists
   * because this project's gateway counts failed attempts against the quota,
   * so SDK-level retries would spend a whole rate window on one call and the
   * gate would never see the 429 it is meant to back off from.
   */
  it("leaves retrying to the rate gate", () => {
    withOpenAIProvider();
    // maxRetries lives on the model's AsyncCaller and is not a public field.
    const chat = getChatModelFor("openai/gpt-4o-mini") as unknown as { caller: { maxRetries: number } };
    expect(chat.caller.maxRetries).toBe(1);
  });
});

/*
 * The course outline used to build its own request and needed its own copy of
 * this assertion. It now goes through runForcedToolCall like every other agent,
 * so the model-level checks above cover it — what is worth pinning instead is
 * that it really does route through the shared runner, since that is the only
 * thing keeping the two in step.
 */
describe("course outline goes through the shared runner", () => {
  it("emits through runForcedToolCall rather than its own request", async () => {
    const { generateCoursePayload } = await import("../src/agents/course-maker/generator.js");
    const { deps, bindTools } = fakeDeps(
      toolCallResponse("emit_course", {
        title: "T",
        description: "d",
        level: "Beginner",
        chapters: [{ title: "C", summary: "s" }],
      }),
    );
    // The canned payload may not satisfy zod; the call shape is what matters.
    await generateCoursePayload({ objective: "Python", withProjects: false }, [], deps).catch(
      () => undefined,
    );

    expect(boundTool(bindTools).function.name).toBe("emit_course");
  });
});
