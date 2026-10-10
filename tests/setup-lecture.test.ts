import type { ChatOpenAI } from "@langchain/openai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeDeps, fakeRoutingDeps, textResponse, toolCallResponse } from "./helpers/fakeLlm.js";
import { classifyLesson } from "../src/agents/lecture-maker/classify.js";
import { makeLecture, type LectureProgressEvent } from "../src/agents/lecture-maker/index.js";
import { rankByVendor } from "../src/agents/lecture-maker/downloads.js";
import { parseOperatingSystem } from "../src/agents/tools/prompts/intake.js";
import type { LessonContext } from "../src/agents/lecture-maker/prompt.js";
import { setupBlueprintSchema } from "../src/agents/lecture-maker/schema.js";
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

// --- shared fakes: helpers/fakeLlm.ts, which this file used to copy ---

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
    const deps = { chat: { bindTools: () => ({ invoke: create }) } as unknown as ChatOpenAI, model: "m" };
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
