import type OpenAI from "openai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { reasoningParams } from "../src/agents/llm.js";
import { runForcedToolCall } from "../src/agents/shared/forcedToolCall.js";
import { env } from "../src/config/env.js";
import { toolCallResponse } from "./helpers/fakeLlm.js";

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

afterEach(() => {
  env.LLM_REASONING_EFFORT = original;
});

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

describe("forced tool calls carry the effort", () => {
  const TOOL: OpenAI.Chat.ChatCompletionFunctionTool = {
    type: "function",
    function: {
      name: "emit_thing",
      description: "Emit a thing.",
      parameters: { type: "object", required: ["value"], properties: { value: { type: "string" } } },
    },
  };

  async function runWithModel(model: string) {
    const create = vi.fn().mockResolvedValueOnce(toolCallResponse("emit_thing", { value: "ok" }));
    const client = { chat: { completions: { create } } } as unknown as OpenAI;
    await runForcedToolCall({
      deps: { client, model },
      tool: TOOL,
      system: "s",
      user: "u",
      sizeHint: "smaller",
      maxTokens: 256,
      label: "Test generation",
      parse: (raw: unknown) => ({ success: true as const, data: (raw as { value: string }).value }),
    });
    return create.mock.calls[0]?.[0] as Record<string, unknown>;
  }

  it("includes reasoning_effort alongside the tool for gpt-5.x", async () => {
    const body = await runWithModel("openai/gpt-5.6-luna");
    expect(body.reasoning_effort).toBe("none");
    expect(body.tools).toHaveLength(1);
  });

  it("omits the field for models that would reject it", async () => {
    const body = await runWithModel("openai/gpt-4o-mini");
    expect(body).not.toHaveProperty("reasoning_effort");
  });
});

/* The course outline predates the shared runner and builds its own request. */
describe("course outline carries the effort", () => {
  it("includes reasoning_effort alongside emit_course for gpt-5.x", async () => {
    const { generateCoursePayload } = await import("../src/agents/course-maker/generator.js");
    const create = vi.fn().mockResolvedValueOnce(
      toolCallResponse("emit_course", {
        title: "T",
        description: "d",
        level: "Beginner",
        chapters: [{ title: "C", summary: "s" }],
      }),
    );
    const client = { chat: { completions: { create } } } as unknown as OpenAI;
    await generateCoursePayload(
      { objective: "Python", withProjects: false },
      [],
      { client, model: "openai/gpt-5.6-luna" },
    ).catch(() => undefined); // the canned payload may not satisfy zod; the request is what matters

    const body = create.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body.reasoning_effort).toBe("none");
    expect(body.tools).toHaveLength(1);
  });
});
