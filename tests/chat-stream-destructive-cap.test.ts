import { describe, expect, it, vi } from "vitest";
import type { RegisteredTool } from "../src/agents/tools/types.js";

/**
 * Reproduces the bug reported in chat: the model bundled far more
 * delete_routine_item calls into a single turn than the student ever
 * confirmed, and the tool-execution loop ran every single one — first
 * dozens of failed calls with a bad id, then (once it had real ids from
 * list_routine) a batch that deleted most of the routine.
 *
 * This drives streamChatAgent() directly with a fake OpenAI-compatible client
 * that emits an oversized batch of delete_routine_item calls in one
 * completion, and asserts the MAX_DESTRUCTIVE_CALLS_PER_TURN cap in
 * stream.ts stops the underlying tool from running past the limit — without
 * touching Mongo or a real model.
 */

const deleteRun = vi.fn(async (_ctx, args: Record<string, unknown>) => ({
  ok: true,
  changed: "routine" as const,
  label: `"${args.itemId}" removed from routine`,
  modelText: `Deleted routine item ${String(args.itemId)}.`,
}));

const deleteRoutineItemTool: RegisteredTool = {
  schema: {
    type: "function",
    function: {
      name: "delete_routine_item",
      description: "test stub",
      parameters: { type: "object", properties: { itemId: { type: "string" } } },
    },
  },
  runningLabel: () => "Deleting routine item",
  run: deleteRun,
};

vi.mock("../src/agents/tools/registry.js", () => ({
  buildToolset: () => new Map([["delete_routine_item", deleteRoutineItemTool]]),
}));

// The router's LLM-based classifier would otherwise fire a second model call
// before the main loop even starts; skipping it keeps the fake client's
// scripted responses aligned with the tool-calling loop under test.
vi.mock("../src/agents/chat-agent/router.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agents/chat-agent/router.js")>();
  return { ...actual, classifyCourseIntent: vi.fn().mockResolvedValue(null) };
});

/** One streamed chunk carrying a full batch of tool_calls in a single delta —
 *  valid because the accumulator in stream.ts just concatenates per-index
 *  strings, and a one-shot chunk already has everything in one piece. */
function toolCallChunk(calls: Array<{ id: string; name: string; args: string }>) {
  return {
    choices: [
      {
        delta: {
          tool_calls: calls.map((c, index) => ({
            index,
            id: c.id,
            function: { name: c.name, arguments: c.args },
          })),
        },
      },
    ],
  };
}

function contentChunk(text: string) {
  return { choices: [{ delta: { content: text } }] };
}

function asyncIterableOf(chunks: unknown[]) {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const c of chunks) yield c;
    },
  };
}

vi.mock("../src/agents/llm.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agents/llm.js")>();

  // Turn 1: a burst of 10 delete_routine_item calls with bad-looking ids —
  // stands in for the observed "hallucinated batch" turn. Turn 2: a plain
  // text answer, ending the loop.
  const create = vi
    .fn()
    .mockResolvedValueOnce(
      asyncIterableOf([
        toolCallChunk(
          Array.from({ length: 10 }, (_, i) => ({
            id: `call_${i}`,
            name: "delete_routine_item",
            args: JSON.stringify({ itemId: `item-${i}` }),
          })),
        ),
      ]),
    )
    .mockResolvedValueOnce(asyncIterableOf([contentChunk("Done.")]));

  return {
    ...actual,
    getOpenAICompatClient: () => ({
      client: { chat: { completions: { create } } },
      model: "test-model",
    }),
  };
});

const { streamChatAgent } = await import("../src/agents/chat-agent/stream.js");

describe("streamChatAgent destructive-call cap", () => {
  it("stops delete_routine_item after MAX_DESTRUCTIVE_CALLS_PER_TURN, even when the model requests far more in one batch", async () => {
    const events = [];
    for await (const ev of streamChatAgent([], "delete this from my routine, please", {
      userId: "u1",
    })) {
      events.push(ev);
    }

    const results = events.filter((e) => e.type === "tool_result") as Array<{
      type: "tool_result";
      ok: boolean;
      label: string;
    }>;

    expect(results).toHaveLength(10);

    // Only the first few actually reached the tool implementation...
    expect(deleteRun).toHaveBeenCalledTimes(3);

    // ...the rest were short-circuited before touching the database, with a
    // result the model (and, through it, the student) can see clearly.
    const ran = results.slice(0, 3);
    const blocked = results.slice(3);
    expect(ran.every((r) => r.ok)).toBe(true);
    expect(blocked.every((r) => r.ok === false)).toBe(true);
    expect(blocked.every((r) => r.label === "Stopped — too many deletions in one turn")).toBe(true);
  });
});
