import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type OpenAI from "openai";
import type { LessonContext } from "../src/agents/lecture-maker/prompt.js";

/**
 * How the Resources section joins the assembled lecture.
 *
 * Every case here defends the same rule: the resources step must be able to
 * fail in any way at all without costing the student their lecture. It runs
 * inside the pipeline's `Promise.all`, which is exactly where a rejection would
 * otherwise take everything down with it.
 *
 * Lives in its own file because it must mock `./resources.js` and the env flag
 * before `index.ts` is imported — lecture-maker.test.ts imports makeLecture
 * statically and covers the feature-off path.
 */

const CTX: LessonContext = {
  lessonId: "l1",
  courseTitle: "Algorithms",
  courseDesc: "",
  level: "Beginner",
  chapterTitle: "Search",
  moduleTitle: "Binary search",
  topicTitle: "Halving a sorted range",
  siblingTopics: [],
};

const BLUEPRINT = {
  scope: "Binary search halves a sorted range.",
  objectives: ["Trace binary search"],
  assumedKnowledge: [],
  concepts: [{ name: "Halving", why: "It is the idea", hardBecause: "" }],
  examples: [{ name: "phone-book", scenario: "Finding a name", teaches: "" }],
  misconceptions: [],
  visuals: [],
  outOfScope: [],
  currency: [],
};

const RESOURCES = {
  block: {
    type: "resources" as const,
    intro: "A few free places to go next.",
    links: [
      {
        kind: "doc" as const,
        title: "Binary search",
        url: "https://en.wikipedia.org/wiki/Binary_search_algorithm",
        domain: "en.wikipedia.org",
        why: "The full statement of the invariant.",
      },
    ],
  },
  topicTitle: "Resources",
};

/**
 * Outline ids are deliberately NON-CONTIGUOUS (1, 2, 5). Nothing in
 * `outlineItemSchema` requires contiguity, so an appended topic numbered by
 * `length + 1` would silently collide with topic 5 — and two topics sharing an
 * id makes the classroom render one section's blocks under the other's heading.
 */
function plan(outlineIds = [1, 2, 5]) {
  return {
    title: "Binary search",
    outline: outlineIds.map((id) => ({ id, title: `Topic ${id}`, duration: "3:00" })),
    blocks: [
      ...outlineIds.slice(0, -1).flatMap((topicId) => [
        { type: "heading", topicId, brief: "h" },
        { type: "paragraph", topicId, brief: "p" },
        { type: "list", topicId, brief: "l" },
      ]),
      { type: "heading", topicId: outlineIds.at(-1)!, brief: "h" },
      { type: "paragraph", topicId: outlineIds.at(-1)!, brief: "p" },
      { type: "quiz", topicId: outlineIds.at(-1)!, brief: "q" },
    ],
  };
}

function blocksFor(count: number, withQuiz = false) {
  const out: Record<string, unknown>[] = [];
  for (let i = 0; i < count - (withQuiz ? 1 : 0); i++) {
    out.push(i === 0 ? { type: "heading", text: "H" } : { type: "paragraph", text: "Some prose here." });
  }
  if (withQuiz) {
    out.push({
      type: "quiz",
      questions: [{ question: "Q?", options: ["a", "b"], correctIndex: 1, explanation: "b" }],
    });
  }
  return out;
}

function toolCallResponse(name: string, args: unknown) {
  return {
    choices: [
      {
        finish_reason: "tool_calls",
        message: {
          content: null,
          tool_calls: [{ id: "c1", type: "function", function: { name, arguments: JSON.stringify(args) } }],
        },
      },
    ],
  };
}

function fakeDeps(...responses: unknown[]) {
  const create = vi.fn();
  for (const r of responses) create.mockResolvedValueOnce(r);
  return { client: { chat: { completions: { create } } } as unknown as OpenAI, model: "fake/model" };
}

interface LoadOptions {
  /** What buildResourcesBlock does: a result, null, or a rejection. */
  resources?: typeof RESOURCES | null | Error;
  enabled?: boolean;
  outlineIds?: number[];
}

async function load(opts: LoadOptions = {}) {
  vi.resetModules();
  const buildResourcesBlock = vi.fn(async () => {
    if (opts.resources instanceof Error) throw opts.resources;
    return opts.resources === undefined ? RESOURCES : opts.resources;
  });

  vi.doMock("../src/config/env.js", async () => {
    const actual = await vi.importActual<typeof import("../src/config/env.js")>("../src/config/env.js");
    return { ...actual, isResourcesEnabled: () => opts.enabled !== false };
  });
  vi.doMock("../src/agents/lecture-maker/resources.js", () => ({ buildResourcesBlock }));

  const { makeLecture } = await import("../src/agents/lecture-maker/index.js");

  const ids = opts.outlineIds ?? [1, 2, 5];
  const p = plan(ids);
  const perTopic = new Map<number, number>();
  for (const b of p.blocks) perTopic.set(b.topicId, (perTopic.get(b.topicId) ?? 0) + 1);

  const deps = {
    analyst: fakeDeps(toolCallResponse("emit_lesson_blueprint", BLUEPRINT)),
    planner: fakeDeps(toolCallResponse("emit_lecture_plan", p)),
    worker: fakeDeps(
      ...ids.map((id, i) =>
        toolCallResponse("emit_topic_blocks", {
          blocks: blocksFor(perTopic.get(id)!, i === ids.length - 1),
        }),
      ),
    ),
    svg: fakeDeps(),
  };

  return { makeLecture, deps, buildResourcesBlock, plannedBlocks: p.blocks.length };
}

beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.doUnmock("../src/config/env.js");
  vi.doUnmock("../src/agents/lecture-maker/resources.js");
  vi.restoreAllMocks();
});

describe("makeLecture with resources", () => {
  it("appends the block last, after the quiz, with the next sequential id", async () => {
    const { makeLecture, deps, plannedBlocks } = await load();
    const made = await makeLecture(CTX, deps);

    expect(made.blocks).toHaveLength(plannedBlocks + 1);
    expect(made.blocks.at(-2)!.type).toBe("quiz");
    expect(made.blocks.at(-1)!.type).toBe("resources");
    expect(made.blocks.at(-1)!.id).toBe(`b${plannedBlocks + 1}`);
  });

  it("numbers the new outline topic above the highest existing id, not by length", async () => {
    const { makeLecture, deps } = await load({ outlineIds: [1, 2, 5] });
    const made = await makeLecture(CTX, deps);

    const last = made.outline.at(-1)!;
    expect(last.title).toBe("Resources");
    expect(last.id).toBe(6);
    expect(new Set(made.outline.map((t) => t.id)).size).toBe(made.outline.length);
    expect(made.blocks.at(-1)!.topicId).toBe(6);
  });

  it("does not exceed the assembled-document outline cap on a 16-topic lecture", async () => {
    const ids = Array.from({ length: 16 }, (_, i) => i + 1);
    const { makeLecture, deps } = await load({ outlineIds: ids });
    const made = await makeLecture(CTX, deps);
    expect(made.outline).toHaveLength(17);
  });

  it("ships the lecture unchanged when the step returns nothing", async () => {
    const { makeLecture, deps, plannedBlocks } = await load({ resources: null });
    const made = await makeLecture(CTX, deps);

    expect(made.blocks).toHaveLength(plannedBlocks);
    expect(made.blocks.at(-1)!.type).toBe("quiz");
    expect(made.outline.some((t) => t.title === "Resources")).toBe(false);
  });

  // The one that matters: this job sits inside the pipeline's Promise.all.
  it("ships the lecture even when the step rejects", async () => {
    const { makeLecture, deps, plannedBlocks } = await load({ resources: new Error("tavily exploded") });
    const made = await makeLecture(CTX, deps);
    expect(made.blocks).toHaveLength(plannedBlocks);
  });

  it("emits start and done progress events", async () => {
    const { makeLecture, deps } = await load();
    const events: { stage: string; status?: string; links?: number }[] = [];
    await makeLecture(CTX, deps, (e) => events.push(e));

    expect(events.filter((e) => e.stage === "resources")).toEqual([
      { stage: "resources", status: "start" },
      { stage: "resources", status: "done", links: 1 },
    ]);
  });

  it("emits skipped, not done, when there is nothing to show", async () => {
    const { makeLecture, deps } = await load({ resources: null });
    const events: { stage: string; status?: string }[] = [];
    await makeLecture(CTX, deps, (e) => events.push(e));
    expect(events.filter((e) => e.stage === "resources")).toEqual([
      { stage: "resources", status: "start" },
      { stage: "resources", status: "skipped" },
    ]);
  });

  it("emits no resources events at all when the feature is off", async () => {
    const { makeLecture, deps, buildResourcesBlock } = await load({ enabled: false });
    const events: { stage: string }[] = [];
    await makeLecture(CTX, deps, (e) => events.push(e));

    expect(events.some((e) => e.stage === "resources")).toBe(false);
    expect(buildResourcesBlock).not.toHaveBeenCalled();
  });
});
