import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LessonContext } from "../src/agents/lecture-maker/prompt.js";
import { fakeDeps as sharedFakeDeps, fakeRoutingDeps, toolCallResponse } from "./helpers/fakeLlm.js";

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

function outline(topics: number) {
  return {
    title: "Binary search",
    topics: Array.from({ length: topics }, (_, i) => ({
      title: `Topic ${i + 1}`,
      duration: "3:00",
      sections: [{ title: `Section ${i + 1}`, kind: "theory", brief: "b" }],
    })),
  };
}

const SECTIONS = {
  sections: [
    {
      title: "s",
      kind: "theory",
      blocks: [{ type: "paragraph", text: "Some prose here." }],
      tutor: { goal: "g", explain: ["e"], check: { mustShow: "m", mode: "verbal", weight: "light" } },
    },
  ],
};
const QUIZ = {
  questions: Array.from({ length: 4 }, () => ({ question: "Q?", options: ["a", "b"], correctIndex: 1, explanation: "b" })),
};

/** Deps only — this file never asserts on the spy, so it drops the rest. */
function fakeDeps(...responses: unknown[]) {
  return sharedFakeDeps(...responses).deps;
}

interface LoadOptions {
  /** What buildResourcesBlock does: a result, null, or a rejection. */
  resources?: typeof RESOURCES | null | Error;
  enabled?: boolean;
  topics?: number;
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

  const topics = opts.topics ?? 3;
  const deps = {
    analyst: fakeDeps(toolCallResponse("emit_lesson_blueprint", BLUEPRINT)),
    planner: fakeDeps(toolCallResponse("emit_lecture_outline", outline(topics))),
    worker: fakeRoutingDeps((text) =>
      text.includes("closing exam") ? toolCallResponse("emit_quiz", QUIZ) : toolCallResponse("emit_sections", SECTIONS),
    ).deps,
  };

  return { makeLecture, deps, buildResourcesBlock, topics };
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
  it("closes the lecture with a resources section after the quiz", async () => {
    const { makeLecture, deps } = await load();
    const made = await makeLecture(CTX, deps);
    const kinds = made.sections.map((sec) => sec.blocks[0]!.type);
    expect(kinds.at(-2)).toBe("quiz");
    expect(kinds.at(-1)).toBe("resources");
    expect(made.sections.at(-1)!.id).toBe(`s${made.sections.length}`);
  });

  it("gives resources its own outline topic above the highest id", async () => {
    const { makeLecture, deps } = await load({ topics: 3 });
    const made = await makeLecture(CTX, deps);
    const last = made.outline.at(-1)!;
    expect(last.title).toBe("Resources");
    expect(last.id).toBe(4);
    expect(made.sections.at(-1)!.topicId).toBe(4);
  });

  it("fits the outline cap on the largest plan", async () => {
    const { makeLecture, deps } = await load({ topics: 12 });
    const made = await makeLecture(CTX, deps);
    expect(made.outline).toHaveLength(13);
  });

  it("ships the lecture without it when the step returns nothing", async () => {
    const { makeLecture, deps } = await load({ resources: null });
    const made = await makeLecture(CTX, deps);
    expect(made.sections.at(-1)!.blocks[0]!.type).toBe("quiz");
    expect(made.outline.some((t) => t.title === "Resources")).toBe(false);
  });

  // The one that matters: this job sits inside the pipeline's Promise.all.
  it("ships the lecture even when the step rejects", async () => {
    const { makeLecture, deps } = await load({ resources: new Error("tavily exploded") });
    const made = await makeLecture(CTX, deps);
    expect(made.sections.at(-1)!.blocks[0]!.type).toBe("quiz");
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
