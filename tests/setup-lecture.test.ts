import type OpenAI from "openai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { classifyLesson } from "../src/agents/lecture-maker/classify.js";
import { makeLecture, type LectureProgressEvent } from "../src/agents/lecture-maker/index.js";
import { rankByVendor } from "../src/agents/lecture-maker/downloads.js";
import { parseOperatingSystem } from "../src/agents/tools/prompts/intake.js";
import type { LessonContext } from "../src/agents/lecture-maker/prompt.js";
import {
  setupBlueprintSchema,
  setupLecturePlanSchema,
} from "../src/agents/lecture-maker/schema.js";
import type { WebSearchOptions, WebSearchResult } from "../src/agents/tools/web-search.js";
import type { LinkCandidate } from "../src/agents/lecture-maker/linkPicking.js";

/**
 * The setup lane: the lecture-maker's second pipeline, for lessons whose job is
 * to get software running on the student's machine rather than to explain an
 * idea.
 *
 * Three properties are worth protecting here, and they are what these tests are
 * about:
 *   1. routing fails OPEN — a classifier that errors must produce the concept
 *      lecture this codebase already had, never nothing;
 *   2. the guide's shape is enforced in the schema, not in the prompt — no quiz,
 *      one downloads section before the install steps, a closing checklist and a
 *      troubleshooting table;
 *   3. a download URL can only come from a search result. The picker tool has no
 *      url field, so the test is that a model which invents one anyway is
 *      ignored.
 */

// --- shared fakes ---

function fakeDeps(...responses: unknown[]) {
  const create = vi.fn();
  for (const r of responses) create.mockResolvedValueOnce(r);
  const client = { chat: { completions: { create } } } as unknown as OpenAI;
  return { deps: { client, model: "fake/model" }, create };
}

function toolCallResponse(name: string, args: unknown) {
  return {
    choices: [
      {
        finish_reason: "tool_calls",
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

const SETUP_CTX: LessonContext = {
  lessonId: "l-setup",
  courseTitle: "Python for Absolute Beginners",
  courseDesc: "From nothing to your first program",
  level: "Beginner",
  chapterTitle: "Getting Started",
  moduleTitle: "Your environment",
  topicTitle: "Install Python and VS Code",
  topicBrief: "Walk the student through installing Python and VS Code and running a first file.",
  siblingTopics: ["Your first program"],
  os: "windows",
};

function validSetupBlueprint() {
  return {
    goal: "Python runs from the terminal and VS Code opens a .py file.",
    tools: [
      { name: "Python", whatItIs: "The language runtime", whyThisOne: "It is what the course uses" },
      { name: "Visual Studio Code", whatItIs: "The editor", whyThisOne: "Free and standard" },
    ],
    prerequisites: [{ requirement: "Windows 10 or later", howToCheck: "winver" }],
    stages: [
      { name: "Download", doesWhat: "Get both installers" },
      { name: "Install Python", doesWhat: "Run the installer with PATH ticked" },
      { name: "Verify", doesWhat: "Check both from the terminal" },
    ],
    verification: [
      { what: "Python is on the PATH", command: "python --version", expected: "a version number" },
      { what: "VS Code opens from the terminal", command: "code --version", expected: "three lines of version info" },
    ],
    pitfalls: [
      { symptom: "'python' is not recognized", cause: "PATH box was left unticked", fix: "Re-run the installer" },
    ],
    visuals: [],
    outOfScope: ["Writing Python code"],
    currency: [],
  };
}

/**
 * A plan that satisfies every setup rule: downloads in the first half, a
 * troubleshooting table, a closing checklist, no quiz.
 */
function validSetupPlan() {
  return {
    title: "Install Python and VS Code",
    outline: [
      { id: 1, title: "What you're installing", duration: "2:00" },
      { id: 2, title: "Get the files", duration: "2:00" },
      { id: 3, title: "Install and verify", duration: "8:00" },
    ],
    blocks: [
      { type: "heading", topicId: 1, brief: "What you're installing" },
      { type: "paragraph", topicId: 1, brief: "What Python and VS Code each do" },
      { type: "heading", topicId: 2, brief: "Get the files" },
      { type: "downloads", topicId: 2, brief: "Python and VS Code downloads" },
      { type: "heading", topicId: 3, brief: "Install Python" },
      { type: "list", topicId: 3, brief: "Numbered install steps, PATH box called out" },
      { type: "code", topicId: 3, brief: "python --version with expected output" },
      { type: "table", topicId: 3, brief: "Troubleshooting: symptom, why, fix" },
      { type: "checklist", topicId: 3, brief: "Verify from the blueprint's verification list" },
    ],
  };
}

const TOPIC_1 = [
  { type: "heading", text: "What you're installing" },
  { type: "paragraph", text: "Python runs your code; VS Code is where you write it." },
];
const TOPIC_2 = [{ type: "heading", text: "Get the files" }];
const TOPIC_3 = [
  { type: "heading", text: "Install Python" },
  { type: "list", style: "numbered", items: ["Run the installer", "Tick Add to PATH", "Click Install Now"] },
  { type: "code", language: "powershell", code: "python --version\n# Python 3.x.y" },
  {
    type: "table",
    columns: ["Symptom", "Why it happens", "Fix"],
    rows: [["'python' is not recognized", "PATH box unticked", "Re-run the installer"]],
  },
  {
    type: "checklist",
    title: "Before you move on",
    checks: [
      { text: "Python answers from the terminal", command: "python --version", expected: "a version number" },
      { text: "VS Code opens from the terminal", command: "code --version", expected: "three version lines" },
    ],
  },
];

// --- 1. Routing ---

describe("classifyLesson", () => {
  beforeEach(() => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("routes an install lesson to the setup lane", async () => {
    const { deps } = fakeDeps(
      toolCallResponse("emit_lesson_kind", { kind: "setup", reason: "installs an editor" }),
    );
    await expect(classifyLesson(SETUP_CTX, deps)).resolves.toBe("setup");
  });

  it("routes an ordinary lesson to the concept lane", async () => {
    const { deps } = fakeDeps(
      toolCallResponse("emit_lesson_kind", { kind: "concept", reason: "explains a mechanism" }),
    );
    await expect(classifyLesson({ ...SETUP_CTX, topicTitle: "How the DOM works" }, deps)).resolves.toBe(
      "concept",
    );
  });

  // The whole point of the fail-open contract: a classifier outage must cost
  // the setup formatting, never the lesson.
  it("falls back to concept when the model call throws", async () => {
    const create = vi.fn().mockRejectedValue(new Error("provider down"));
    const deps = { client: { chat: { completions: { create } } } as unknown as OpenAI, model: "m" };
    await expect(classifyLesson(SETUP_CTX, deps)).resolves.toBe("concept");
  });

  it("falls back to concept when the model answers with an unknown kind", async () => {
    const { deps } = fakeDeps(
      toolCallResponse("emit_lesson_kind", { kind: "tutorial", reason: "?" }),
      toolCallResponse("emit_lesson_kind", { kind: "tutorial", reason: "?" }),
    );
    await expect(classifyLesson(SETUP_CTX, deps)).resolves.toBe("concept");
  });
});

// --- 2. Plan shape ---

describe("setupLecturePlanSchema", () => {
  const parse = (mutate: (p: ReturnType<typeof validSetupPlan>) => void) => {
    const plan = validSetupPlan();
    mutate(plan);
    return setupLecturePlanSchema.safeParse(plan);
  };
  const issuesOf = (r: ReturnType<typeof setupLecturePlanSchema.safeParse>) =>
    r.success ? "" : r.error.issues.map((i) => i.message).join(" | ");

  it("accepts a well-formed guide", () => {
    expect(setupLecturePlanSchema.safeParse(validSetupPlan()).success).toBe(true);
  });

  it("has no quiz type at all", () => {
    const r = parse((p) => {
      p.blocks.splice(8, 0, { type: "quiz", topicId: 3, brief: "test them" });
    });
    expect(r.success).toBe(false);
  });

  it("rejects an svg", () => {
    const r = parse((p) => {
      p.blocks.splice(1, 0, { type: "svg", topicId: 1, brief: "draw the flow" });
    });
    expect(r.success).toBe(false);
  });

  it("requires exactly one downloads block", () => {
    expect(issuesOf(parse((p) => p.blocks.splice(3, 1)))).toContain("exactly one downloads block");
    expect(
      issuesOf(parse((p) => p.blocks.splice(4, 0, { type: "downloads", topicId: 2, brief: "again" }))),
    ).toContain("exactly one downloads block");
  });

  it("rejects a downloads block placed after the install steps", () => {
    const r = parse((p) => {
      const [downloads] = p.blocks.splice(3, 1);
      p.blocks.splice(7, 0, downloads!);
    });
    expect(issuesOf(r)).toContain("FIRST HALF");
  });

  it("requires the guide to end on the checklist", () => {
    const r = parse((p) => {
      const [checklist] = p.blocks.splice(8, 1);
      p.blocks.splice(5, 0, checklist!);
    });
    expect(issuesOf(r)).toContain("must be a checklist");
  });

  it("requires a troubleshooting table", () => {
    expect(issuesOf(parse((p) => p.blocks.splice(7, 1)))).toContain("troubleshooting");
  });
});

// --- 3. The pipeline end to end, with fakes ---

/**
 * The real downloads module reaches the network twice (a search and a HEAD
 * check), so the pipeline tests mock the search boundary and let everything
 * else — ranking, filtering, the picker's number-only parse — run for real.
 */
const DOWNLOAD_RESULTS: WebSearchResult = {
  query: "d",
  sources: [
    { title: "Download Python", url: "https://www.python.org/downloads/", content: "Official downloads." },
    { title: "Python on Softonic", url: "https://en.softonic.com/python", content: "Free download!" },
    { title: "Visual Studio Code", url: "https://code.visualstudio.com/Download", content: "Get VS Code." },
  ],
};

interface PipelineOptions {
  emission?: Record<string, unknown>;
  search?: WebSearchResult | Error;
}

async function loadPipeline(opts: PipelineOptions = {}) {
  vi.resetModules();
  const runWebSearch = vi.fn(async (_q: string, _o: WebSearchOptions = {}) => {
    const result = opts.search ?? DOWNLOAD_RESULTS;
    if (result instanceof Error) throw result;
    return result;
  });

  vi.doMock("../src/config/env.js", async () => {
    const actual = await vi.importActual<typeof import("../src/config/env.js")>("../src/config/env.js");
    // Downloads on, resources off — this keeps the assembled guide to exactly
    // the blocks the plan asked for, so block indexes mean what they say.
    return { ...actual, isResourcesEnabled: () => true };
  });
  vi.doMock("../src/agents/tools/web-search.js", async () => {
    const actual = await vi.importActual<typeof import("../src/agents/tools/web-search.js")>(
      "../src/agents/tools/web-search.js",
    );
    return { ...actual, runWebSearch };
  });
  // The RAG and freshness retrievals are not what these tests are about, and
  // both would otherwise try to reach a real service.
  vi.doMock("../src/rag/retriever.js", () => ({ retrieveGrounding: async () => "" }));
  vi.doMock("../src/agents/shared/freshness.js", () => ({ retrieveFreshness: async () => "" }));
  // The closing further-reading section has its own suite; here it would only
  // add a block the assembly assertions would have to skip over.
  vi.doMock("../src/agents/lecture-maker/resources.js", () => ({
    buildResourcesBlock: async () => null,
  }));

  const { makeLecture: make } = await import("../src/agents/lecture-maker/index.js");

  const emission = opts.emission ?? {
    intro: "Grab both installers.",
    picks: [{ number: 1, label: "Python for Windows", note: "Pick the 64-bit installer.", kind: "installer" }],
  };

  const deps = {
    classifier: fakeDeps(toolCallResponse("emit_lesson_kind", { kind: "setup", reason: "installs" })).deps,
    analyst: fakeDeps(toolCallResponse("emit_setup_blueprint", validSetupBlueprint())).deps,
    planner: fakeDeps(toolCallResponse("emit_setup_plan", validSetupPlan())).deps,
    worker: fakeDeps(
      toolCallResponse("emit_setup_blocks", { blocks: TOPIC_1 }),
      toolCallResponse("emit_setup_blocks", { blocks: TOPIC_2 }),
      toolCallResponse("emit_setup_blocks", { blocks: TOPIC_3 }),
    ).deps,
    downloads: fakeDeps(toolCallResponse("emit_download_picks", emission)).deps,
  };

  return { make, deps, runWebSearch };
}

describe("makeSetupLecture", () => {
  beforeEach(() => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockResolvedValue({ status: 200 } as Response);
  });
  afterEach(() => {
    vi.doUnmock("../src/config/env.js");
    vi.doUnmock("../src/agents/tools/web-search.js");
    vi.doUnmock("../src/rag/retriever.js");
    vi.doUnmock("../src/agents/shared/freshness.js");
    vi.doUnmock("../src/agents/lecture-maker/resources.js");
    vi.restoreAllMocks();
  });

  it("assembles the guide in plan order, with the downloads block where the planner put it", async () => {
    const { make, deps } = await loadPipeline();
    const made = await make(SETUP_CTX, deps);

    expect(made.kind).toBe("setup");
    expect(made.blocks.map((b) => b.type)).toEqual([
      "heading", "paragraph", "heading", "downloads", "heading", "list", "code", "table", "checklist",
    ]);
    expect(made.blocks.map((b) => b.id)).toEqual(
      ["b1", "b2", "b3", "b4", "b5", "b6", "b7", "b8", "b9"],
    );
    // The two rules the whole lane exists for.
    expect(made.blocks.some((b) => b.type === "quiz")).toBe(false);
    expect(made.blocks.at(-1)!.type).toBe("checklist");
  });

  it("puts only real, non-aggregator search results in front of the student", async () => {
    const { make, deps } = await loadPipeline();
    const made = await make(SETUP_CTX, deps);

    const downloads = made.blocks.find((b) => b.type === "downloads") as {
      os: string;
      links: { url: string; label: string }[];
    };
    expect(downloads.os).toBe("windows");
    expect(downloads.links.map((l) => l.url)).toEqual(["https://www.python.org/downloads/"]);
    // Softonic is in the download blocklist — an aggregator's wrapped installer
    // is the one link here that could actively harm the student.
    expect(JSON.stringify(downloads.links)).not.toContain("softonic");
  });

  it("ignores a url the picker invented and ships the candidate's own address", async () => {
    const { make, deps } = await loadPipeline({
      emission: {
        intro: "Grab both installers.",
        picks: [
          {
            number: 1,
            label: "Python",
            note: "The official installer.",
            kind: "installer",
            // Not in the tool schema at all. If this ever reached a student they
            // would run whatever is at it.
            url: "https://python-downloads.example.com/setup.exe",
          },
        ],
      },
    });
    const made = await make(SETUP_CTX, deps);
    const downloads = made.blocks.find((b) => b.type === "downloads") as { links: { url: string }[] };
    expect(downloads.links[0]!.url).toBe("https://www.python.org/downloads/");
    expect(JSON.stringify(made.blocks)).not.toContain("python-downloads.example.com");
  });

  it("ships the guide without the section when every search fails", async () => {
    const { make, deps } = await loadPipeline({ search: new Error("tavily down") });
    const made = await make(SETUP_CTX, deps);
    expect(made.blocks.some((b) => b.type === "downloads")).toBe(false);
    // No id gap where the dropped block was, and the guide still ends properly.
    expect(made.blocks.map((b) => b.id)).toEqual(["b1", "b2", "b3", "b4", "b5", "b6", "b7", "b8"]);
    expect(made.blocks.at(-1)!.type).toBe("checklist");
  });

  it("reports the lane it chose through onProgress", async () => {
    const { make, deps } = await loadPipeline();
    const events: LectureProgressEvent[] = [];
    await make(SETUP_CTX, deps, (ev) => events.push(ev));

    expect(events[0]).toEqual({ stage: "analyzing" });
    expect(events[1]).toEqual({ stage: "classified", kind: "setup" });
    expect(events.filter((e) => e.stage === "downloads")).toEqual([
      { stage: "downloads", status: "start" },
      { stage: "downloads", status: "done", links: 1 },
    ]);
    expect(events.at(-1)).toEqual({ stage: "assembling" });
  });
});

// --- 4. Supporting units ---

describe("rankByVendor", () => {
  const c = (domain: string): LinkCandidate => ({
    title: domain,
    url: `https://${domain}/`,
    domain,
    snippet: "",
  });

  it("puts the vendor's own domain first", () => {
    const ranked = rankByVendor(
      [c("someblog.com"), c("github.com"), c("code.visualstudio.com")],
      "Visual Studio Code",
    );
    expect(ranked[0]!.domain).toBe("code.visualstudio.com");
  });

  it("keeps search order among candidates that score the same", () => {
    const ranked = rankByVendor([c("a-blog.com"), c("b-blog.com")], "Docker Desktop");
    expect(ranked.map((r) => r.domain)).toEqual(["a-blog.com", "b-blog.com"]);
  });
});

describe("parseOperatingSystem", () => {
  it("reads the offered options", () => {
    expect(parseOperatingSystem("Windows")).toBe("windows");
    expect(parseOperatingSystem("macOS")).toBe("macos");
    expect(parseOperatingSystem("Linux")).toBe("linux");
  });

  // The question dock always offers a free-text box, so these are what students
  // actually type into it.
  it("reads the free text students type instead", () => {
    expect(parseOperatingSystem("my macbook air")).toBe("macos");
    expect(parseOperatingSystem("win 11 laptop")).toBe("windows");
    expect(parseOperatingSystem("ubuntu 24.04")).toBe("linux");
  });

  // Unrecognised must stay empty rather than guess: the setup lane then covers
  // all three, which is right, where a wrong guess is install steps for a
  // machine the student does not own.
  it("returns empty for anything it cannot place", () => {
    expect(parseOperatingSystem("my phone")).toBe("");
    expect(parseOperatingSystem("")).toBe("");
  });
});

describe("setupBlueprintSchema", () => {
  it("requires the two lists the guide is built from", () => {
    const bp = validSetupBlueprint();
    expect(setupBlueprintSchema.safeParse({ ...bp, verification: [] }).success).toBe(false);
    expect(setupBlueprintSchema.safeParse({ ...bp, pitfalls: [] }).success).toBe(false);
  });

  it("allows no visuals at all — an install guide usually has none", () => {
    const parsed = setupBlueprintSchema.safeParse(validSetupBlueprint());
    expect(parsed.success && parsed.data.visuals).toEqual([]);
  });
});
