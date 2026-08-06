import type OpenAI from "openai";
import { vi } from "vitest";
import type { LlmDeps } from "../../src/agents/shared/forcedToolCall.js";

/**
 * Fake OpenAI-compatible client for the forced-tool-call agents — queue one
 * response per expected call. (course-maker.test.ts and lecture-maker.test.ts
 * carry their own older copies of these.)
 */
export function fakeDeps(...responses: unknown[]) {
  const create = vi.fn();
  for (const r of responses) create.mockResolvedValueOnce(r);
  const client = { chat: { completions: { create } } } as unknown as OpenAI;
  return { deps: { client, model: "fake/model" } as LlmDeps, create };
}

export function toolCallResponse(name: string, args: unknown, finishReason = "tool_calls") {
  return {
    choices: [
      {
        finish_reason: finishReason,
        message: {
          content: null,
          tool_calls: [
            { id: "call_1", type: "function", function: { name, arguments: JSON.stringify(args) } },
          ],
        },
      },
    ],
  };
}

export function textResponse(text: string) {
  return { choices: [{ finish_reason: "stop", message: { content: text } }] };
}

/** All messages sent on the given create() call, JSON-stringified for content asserts. */
export function sentMessages(create: ReturnType<typeof vi.fn>, callIndex: number): string {
  return JSON.stringify(create.mock.calls[callIndex]?.[0]?.messages ?? []);
}
