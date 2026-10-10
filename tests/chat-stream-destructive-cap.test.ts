import { AIMessageChunk } from "@langchain/core/messages";
import { describe, expect, it, vi } from "vitest";
import type { RegisteredTool } from "../src/agents/tools/types.js";

/**
 * Reproduces the bug reported in chat: the model bundled far more
 * delete_routine_item calls into a single turn than the student ever
 * confirmed, and the tool-execution loop ran every single one — first
 * dozens of failed calls with a bad id, then (once it had real ids from
 * list_routine) a batch that deleted most of the routine.
 *
 * A later report showed the guard itself misbehaving: a student who asked to
 * clear their whole routine got three deletions and then forty-odd identical
 * "Stopped — too many deletions in one turn" chips, because every blocked call
 * rendered its own result and the model kept re-issuing the batch. So this also
 * pins the SHAPE of the refusal: one notice, and no further tool rounds.
 *
 * Drives streamChatAgent() directly with a fake OpenAI-compatible client, so
 * there is no Mongo and no real model.
 */

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  // tool_choice rides on bindTools now, not on the streamed request body, so
  // the assertions about forcing/disabling tools read this spy.
  bindTools: vi.fn(),
  deleteRun: vi.fn(),
  deleteManyRun: vi.fn(),
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
  run: mocks.deleteRun,
};

const deleteRoutineItemsTool: RegisteredTool = {
  schema: {
    type: "function",
    function: {
      name: "delete_routine_items",
      description: "test stub",
      parameters: { type: "object", properties: { itemIds: { type: "array" } } },
    },
  },
  runningLabel: () => "Removing routine items",
  run: mocks.deleteManyRun,
};

vi.mock("../src/agents/tools/registry.js", () => ({
  buildToolset: () =>
    new Map([
      ["delete_routine_item", deleteRoutineItemTool],
      ["delete_routine_items", deleteRoutineItemsTool],
    ]),
}));

// The router's LLM-based classifier would otherwise fire a second model call
// before the main loop even starts; skipping it keeps the fake client's
// scripted responses aligned with the tool-calling loop under test.
vi.mock("../src/agents/chat-agent/router.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agents/chat-agent/router.js")>();
  return { ...actual, classifyCourseIntent: vi.fn().mockResolvedValue(null) };
});

/** One streamed chunk carrying a full batch of tool calls in a single delta —
 *  valid because the accumulator in stream.ts just concatenates per-index
 *  strings, and a one-shot chunk already has everything in one piece. */
function toolCallChunk(calls: Array<{ id: string; name: string; args: string }>) {
  return new AIMessageChunk({
    content: "",
    tool_call_chunks: calls.map((c, index) => ({
      index,
      id: c.id,
      name: c.name,
      args: c.args,
      type: "tool_call_chunk" as const,
    })),
  });
}

function contentChunk(text: string) {
  return new AIMessageChunk({ content: text });
}

function asyncIterableOf(chunks: unknown[]) {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const c of chunks) yield c;
    },
  };
}

// stream.ts streams through LangChain now: bindTools(...).stream(messages).
// Both shapes point at the same spy, since a turn with no tools registered
// streams straight off the model.
vi.mock("../src/agents/llm.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agents/llm.js")>();
  return {
    ...actual,
    getChatModelFor: () => ({ stream: mocks.create, bindTools: mocks.bindTools }),
  };
});

const { streamChatAgent } = await import("../src/agents/chat-agent/stream.js");

type ToolResult = { type: "tool_result"; ok: boolean; label: string; name: string };

async function collect(message: string) {
  const events = [];
  for await (const ev of streamChatAgent([], message, { userId: "u1" })) events.push(ev);
  return events;
}

function reset() {
  mocks.create.mockReset();
  mocks.bindTools.mockReset().mockImplementation(() => ({ stream: mocks.create }));
  mocks.deleteRun.mockReset().mockImplementation(async (_ctx, args: Record<string, unknown>) => ({
    ok: true,
    changed: "routine" as const,
    label: `"${String(args.itemId)}" removed from routine`,
    modelText: `Deleted routine item ${String(args.itemId)}.`,
  }));
  mocks.deleteManyRun
    .mockReset()
    .mockImplementation(async (_ctx, args: Record<string, unknown>) => ({
      ok: true,
      changed: "routine" as const,
      label: `${(args.itemIds as string[]).length} routine items removed`,
      modelText: `Deleted ${(args.itemIds as string[]).length} routine items.`,
    }));
}

describe("streamChatAgent destructive-call cap", () => {
  it("runs only MAX_DESTRUCTIVE_CALLS_PER_TURN of an oversized batch", async () => {
    reset();
    mocks.create
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

    const events = await collect("delete this from my routine, please");
    const results = events.filter((e) => e.type === "tool_result") as ToolResult[];

    // Only the first few reached the tool implementation.
    expect(mocks.deleteRun).toHaveBeenCalledTimes(3);
    expect(results.filter((r) => r.ok)).toHaveLength(3);
  });

  // The regression behind the forty-odd identical chips.
  it("shows the refusal ONCE however many calls are blocked", async () => {
    reset();
    mocks.create
      .mockResolvedValueOnce(
        asyncIterableOf([
          toolCallChunk(
            Array.from({ length: 50 }, (_, i) => ({
              id: `call_${i}`,
              name: "delete_routine_item",
              args: JSON.stringify({ itemId: `item-${i}` }),
            })),
          ),
        ]),
      )
      .mockResolvedValueOnce(asyncIterableOf([contentChunk("I stopped after three.")]));

    const events = await collect("clear my whole routine");
    const results = events.filter((e) => e.type === "tool_result") as ToolResult[];
    const blocked = results.filter((r) => r.label === "Stopped — too many deletions in one turn");

    expect(blocked).toHaveLength(1);
    // 47 blocked calls must not each announce themselves.
    expect(results).toHaveLength(4);
    // And no "running" chip for work that never ran.
    expect(events.filter((e) => e.type === "tool_call")).toHaveLength(3);
  });

  // Without this the model spends its remaining iterations re-issuing the
  // batch it was just refused.
  it("ends the tool phase once the cap trips", async () => {
    reset();
    mocks.create
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
      .mockResolvedValueOnce(asyncIterableOf([contentChunk("Stopped after three.")]));

    await collect("delete everything");

    expect(mocks.create).toHaveBeenCalledTimes(2);
    const followUp = mocks.bindTools.mock.calls[1]![1] as { tool_choice?: unknown };
    expect(followUp.tool_choice).toBe("none");
  });

  // The capability gap that caused the incident: "delete all" had to be N calls.
  it("lets one bulk call remove far more than the per-call cap", async () => {
    reset();
    const itemIds = Array.from({ length: 40 }, (_, i) => `item-${i}`);
    mocks.create
      .mockResolvedValueOnce(
        asyncIterableOf([
          toolCallChunk([
            { id: "call_bulk", name: "delete_routine_items", args: JSON.stringify({ itemIds }) },
          ]),
        ]),
      )
      .mockResolvedValueOnce(asyncIterableOf([contentChunk("Cleared.")]));

    const events = await collect("yes, clear all 40");
    const results = events.filter((e) => e.type === "tool_result") as ToolResult[];

    expect(mocks.deleteManyRun).toHaveBeenCalledTimes(1);
    expect(mocks.deleteManyRun.mock.calls[0]![1]).toEqual({ itemIds });
    expect(results).toHaveLength(1);
    expect(results[0]!.ok).toBe(true);
    // One call, so the cap is nowhere near — and the turn is not halted.
    expect(results[0]!.label).not.toContain("Stopped");
  });
});
