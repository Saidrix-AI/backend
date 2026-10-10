import { AIMessageChunk } from "@langchain/core/messages";
import { describe, expect, it, vi } from "vitest";

/*
 * qwen writes its tool calls as `<tool_call>{…}</tool_call>` and the provider's
 * parser normally lifts them into structured calls. A malformed one is left
 * alone and arrives as ordinary content — which is how a bare `<tool_call>`
 * ended up rendered in a student's transcript after three generation failures
 * in a row (2026-08-20).
 *
 * The hard part is not the tag, it is that deltas are token-sized: `<tool_`
 * and `call>` routinely arrive in different chunks, so a per-chunk replace
 * would miss the split ones. These tests cover both, and the case that must NOT
 * be swallowed — a lone `<` that turns out to be real prose.
 */

const mocks = vi.hoisted(() => ({ create: vi.fn() }));

vi.mock("../src/agents/tools/registry.js", () => ({
  buildToolset: () => new Map(),
  SEARCH_COURSE_CONTENT_TOOL_NAME: "search_course_content",
}));

vi.mock("../src/agents/chat-agent/router.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agents/chat-agent/router.js")>();
  return { ...actual, classifyCourseIntent: vi.fn().mockResolvedValue(null) };
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

const chunk = (text: string) => new AIMessageChunk({ content: text });

function asyncIterableOf(chunks: unknown[]) {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const c of chunks) yield c;
    },
  };
}

/** The answer the student would actually see. */
async function answerFor(...deltas: string[]): Promise<string> {
  mocks.create.mockReset();
  mocks.create.mockResolvedValueOnce(asyncIterableOf(deltas.map(chunk)));
  let out = "";
  for await (const ev of streamChatAgent([], "hi", {})) {
    if (ev.type === "content") out += ev.delta;
  }
  return out;
}

describe("tool markup never reaches the transcript", () => {
  it("strips a tag that arrives whole", async () => {
    expect(await answerFor("Here you go. <tool_call> All done.")).toBe("Here you go.  All done.");
  });

  it("strips a tag split across deltas, which is the usual shape", async () => {
    expect(await answerFor("Here you go. <", "tool_", "call", "> All done.")).toBe(
      "Here you go.  All done.",
    );
  });

  it("strips the closing tag and the other models' spellings", async () => {
    expect(await answerFor("a</tool_call>b<|tool_call|>c<function_call>d")).toBe("abcd");
  });

  /*
   * The buffer holds back anything that could still become a tag. If the stream
   * ends while it is holding real text, that text is the answer — dropping it
   * would silently truncate replies that happen to end in "<".
   */
  it("releases a dangling '<' that never became a tag", async () => {
    expect(await answerFor("compare a <")).toBe("compare a <");
  });

  it("leaves ordinary markup alone", async () => {
    expect(await answerFor("use <div> and <b>bold</b>")).toBe("use <div> and <b>bold</b>");
  });

  it("passes a plain answer through untouched", async () => {
    expect(await answerFor("A closure ", "remembers its ", "scope.")).toBe(
      "A closure remembers its scope.",
    );
  });
});
