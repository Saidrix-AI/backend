import { AIMessageChunk } from "@langchain/core/messages";
import { describe, expect, it, vi } from "vitest";

/*
 * The chat model streams no reasoning (reasoning_effort is "none" on gpt-5.x),
 * so before the first answer token the student saw nothing but an empty
 * "Thinking…" — while the intent router was doing real work. The router round
 * now announces itself as a `status` step the client draws in its timeline.
 */

const mocks = vi.hoisted(() => ({ create: vi.fn(), classify: vi.fn() }));

vi.mock("../src/agents/tools/registry.js", () => ({
  buildToolset: () => new Map(),
  SEARCH_COURSE_CONTENT_TOOL_NAME: "search_course_content",
}));

vi.mock("../src/agents/chat-agent/router.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agents/chat-agent/router.js")>();
  return { ...actual, classifyCourseIntent: mocks.classify };
});

vi.mock("../src/agents/llm.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agents/llm.js")>();
  return {
    ...actual,
    getChatModelFor: () => ({
      stream: mocks.create,
      bindTools: () => ({ stream: mocks.create }),
    }),
  };
});

const { streamChatAgent } = await import("../src/agents/chat-agent/stream.js");

function asyncIterableOf(chunks: unknown[]) {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const c of chunks) yield c;
    },
  };
}

async function eventsFor(message: string, userId?: string) {
  mocks.create.mockReset();
  mocks.classify.mockReset().mockResolvedValue(null);
  mocks.create.mockResolvedValueOnce(asyncIterableOf([new AIMessageChunk({ content: "Hello!" })]));
  const out = [];
  for await (const ev of streamChatAgent([], message, { userId })) out.push(ev);
  return out;
}

describe("router status steps", () => {
  it("brackets the router call with running/done before the answer streams", async () => {
    const events = await eventsFor("how are you?", "u1");
    expect(events.map((e) => (e.type === "status" ? `${e.type}:${e.state}` : e.type))).toEqual([
      "status:running",
      "status:done",
      "content",
    ]);
    expect(events[0]).toMatchObject({ id: "route", label: "Understanding your question" });
    expect(mocks.classify).toHaveBeenCalledOnce();
  });

  it("emits nothing extra when no router runs (signed-out / no db tools)", async () => {
    const events = await eventsFor("how are you?");
    expect(events.map((e) => e.type)).toEqual(["content"]);
    expect(mocks.classify).not.toHaveBeenCalled();
  });
});
