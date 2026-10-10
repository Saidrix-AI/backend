import { AIMessage } from "@langchain/core/messages";
import type { ChatOpenAI } from "@langchain/openai";
import type OpenAI from "openai";
import { vi } from "vitest";
import type { LlmDeps } from "../../src/agents/shared/forcedToolCall.js";

/**
 * Fake chat model for the forced-tool-call agents — queue one reply per
 * expected call. (course-maker.test.ts and lecture-maker.test.ts carry their
 * own older copies of these.)
 *
 * The runner calls `bindTools(...).invoke(messages, options)`, so the spy sits
 * on `invoke` and every bindTools() hands back the same one. It is still named
 * `create` for the assertions that were written against the OpenAI client.
 */
export function fakeDeps(...responses: unknown[]) {
  const invoke = vi.fn();
  for (const r of responses) invoke.mockResolvedValueOnce(r);
  // Spied too: the tool schema no longer travels with the request body, so a
  // test that asserts on it reads bindTools' arguments instead of invoke's.
  const bindTools = vi.fn(() => ({ invoke }));
  const chat = { bindTools } as unknown as ChatOpenAI;
  return { deps: { model: "fake/model", chat } as LlmDeps, create: invoke, bindTools };
}

/**
 * Fake chat model that answers based on WHAT WAS ASKED rather than on call
 * order.
 *
 * `fakeDeps` serves a fixed queue, which is exact for a sequential stage and
 * meaningless for a concurrent one: the per-topic writers all issue their first
 * request in the same tick, so whichever the event loop reaches first takes
 * response #1. A test that queued "topic 1's answer, topic 2's answer" was
 * really asserting on scheduling order, and passed or failed for reasons that
 * had nothing to do with the code under test.
 *
 * `route` receives the flattened text of every message in the request, so a
 * test can match on the marker the prompt already carries ("Topic 2:"), plus a
 * 0-based index of how many calls this fake has served.
 */
export function fakeRoutingDeps(route: (userText: string, callIndex: number) => unknown) {
  let served = 0;
  const invoke = vi.fn(async (messages: unknown) => route(flattenMessages(messages), served++));
  const bindTools = vi.fn(() => ({ invoke }));
  const chat = { bindTools } as unknown as ChatOpenAI;
  return { deps: { model: "fake/model", chat } as LlmDeps, create: invoke, bindTools };
}

/** Every message's text content in one string, for `route` to match against. */
function flattenMessages(messages: unknown): string {
  if (!Array.isArray(messages)) return "";
  return messages
    .map((m) => {
      const content = (m as { content?: unknown })?.content;
      return typeof content === "string" ? content : JSON.stringify(content ?? "");
    })
    .join("\n");
}

/** The tool schema handed to bindTools on the given call. */
export function boundTool(bindTools: ReturnType<typeof vi.fn>, callIndex = 0): OpenAI.Chat.ChatCompletionFunctionTool {
  return bindTools.mock.calls[callIndex]?.[0]?.[0] as OpenAI.Chat.ChatCompletionFunctionTool;
}

/** A model reply that makes one tool call, as LangChain hands it to the runner. */
export function toolCallResponse(name: string, args: unknown, finishReason = "tool_calls") {
  return new AIMessage({
    content: "",
    tool_calls: [{ id: "call_1", name, args: (args ?? {}) as Record<string, unknown>, type: "tool_call" }],
    response_metadata: { finish_reason: finishReason },
  });
}

/** A model reply that answers in prose instead of calling the tool. */
export function textResponse(text: string) {
  return new AIMessage({ content: text, response_metadata: { finish_reason: "stop" } });
}

/** All messages sent on the given invoke() call, JSON-stringified for content asserts. */
export function sentMessages(create: ReturnType<typeof vi.fn>, callIndex: number): string {
  return JSON.stringify(create.mock.calls[callIndex]?.[0] ?? []);
}
