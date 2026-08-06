import type OpenAI from "openai";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  formatZodIssues,
  resolveLectureDeps,
  runForcedToolCall,
  svgDefaultModel,
  type LlmDeps,
} from "../src/agents/lecture-maker/call.js";
import { buildLessonBlueprint } from "../src/agents/lecture-maker/analyze.js";
import { makeLecture, type LectureProgressEvent } from "../src/agents/lecture-maker/index.js";
import { buildLecturePlan } from "../src/agents/lecture-maker/planner.js";
import {
  buildAnalystSystemPrompt,
  buildAnalystUserMessage,
  buildPlannerSystemPrompt,
  buildPlannerUserMessage,
  buildSvgWorkerSystemPrompt,
  buildTopicWorkerSystemPrompt,
  buildTopicWorkerUserMessage,
  type LessonContext,
} from "../src/agents/lecture-maker/prompt.js";
import { backfillMissingTypes, runSvgWorker, runTopicWorker } from "../src/agents/lecture-maker/workers.js";
import {
  easyBlockSchema,
  lecturePlanSchema,
  lessonBlueprintSchema,
  MAX_SVG_BLOCKS,
} from "../src/agents/lecture-maker/schema.js";
import { validateSvgMarkup } from "../src/agents/lecture-maker/validate.js";
import { ApiError } from "../src/utils/apiError.js";

// --- fake OpenAI client helpers (adapted from course-maker.test.ts) ---

function fakeDeps(...responses: unknown[]) {
  const create = vi.fn();
  for (const r of responses) create.mockResolvedValueOnce(r);
  const client = { chat: { completions: { create } } } as unknown as OpenAI;
  return { deps: { client, model: "fake/model" } as LlmDeps, create };
}

function toolCallResponse(name: string, args: unknown, finishReason = "tool_calls") {
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

function textResponse(text: string) {
  return { choices: [{ finish_reason: "stop", message: { content: text } }] };
}

/** All messages sent on the given create() call, JSON-stringified for content asserts. */
function sentMessages(create: ReturnType<typeof vi.fn>, callIndex: number): string {
  return JSON.stringify(create.mock.calls[callIndex]?.[0]?.messages ?? []);
}

// Must satisfy validateSvgMarkup AND the geometry/palette checks, since
// runSvgWorker now runs all three: prefixed ids, anchored text, diagram
// palette, and content that fills its canvas.
const GOOD_SVG =
  '<svg viewBox="0 0 700 340" xmlns="http://www.w3.org/2000/svg">' +
  '<rect id="s1-box" x="24" y="24" width="652" height="292" rx="10" fill="var(--dia-1-tint)" stroke="var(--dia-1)" stroke-width="1.5"/>' +
  '<text id="s1-label" x="350" y="180" font-family="Inter" font-size="14" text-anchor="middle" fill="var(--dia-ink)">Search range</text>' +
  "</svg>";
const SMIL_SVG =
  '<svg viewBox="0 0 700 340">' +
  '<rect id="s1-track" x="24" y="24" width="652" height="292" rx="10" fill="var(--dia-2-tint)" stroke="var(--dia-2)" stroke-width="1.5"/>' +
  '<circle id="s1-dot" cx="200" cy="170" r="18" fill="var(--dia-2)">' +
  '<animate attributeName="cx" dur="3s" values="200;500;200" repeatCount="indefinite"/></circle>' +
  '<text id="s1-cap" x="350" y="300" font-family="Inter" font-size="12" text-anchor="middle" fill="var(--dia-ink-soft)">Range halves each step</text>' +
  "</svg>";

function validPlan() {
  return {
    title: "Binary Search Deep Dive",
    outline: [
      { id: 1, title: "Intuition", duration: "4:30" },
      { id: 2, title: "Implementation", duration: "6:00" },
    ],
    // The single quiz closes the lecture and belongs to the final outline topic.
    blocks: [
      { type: "heading", topicId: 1, brief: "Intro heading" },
      { type: "paragraph", topicId: 1, brief: "What problem binary search solves" },
      { type: "svg", topicId: 1, brief: "Halving animation", animated: true },
      { type: "code", topicId: 2, brief: "Python implementation" },
      { type: "mermaid", topicId: 2, brief: "Flow of the algorithm" },
      { type: "quiz", topicId: 2, brief: "Six questions across the whole lecture" },
    ],
  };
}

/** A blueprint that satisfies lessonBlueprintSchema, for the analyst tests. */
function validBlueprint() {
  return {
    scope: "How binary search narrows a sorted range by halving it.",
    objectives: ["Trace binary search on a sorted array", "Say why the array must be sorted"],
    assumedKnowledge: ["Array indexing"],
    concepts: [
      { name: "The sorted precondition", why: "Halving is only valid on sorted data", hardBecause: "It looks optional" },
      { name: "Halving the range", why: "It is the whole idea", hardBecause: "Off-by-one on the bounds" },
    ],
    examples: [
      { name: "phone-book", scenario: "Finding a name in a 500-page phone book", teaches: "Halving the range" },
    ],
    misconceptions: [{ mistake: "Running it on an unsorted array", whatBreaks: "It silently returns the wrong index" }],
    visuals: [{ concept: "Halving the range", kind: "svg", shows: "The range shrinking by half each step" }],
    outOfScope: ["Sorting algorithms themselves"],
  };
}

describe("lecture schemas", () => {
  // The interactive widgets were removed; nothing may reintroduce them.
  it("rejects an interactive block", () => {
    const parsed = easyBlockSchema.safeParse({
      type: "interactive",
      component: "step-through",
      props: { steps: [{ label: "Split", text: "Cut the range in half." }] },
      alt: "Walks through binary search.",
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects an interactive block in a plan", () => {
    const plan = validPlan();
    plan.blocks.push({ type: "interactive", topicId: 2, brief: "Step-through" } as never);
    expect(lecturePlanSchema.safeParse(plan).success).toBe(false);
  });

  it("rejects quiz question with out-of-range correctIndex", () => {
    const parsed = easyBlockSchema.safeParse({
      type: "quiz",
      questions: [{ question: "2+2?", options: ["3", "4"], correctIndex: 2 }],
    });
    expect(parsed.success).toBe(false);
  });

  // A plain union reported every bad block as "Invalid input", which is what
  // gets handed back as repair feedback — useless, and it cost live lectures.
  it("names the real defect instead of a bare union failure", () => {
    const parsed = easyBlockSchema.safeParse({ type: "list", items: [] });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const msg = formatZodIssues(parsed.error);
      expect(msg).toContain("items");
      expect(msg).not.toBe("(root): Invalid input");
    }
  });

  it("applies .catch defaults for bad cosmetic enums", () => {
    const parsed = easyBlockSchema.safeParse({ type: "callout", text: "Heads up!", tone: "angry" });
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.type === "callout") {
      expect(parsed.data.tone).toBe("info");
    }
  });

  it("rejects plan whose block topicId is not in outline", () => {
    const plan = validPlan();
    plan.blocks[0]!.topicId = 5;
    const parsed = lecturePlanSchema.safeParse(plan);
    expect(parsed.success).toBe(false);
  });

  it("caps svg at the hard limit and pushes the rest to libraries", () => {
    const svgPlan = (n: number) => {
      const plan = validPlan();
      plan.blocks = [
        { type: "heading", topicId: 1, brief: "intro" },
        { type: "paragraph", topicId: 1, brief: "setup" },
        ...Array.from({ length: n }, (_, i) => ({ type: "svg" as const, topicId: 1, brief: `svg ${i}` })),
        { type: "mermaid", topicId: 2, brief: "closing structure" },
        { type: "paragraph", topicId: 2, brief: "closing summary" },
        { type: "quiz", topicId: 2, brief: "check" },
      ];
      return lecturePlanSchema.safeParse(plan).success;
    };
    // svg is a last resort now — at most MAX_SVG_BLOCKS (3), no more.
    expect(svgPlan(MAX_SVG_BLOCKS)).toBe(true);
    expect(svgPlan(MAX_SVG_BLOCKS + 1)).toBe(false);
    expect(svgPlan(12)).toBe(false);
  });

  it("accepts a long visual-heavy plan and preserves block order", () => {
    const parsed = lecturePlanSchema.safeParse(validPlan());
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.blocks.map((b) => b.type)).toEqual([
        "heading", "paragraph", "svg", "code", "mermaid", "quiz",
      ]);
    }
  });

  it("accepts a 12-topic, 60-block lecture plan", () => {
    const outline = Array.from({ length: 12 }, (_, i) => ({
      id: i + 1,
      title: `Topic ${i + 1}`,
      duration: "3:00",
    }));
    const blocks: Record<string, unknown>[] = Array.from({ length: 59 }, (_, i) => ({
      type: i < 12 ? ("mermaid" as const) : ("paragraph" as const),
      topicId: (i % 12) + 1,
      brief: `brief ${i}`,
    }));
    blocks.push({ type: "quiz", topicId: 12, brief: "final check" });
    expect(lecturePlanSchema.safeParse({ title: "Long lecture", outline, blocks }).success).toBe(true);
  });

  // The per-topic visual quota was removed: it made the planner bolt a diagram
  // onto motivation and recap topics purely to satisfy the validator.
  it("accepts a plan whose recap topic carries no visual", () => {
    const plan = validPlan();
    // Swap topic 2's diagram for prose — it keeps the plan at the 6-block
    // minimum, so only the missing visual is under test.
    plan.blocks = plan.blocks.map((b) =>
      b.topicId === 2 && b.type === "mermaid" ? { type: "list", topicId: 2, brief: "recap points" } : b,
    );
    expect(lecturePlanSchema.safeParse(plan).success).toBe(true);
  });

  it("accepts a plan with no visual blocks at all", () => {
    const plan = validPlan();
    plan.blocks = [
      { type: "heading", topicId: 1, brief: "intro" },
      { type: "paragraph", topicId: 1, brief: "why it matters" },
      { type: "list", topicId: 1, brief: "the rules" },
      { type: "paragraph", topicId: 2, brief: "worked example" },
      { type: "table", topicId: 2, brief: "comparison" },
      { type: "quiz", topicId: 2, brief: "final check" },
    ];
    expect(lecturePlanSchema.safeParse(plan).success).toBe(true);
  });

  // The planner reliably undershoots depth: a live run returned 18 blocks over
  // 8 topics, several of them a single paragraph.
  it("rejects a lecture too thin to teach", () => {
    const outline = Array.from({ length: 6 }, (_, i) => ({ id: i + 1, title: `T${i + 1}`, duration: "3:00" }));
    const blocks = Array.from({ length: 11 }, (_, i) => ({
      type: "paragraph" as const,
      topicId: (i % 6) + 1,
      brief: `b${i}`,
    }));
    blocks.push({ type: "quiz", topicId: 6, brief: "final" } as never);
    const parsed = lecturePlanSchema.safeParse({ title: "Thin", outline, blocks });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.map((i) => i.message).join()).toContain("too thin");
    }
  });

  it("rejects a topic reduced to a single block", () => {
    const outline = Array.from({ length: 3 }, (_, i) => ({ id: i + 1, title: `T${i + 1}`, duration: "3:00" }));
    const blocks = [
      { type: "heading", topicId: 1, brief: "h" },
      { type: "paragraph", topicId: 1, brief: "p" },
      { type: "paragraph", topicId: 1, brief: "p2" },
      { type: "paragraph", topicId: 2, brief: "lonely" },
      { type: "heading", topicId: 3, brief: "h3" },
      { type: "paragraph", topicId: 3, brief: "p3" },
      { type: "list", topicId: 3, brief: "l3" },
      { type: "paragraph", topicId: 3, brief: "p4" },
      { type: "quiz", topicId: 3, brief: "q" },
    ];
    const parsed = lecturePlanSchema.safeParse({ title: "Lonely", outline, blocks });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.map((i) => i.message).join()).toContain("only one block");
    }
  });

  it("rejects a plan with a per-topic checkpoint quiz", () => {
    const plan = validPlan();
    plan.blocks.splice(2, 0, { type: "quiz", topicId: 1, brief: "checkpoint" });
    const parsed = lecturePlanSchema.safeParse(plan);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.map((i) => i.message).join()).toContain("exactly one quiz block");
    }
  });

  it("rejects a plan with no quiz at all", () => {
    const plan = validPlan();
    plan.blocks = plan.blocks.filter((b) => b.type !== "quiz");
    expect(lecturePlanSchema.safeParse(plan).success).toBe(false);
  });

  it("rejects a plan whose quiz is not the last block", () => {
    const plan = validPlan();
    plan.blocks.push({ type: "paragraph", topicId: 2, brief: "one more thought after the quiz" });
    const parsed = lecturePlanSchema.safeParse(plan);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.map((i) => i.message).join()).toContain("very last block");
    }
  });

  it("rejects a quiz that does not belong to the final outline topic", () => {
    const plan = validPlan();
    // Reordered so the quiz still ends the plan but sits under topic 1.
    plan.blocks = [
      { type: "heading", topicId: 1, brief: "intro" },
      { type: "mermaid", topicId: 2, brief: "structure" },
      { type: "paragraph", topicId: 2, brief: "detail" },
      { type: "heading", topicId: 1, brief: "recap" },
      { type: "paragraph", topicId: 1, brief: "recap prose" },
      { type: "quiz", topicId: 1, brief: "check" },
    ];
    const parsed = lecturePlanSchema.safeParse(plan);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.map((i) => i.message).join()).toContain("final outline topic");
    }
  });
});

describe("lesson blueprint schema", () => {
  it("accepts a full blueprint", () => {
    expect(lessonBlueprintSchema.safeParse(validBlueprint()).success).toBe(true);
  });

  // A genuinely verbal lesson must be allowed to say "no pictures here" — that
  // is the whole point of removing the per-topic quota.
  it("accepts an empty visuals list", () => {
    const parsed = lessonBlueprintSchema.safeParse({ ...validBlueprint(), visuals: [] });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.visuals).toEqual([]);
  });

  it("defaults the optional lists so downstream formatting never sees undefined", () => {
    const { assumedKnowledge, misconceptions, visuals, outOfScope, ...required } = validBlueprint();
    void assumedKnowledge, void misconceptions, void visuals, void outOfScope;
    const parsed = lessonBlueprintSchema.safeParse(required);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.misconceptions).toEqual([]);
      expect(parsed.data.visuals).toEqual([]);
    }
  });

  it("rejects an unknown visual kind", () => {
    const bp = validBlueprint();
    bp.visuals = [{ concept: "x", kind: "screenshot", shows: "y" }];
    expect(lessonBlueprintSchema.safeParse(bp).success).toBe(false);
  });

  it("requires at least one worked example", () => {
    expect(lessonBlueprintSchema.safeParse({ ...validBlueprint(), examples: [] }).success).toBe(false);
  });
});

describe("validateSvgMarkup", () => {
  it("accepts a valid static svg", () => {
    expect(validateSvgMarkup(GOOD_SVG)).toEqual([]);
  });

  it("accepts SMIL animation", () => {
    expect(validateSvgMarkup(SMIL_SVG)).toEqual([]);
  });

  it("rejects svg without viewBox", () => {
    const issues = validateSvgMarkup('<svg width="100" height="60"><rect x="1" y="1" width="4" height="4"/></svg>');
    expect(issues.join()).toContain("viewBox");
  });

  it("rejects markup not starting with <svg", () => {
    expect(validateSvgMarkup('<div viewBox="0 0 1 1">nope</div>').join()).toContain("must start with <svg");
  });

  it("rejects malformed XML", () => {
    expect(validateSvgMarkup('<svg viewBox="0 0 1 1"><rect x="1"</svg>').join()).toContain("well-formed");
  });

  it("rejects script tags", () => {
    expect(validateSvgMarkup('<svg viewBox="0 0 1 1"><script>alert(1)</script></svg>').join()).toContain("script");
  });

  it("rejects event handler attributes", () => {
    expect(validateSvgMarkup('<svg viewBox="0 0 1 1"><rect onclick="x()" x="1" y="1" width="2" height="2"/></svg>').join()).toContain(
      "event handler",
    );
  });

  it("rejects external href but allows fragment refs", () => {
    expect(
      validateSvgMarkup('<svg viewBox="0 0 1 1"><use href="https://evil.example/x.svg#a"/></svg>').join(),
    ).toContain("external href");
    expect(validateSvgMarkup('<svg viewBox="0 0 1 1"><path id="s1-p" d="M0 0"/><use href="#s1-p"/></svg>')).toEqual([]);
  });

  it("rejects javascript: urls", () => {
    expect(validateSvgMarkup('<svg viewBox="0 0 1 1"><a href="#x" data-u="javascript:alert(1)">y</a></svg>').join()).toContain(
      "javascript:",
    );
  });

  it("rejects duplicate ids", () => {
    expect(
      validateSvgMarkup('<svg viewBox="0 0 1 1"><rect id="a" x="0" y="0" width="1" height="1"/><circle id="a" cx="1" cy="1" r="1"/></svg>').join(),
    ).toContain('duplicate id "a"');
  });
});

// --- generic forced-tool-call runner ---

const demoSchema = z.object({ ok: z.string().min(1) });
const demoTool = {
  type: "function",
  function: { name: "emit_demo", description: "demo", parameters: { type: "object" } },
} as OpenAI.Chat.ChatCompletionFunctionTool;

function parseDemo(raw: unknown) {
  const r = demoSchema.safeParse(raw);
  return r.success
    ? ({ success: true, data: r.data } as const)
    : ({
        success: false,
        issues: r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "),
      } as const);
}

function demoOpts(deps: LlmDeps) {
  return { deps, tool: demoTool, system: "sys", user: "usr", parse: parseDemo, sizeHint: "Emit fewer, shorter blocks." };
}

describe("runForcedToolCall", () => {
  it("returns the payload on first valid emission", async () => {
    const { deps, create } = fakeDeps(toolCallResponse("emit_demo", { ok: "yes" }));
    await expect(runForcedToolCall(demoOpts(deps))).resolves.toEqual({ ok: "yes" });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("repairs after invalid structure then succeeds", async () => {
    const { deps, create } = fakeDeps(
      toolCallResponse("emit_demo", { nope: 1 }),
      toolCallResponse("emit_demo", { ok: "fixed" }),
    );
    await expect(runForcedToolCall(demoOpts(deps))).resolves.toEqual({ ok: "fixed" });
    expect(create).toHaveBeenCalledTimes(2);
    expect(sentMessages(create, 1)).toContain("ok:");
  });

  it("repairs after a plain-text response", async () => {
    const { deps, create } = fakeDeps(textResponse("here is your lecture"), toolCallResponse("emit_demo", { ok: "y" }));
    await expect(runForcedToolCall(demoOpts(deps))).resolves.toEqual({ ok: "y" });
    expect(sentMessages(create, 1)).toContain("calling the emit_demo function");
  });

  it("asks for a smaller emission on truncation", async () => {
    const { deps, create } = fakeDeps(
      toolCallResponse("emit_demo", { ok: "cut" }, "length"),
      toolCallResponse("emit_demo", { ok: "small" }),
    );
    await expect(runForcedToolCall(demoOpts(deps))).resolves.toEqual({ ok: "small" });
    expect(sentMessages(create, 1)).toContain("Emit fewer, shorter blocks.");
  });

  it("throws 502 after two failed attempts", async () => {
    const { deps } = fakeDeps(toolCallResponse("emit_demo", { nope: 1 }), textResponse("still wrong"));
    await expect(runForcedToolCall(demoOpts(deps))).rejects.toMatchObject({ statusCode: 502 });
  });
});

describe("prompts", () => {
  const ctx = {
    lessonId: "py-abcd-c1m1t1",
    courseTitle: "Python Basics",
    courseDesc: "Learn Python from scratch.",
    level: "Beginner" as const,
    chapterTitle: "Foundations",
    moduleTitle: "Control Flow",
    topicTitle: "Loops",
    topicBrief: "Introduce for and while, the range() call, and warn about off-by-one errors.",
    siblingTopics: ["Conditionals", "Functions"],
  };

  it("planner system prompt forbids legacy block types and prefers libraries over svg", () => {
    const sys = buildPlannerSystemPrompt();
    expect(sys).toContain("NEVER plan an image, interactive or diagram block");
    // svg is now a capped last resort, not the main tool.
    expect(sys).toContain("At most 3 svg blocks");
    // Nothing may tell the planner to keep the lecture small.
    expect(sys).not.toMatch(/at most \d+ (outline )?topics/i);
  });

  // The old prompt asked for a quiz "ending most topics", which broke the
  // lecture into a series of tests.
  it("planner system prompt prescribes the arc and a single closing quiz", () => {
    const sys = buildPlannerSystemPrompt();
    expect(sys).toContain("THE ARC");
    expect(sys).toContain("Why this matters");
    expect(sys).toContain("Check your understanding");
    expect(sys).toContain("exactly ONE quiz block");
    expect(sys).not.toMatch(/quiz.*ending most topics/i);
  });

  // The per-topic visual quota is gone; the planner must be told when NOT to draw.
  it("planner system prompt permits visual-free topics", () => {
    const sys = buildPlannerSystemPrompt();
    expect(sys).toContain("DO NOT DRAW");
    expect(sys).toContain("Topics with no visual at all are expected and fine");
    expect(sys).not.toContain("HARD REQUIREMENT");
    expect(sys).not.toMatch(/every single outline topic must contain at least one visual/i);
  });

  // Balance matters both ways here: the first live run returned zero visuals
  // for a lesson about a loop mechanism, so "empty is allowed" must not read as
  // "empty is expected".
  it("analyst system prompt weighs visuals both ways and demands concrete examples", () => {
    const sys = buildAnalystSystemPrompt();
    expect(sys).toContain("by judgement, not by quota");
    expect(sys).toContain("Most technical lessons contain 2-4 such ideas");
    expect(sys).toContain("An empty list is the right answer only when");
    expect(sys).toContain("EASIEST FIRST");
    expect(sys).toContain("never a placeholder");
  });

  // The curriculum's per-lesson brief is what stops the pipeline inventing its
  // own scope from a bare topic title. It now reaches the analyst, not the planner.
  it("analyst user message carries the lesson brief as authoritative scope", () => {
    const msg = buildAnalystUserMessage(ctx);
    expect(msg).toContain("What this lesson must cover");
    expect(msg).toContain("warn about off-by-one errors");
    expect(msg).toContain("Sibling lessons in this module");
  });

  it("analyst user message tells the model to infer scope when there is no brief", () => {
    const msg = buildAnalystUserMessage({ ...ctx, topicBrief: undefined });
    expect(msg).not.toContain("What this lesson must cover");
    expect(msg).toContain("infer its scope from the lesson title");
  });

  it("planner user message carries the blueprint instead of the raw brief", () => {
    const msg = buildPlannerUserMessage(ctx, lessonBlueprintSchema.parse(validBlueprint()));
    expect(msg).toContain("LESSON ANALYSIS");
    expect(msg).toContain("1. The sorted precondition");
    expect(msg).toContain("phone-book");
    expect(msg).toContain("[svg] Halving the range");
    expect(msg).toContain('Plan the lecture for the lesson topic: "Loops"');
  });

  // The analyst is the only call that sees the web search results, so the
  // blueprint's `currency` list is the ONLY route by which today's reality
  // reaches the planner and the parallel topic writers. If either projection
  // drops it, every writer silently falls back to its training cutoff.
  it("analyst user message carries the live search block", () => {
    const msg = buildAnalystUserMessage(ctx, "", "CURRENT INFORMATION — live web search\n[1] React 19");
    expect(msg).toContain("CURRENT INFORMATION");
    expect(msg).toContain("React 19");
  });

  it("planner user message carries the currency lines as binding", () => {
    const bp = lessonBlueprintSchema.parse({
      ...validBlueprint(),
      currency: ["Python 3.13 is current; distutils was removed in 3.12"],
    });
    const msg = buildPlannerUserMessage(ctx, bp);
    expect(msg).toContain("CURRENT AS OF TODAY");
    expect(msg).toContain("distutils was removed in 3.12");
  });

  it("topic worker user message carries the currency lines as binding", () => {
    const bp = lessonBlueprintSchema.parse({
      ...validBlueprint(),
      currency: ["Python 3.13 is current; distutils was removed in 3.12"],
    });
    const msg = buildTopicWorkerUserMessage(
      ctx,
      "Loops in Python",
      { id: 1, title: "for loops" },
      [{ type: "paragraph", topicId: 1, brief: "explain" }],
      bp,
      [{ id: 1, title: "for loops", duration: "3:00" }],
    );
    expect(msg).toContain("CURRENT AS OF TODAY");
    expect(msg).toContain("distutils was removed in 3.12");
  });

  it("says nothing about currency when the search found nothing that changes the lesson", () => {
    const bp = lessonBlueprintSchema.parse(validBlueprint());
    expect(bp.currency).toEqual([]);
    expect(buildPlannerUserMessage(ctx, bp)).not.toContain("CURRENT AS OF TODAY");
  });

  it("planner user message states plainly when no visuals were flagged", () => {
    const bp = lessonBlueprintSchema.parse({ ...validBlueprint(), visuals: [] });
    expect(buildPlannerUserMessage(ctx, bp)).toContain("Visuals worth drawing: NONE");
  });

  it("topic worker user message numbers the planned blocks", () => {
    const msg = buildTopicWorkerUserMessage(
      ctx,
      "Loops in Python",
      { id: 2, title: "for loops" },
      [
        { type: "paragraph", topicId: 2, brief: "why loops matter" },
        { type: "code", topicId: 2, brief: "a for loop over a list" },
      ],
      lessonBlueprintSchema.parse(validBlueprint()),
      [
        { id: 1, title: "Why loops", duration: "3:00" },
        { id: 2, title: "for loops", duration: "5:00" },
      ],
    );
    expect(msg).toContain("1. paragraph — why loops matter");
    expect(msg).toContain("2. code — a for loop over a list");
    expect(msg).toContain("emit exactly 2");
  });

  // Parallel writers drift apart without these two: the shared example list and
  // knowing which topic is theirs.
  it("topic worker user message carries the shared examples and marks its own topic", () => {
    const msg = buildTopicWorkerUserMessage(
      ctx,
      "Loops in Python",
      { id: 2, title: "for loops" },
      [{ type: "code", topicId: 2, brief: "the phone-book example" }],
      lessonBlueprintSchema.parse(validBlueprint()),
      [
        { id: 1, title: "Why loops", duration: "3:00" },
        { id: 2, title: "for loops", duration: "5:00" },
      ],
    );
    expect(msg).toContain("phone-book: Finding a name in a 500-page phone book");
    expect(msg).toContain("2. for loops  ← YOU ARE WRITING THIS ONE");
    expect(msg).toContain("1. Why loops");
    // The planning material stays with the planner.
    expect(msg).not.toContain("LESSON ANALYSIS");
  });

  it("topic worker system prompt pins example reuse and one closing quiz", () => {
    const sys = buildTopicWorkerSystemPrompt();
    expect(sys).toContain("use EXACTLY that scenario");
    expect(sys).toContain("ONLY quiz");
    expect(sys).toContain("6-8 questions");
  });

  it("svg worker system prompt pins the diagram palette and forbids scripts", () => {
    const sys = buildSvgWorkerSystemPrompt();
    expect(sys).toContain("var(--dia-1)");
    expect(sys).toContain("var(--dia-1-tint)");
    expect(sys).toContain("<script>");
    // The app's chrome accents are not a data palette and must not leak in.
    expect(sys).not.toContain("--accent-");
  });

  it("svg worker system prompt names the relationship and the text rules", () => {
    const sys = buildSvgWorkerSystemPrompt();
    // The conceptual failure was drawing nesting as siblings.
    expect(sys).toContain("boxes physically INSIDE boxes");
    expect(sys).toContain("text-anchor is REQUIRED");
    expect(sys).toContain("Maximum 40 characters");
    expect(sys).toContain("NEVER white or light text on a saturated fill");
  });
});

const LESSON_CTX: LessonContext = {
  lessonId: "py-abcd-c1m1t1",
  courseTitle: "Python Basics",
  courseDesc: "Learn Python from scratch.",
  level: "Beginner",
  chapterTitle: "Foundations",
  moduleTitle: "Control Flow",
  topicTitle: "Loops",
  topicBrief: "Introduce for and while, the range() call, and warn about off-by-one errors.",
  siblingTopics: ["Conditionals"],
};

describe("buildLessonBlueprint", () => {
  it("returns the parsed blueprint on a valid emission", async () => {
    const { deps } = fakeDeps(toolCallResponse("emit_lesson_blueprint", validBlueprint()));
    const bp = await buildLessonBlueprint(LESSON_CTX, "", "", deps);
    expect(bp.concepts).toHaveLength(2);
    expect(bp.examples[0]!.name).toBe("phone-book");
  });

  it("repairs an invalid blueprint then succeeds", async () => {
    const { deps, create } = fakeDeps(
      toolCallResponse("emit_lesson_blueprint", { ...validBlueprint(), examples: [] }),
      toolCallResponse("emit_lesson_blueprint", validBlueprint()),
    );
    await expect(buildLessonBlueprint(LESSON_CTX, "", "", deps)).resolves.toMatchObject({ scope: expect.any(String) });
    expect(sentMessages(create, 1)).toContain("examples");
  });
});

describe("buildLecturePlan", () => {
  const BLUEPRINT = lessonBlueprintSchema.parse(validBlueprint());

  it("returns the parsed plan on a valid emission", async () => {
    const { deps } = fakeDeps(toolCallResponse("emit_lecture_plan", validPlan()));
    const plan = await buildLecturePlan(LESSON_CTX, BLUEPRINT, deps);
    expect(plan.title).toBe("Binary Search Deep Dive");
    expect(plan.blocks).toHaveLength(6);
  });

  it("repairs when a block references a topic missing from the outline", async () => {
    const bad = validPlan();
    bad.blocks[0]!.topicId = 5;
    const { deps, create } = fakeDeps(
      toolCallResponse("emit_lecture_plan", bad),
      toolCallResponse("emit_lecture_plan", validPlan()),
    );
    await expect(buildLecturePlan(LESSON_CTX, BLUEPRINT, deps)).resolves.toMatchObject({
      title: "Binary Search Deep Dive",
    });
    expect(sentMessages(create, 1)).toContain("not an outline topic id");
  });

  it("repairs a plan that put a checkpoint quiz in every topic", async () => {
    const bad = validPlan();
    bad.blocks.splice(2, 0, { type: "quiz", topicId: 1, brief: "checkpoint" });
    const { deps, create } = fakeDeps(
      toolCallResponse("emit_lecture_plan", bad),
      toolCallResponse("emit_lecture_plan", validPlan()),
    );
    await expect(buildLecturePlan(LESSON_CTX, BLUEPRINT, deps)).resolves.toMatchObject({
      title: "Binary Search Deep Dive",
    });
    expect(sentMessages(create, 1)).toContain("exactly one quiz block");
  });
});

describe("runTopicWorker", () => {
  const topic = { id: 1, title: "Intuition" };
  const planned = [
    { type: "paragraph" as const, topicId: 1, brief: "why loops matter" },
    { type: "code" as const, topicId: 1, brief: "a for loop" },
  ];
  const goodBlocks = [
    { type: "paragraph", text: "Loops repeat work without repeating code." },
    { type: "code", language: "python", code: "for x in [1, 2]:\n    print(x)" },
  ];
  const BLUEPRINT = lessonBlueprintSchema.parse(validBlueprint());
  const OUTLINE = [
    { id: 1, title: "Intuition", duration: "4:30" },
    { id: 2, title: "Implementation", duration: "6:00" },
  ];
  const run = (deps: LlmDeps) => runTopicWorker(LESSON_CTX, "Loops", topic, planned, BLUEPRINT, OUTLINE, deps);

  it("repairs on count mismatch then succeeds", async () => {
    const { deps, create } = fakeDeps(
      toolCallResponse("emit_topic_blocks", { blocks: goodBlocks.slice(0, 1) }),
      toolCallResponse("emit_topic_blocks", { blocks: goodBlocks }),
    );
    const blocks = await run(deps);
    expect(blocks).toHaveLength(2);
    expect(sentMessages(create, 1)).toContain("expected exactly 2 blocks");
  });

  it("forces topicId onto every emitted block", async () => {
    const { deps } = fakeDeps(
      toolCallResponse("emit_topic_blocks", { blocks: goodBlocks.map((b) => ({ ...b, topicId: 9 })) }),
    );
    const blocks = await run(deps);
    expect(blocks.every((b) => b.topicId === 1)).toBe(true);
  });

  it("sends an interactive block back for repair — the type no longer exists", async () => {
    const interactive = [{ type: "interactive", component: "step-through", props: { steps: [] }, alt: "x" }];
    const { deps, create } = fakeDeps(
      toolCallResponse("emit_topic_blocks", { blocks: interactive }),
      toolCallResponse("emit_topic_blocks", { blocks: goodBlocks }),
    );
    await expect(run(deps)).resolves.toHaveLength(2);
    expect(sentMessages(create, 1)).toContain("blocks.0");
  });

  // Observed live: the model omits `type` on ~1 block in 3 when the brief makes
  // it obvious, which used to burn a repair round on most lectures.
  it("backfills a type the model omitted, without overriding one it chose", async () => {
    const raw = { blocks: [{ text: "no type here" }, { type: "mermaid", code: "flowchart TD\n A-->B", alt: "x" }] };
    backfillMissingTypes(raw, [
      { type: "paragraph", topicId: 1, brief: "p" },
      { type: "chart", topicId: 1, brief: "c" },
    ]);
    expect(raw.blocks[0]).toMatchObject({ type: "paragraph" });
    // A substituted type is legitimate and must survive.
    expect(raw.blocks[1]).toMatchObject({ type: "mermaid" });
  });

  it("leaves a mismatched-length emission alone so positions are never guessed", () => {
    const raw = { blocks: [{ text: "only one" }] };
    backfillMissingTypes(raw, [
      { type: "paragraph", topicId: 1, brief: "p" },
      { type: "code", topicId: 1, brief: "c" },
    ]);
    expect(raw.blocks[0]).not.toHaveProperty("type");
  });

  it("sends the shared examples and the full outline to the writer", async () => {
    const { deps, create } = fakeDeps(toolCallResponse("emit_topic_blocks", { blocks: goodBlocks }));
    await run(deps);
    const sent = sentMessages(create, 0);
    expect(sent).toContain("phone-book");
    expect(sent).toContain("YOU ARE WRITING THIS ONE");
  });
});

describe("runSvgWorker", () => {
  const planned = { type: "svg" as const, topicId: 1, brief: "halving animation", animated: true };

  it("returns the emission for a valid SMIL svg", async () => {
    const { deps } = fakeDeps(toolCallResponse("emit_svg_block", { svg: SMIL_SVG, alt: "Halving steps" }));
    const out = await runSvgWorker(LESSON_CTX, "Loops", "Intuition", planned, "s1-", deps);
    expect(out).toMatchObject({ alt: "Halving steps" });
  });

  it("feeds validator issues into the repair round", async () => {
    const dupIds = '<svg viewBox="0 0 9 9"><rect id="a" width="1" height="1"/><circle id="a" r="1"/></svg>';
    const { deps, create } = fakeDeps(
      toolCallResponse("emit_svg_block", { svg: dupIds, alt: "x" }),
      toolCallResponse("emit_svg_block", { svg: GOOD_SVG, alt: "fixed" }),
    );
    await expect(runSvgWorker(LESSON_CTX, "Loops", "Intuition", planned, "s1-", deps)).resolves.toMatchObject({
      alt: "fixed",
    });
    expect(sentMessages(create, 1)).toContain("duplicate id");
  });

  // Only defects code CANNOT repair reach the model — an over-long label needs
  // rewording, so it survives fixSvg and drives a repair round.
  it("feeds an unfixable legibility issue into the repair round", async () => {
    const wordy = GOOD_SVG.replace(">Search range<", `>${"a".repeat(60)}<`);
    const { deps, create } = fakeDeps(
      toolCallResponse("emit_svg_block", { svg: wordy, alt: "x" }),
      toolCallResponse("emit_svg_block", { svg: GOOD_SVG, alt: "fixed" }),
    );
    await expect(runSvgWorker(LESSON_CTX, "Loops", "Intuition", planned, "s1-", deps)).resolves.toMatchObject({
      alt: "fixed",
    });
    expect(sentMessages(create, 1)).toContain("exceed 40 characters");
  });

  // Auto-fix is the first line of defence: a missing text-anchor is repaired in
  // code, so the model is never asked about it and the first attempt succeeds.
  it("auto-fixes a missing text-anchor without spending a repair round", async () => {
    const unanchored = GOOD_SVG.replace(' text-anchor="middle"', "");
    const { deps, create } = fakeDeps(toolCallResponse("emit_svg_block", { svg: unanchored, alt: "first" }));
    const out = await runSvgWorker(LESSON_CTX, "Loops", "Intuition", planned, "s1-", deps);
    expect(out).toMatchObject({ alt: "first" });
    expect(out!.svg).toContain("text-anchor=");
    expect(create).toHaveBeenCalledTimes(1);
  });

  // An untidy diagram teaches far more than a missing one, so legibility is a
  // repair prompt, not a death sentence — unlike the safety checks below.
  it("keeps a merely-untidy drawing when the repair round doesn't fix it", async () => {
    const untidy = GOOD_SVG.replace(' text-anchor="middle"', "");
    const { deps } = fakeDeps(
      toolCallResponse("emit_svg_block", { svg: untidy, alt: "first" }),
      toolCallResponse("emit_svg_block", { svg: untidy, alt: "second" }),
    );
    const out = await runSvgWorker(LESSON_CTX, "Loops", "Intuition", planned, "s1-", deps);
    expect(out).not.toBeNull();
    expect(out!.svg).toContain("<rect");
  });

  it("still drops markup that is unsafe or malformed", async () => {
    const unsafe = '<svg viewBox="0 0 700 340"><script>alert(1)</script></svg>';
    const { deps } = fakeDeps(
      toolCallResponse("emit_svg_block", { svg: unsafe, alt: "x" }),
      toolCallResponse("emit_svg_block", { svg: unsafe, alt: "x" }),
    );
    expect(await runSvgWorker(LESSON_CTX, "Loops", "Intuition", planned, "s1-", deps)).toBeNull();
  });

  it("returns null after two invalid attempts instead of throwing", async () => {
    const { deps } = fakeDeps(
      toolCallResponse("emit_svg_block", { svg: "<div>not svg</div>", alt: "x" }),
      textResponse("cannot draw"),
    );
    await expect(runSvgWorker(LESSON_CTX, "Loops", "Intuition", planned, "s1-", deps)).resolves.toBeNull();
  });
});

describe("makeLecture", () => {
  const topic1Blocks = [
    { type: "heading", text: "Intuition" },
    { type: "paragraph", text: "Binary search halves the range each step." },
  ];
  // Positionally matches validPlan's topic-2 briefs (code, mermaid, quiz); the
  // legacy `diagram` fills the mermaid slot to prove cached types still assemble.
  const topic2Blocks = [
    { type: "code", language: "python", code: "lo, hi = 0, len(xs) - 1" },
    {
      type: "diagram",
      layout: "flow",
      nodes: [{ id: "a", label: "Split" }, { id: "b", label: "Compare" }],
      edges: [{ from: "a", to: "b" }],
    },
    {
      type: "quiz",
      questions: [
        { question: "Complexity?", options: ["O(n)", "O(log n)"], correctIndex: 1, explanation: "It halves each step." },
      ],
    },
  ];

  function pipelineDeps(overrides: { worker?: ReturnType<typeof fakeDeps>; svg?: ReturnType<typeof fakeDeps> } = {}) {
    const classifier = fakeDeps(toolCallResponse("emit_lesson_kind", { kind: "concept", reason: "teaches loops" }));
    const analyst = fakeDeps(toolCallResponse("emit_lesson_blueprint", validBlueprint()));
    const planner = fakeDeps(toolCallResponse("emit_lecture_plan", validPlan()));
    const worker =
      overrides.worker ??
      fakeDeps(
        toolCallResponse("emit_topic_blocks", { blocks: topic1Blocks }),
        toolCallResponse("emit_topic_blocks", { blocks: topic2Blocks }),
      );
    const svg = overrides.svg ?? fakeDeps(toolCallResponse("emit_svg_block", { svg: GOOD_SVG, alt: "Halving ranges" }));
    return {
      classifier: classifier.deps,
      analyst: analyst.deps,
      planner: planner.deps,
      worker: worker.deps,
      svg: svg.deps,
    };
  }

  it("assembles blocks in plan order with sequential ids", async () => {
    const made = await makeLecture(LESSON_CTX, pipelineDeps());
    expect(made.language).toBe("en");
    expect(made.outline).toHaveLength(2);
    expect(made.blocks.map((b) => b.type)).toEqual(["heading", "paragraph", "svg", "code", "diagram", "quiz"]);
    expect(made.blocks.map((b) => b.id)).toEqual(["b1", "b2", "b3", "b4", "b5", "b6"]);
    const svgBlock = made.blocks[2] as { alt?: string; topicId?: number };
    expect(svgBlock.alt).toBe("Halving ranges");
    expect(svgBlock.topicId).toBe(1);
    // The lecture's single quiz closes it.
    expect(made.blocks.filter((b) => b.type === "quiz")).toHaveLength(1);
    expect(made.blocks.at(-1)!.type).toBe("quiz");
  });

  it("reports every pipeline stage through onProgress, in order", async () => {
    const events: LectureProgressEvent[] = [];
    await makeLecture(LESSON_CTX, pipelineDeps(), (ev) => events.push(ev));

    // analyzing -> classified -> analyzed -> planning -> planned -> (2 topic
    // starts/dones + 1 svg start/done, any interleaving since they run
    // concurrently) -> assembling.
    expect(events[0]).toEqual({ stage: "analyzing" });
    expect(events[1]).toEqual({ stage: "classified", kind: "concept" });
    expect(events[2]).toEqual({ stage: "analyzed", concepts: 2, visuals: 1 });
    expect(events[3]).toEqual({ stage: "planning" });
    expect(events[4]).toEqual({ stage: "planned", topics: 2, easyBlocks: 5, svgBlocks: 1 });
    expect(events.at(-1)).toEqual({ stage: "assembling" });

    // The two topic workers run concurrently, so "start"/"done" can interleave
    // across them — only each topic's own start-before-done order is fixed.
    const topicEvents = events.filter((e) => e.stage === "topic");
    expect(topicEvents).toHaveLength(4);
    expect(topicEvents.filter((e) => e.status === "start")).toHaveLength(2);
    expect(topicEvents.filter((e) => e.status === "done")).toHaveLength(2);
    expect(topicEvents.every((e) => e.total === 2)).toBe(true);
    for (const index of [0, 1]) {
      const forThisTopic = topicEvents.filter((e) => e.index === index);
      expect(forThisTopic.map((e) => e.status)).toEqual(["start", "done"]);
    }

    const svgEvents = events.filter((e) => e.stage === "svg");
    expect(svgEvents).toEqual([
      { stage: "svg", status: "start", index: 0, total: 1 },
      { stage: "svg", status: "done", index: 0, total: 1 },
    ]);
  });

  it("reports a dropped svg through onProgress instead of a done event", async () => {
    const svg = fakeDeps(toolCallResponse("emit_svg_block", { svg: "<div>no</div>", alt: "x" }), textResponse("no"));
    const events: LectureProgressEvent[] = [];
    await makeLecture(LESSON_CTX, pipelineDeps({ svg }), (ev) => events.push(ev));
    expect(events.filter((e) => e.stage === "svg")).toEqual([
      { stage: "svg", status: "start", index: 0, total: 1 },
      { stage: "svg", status: "dropped", index: 0, total: 1 },
    ]);
  });

  it("drops a failed svg block without id gaps", async () => {
    const svg = fakeDeps(toolCallResponse("emit_svg_block", { svg: "<div>no</div>", alt: "x" }), textResponse("no"));
    const made = await makeLecture(LESSON_CTX, pipelineDeps({ svg }));
    expect(made.blocks.map((b) => b.type)).toEqual(["heading", "paragraph", "code", "diagram", "quiz"]);
    expect(made.blocks.map((b) => b.id)).toEqual(["b1", "b2", "b3", "b4", "b5"]);
  });

  it("propagates a 502 when a topic worker fails both attempts", async () => {
    const worker = fakeDeps(textResponse("no"), textResponse("still no"), textResponse("no"), textResponse("no"));
    await expect(makeLecture(LESSON_CTX, pipelineDeps({ worker }))).rejects.toMatchObject({ statusCode: 502 });
  });
});

describe("resolveLectureDeps", () => {
  it("throws 503 when no OpenAI-compatible provider is configured", () => {
    // tests/setup.ts forces LLM_PROVIDER=google
    try {
      resolveLectureDeps("planner");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).statusCode).toBe(503);
    }
  });

  it("svgDefaultModel defaults to the cheap model, namespaced per provider", () => {
    // The render→measure→fix→vision loop cleans up a weaker drawing, so the
    // cheap model is the default; LECTURE_SVG_MODEL trades cost back if wanted.
    expect(svgDefaultModel("openrouter")).toBe("openai/gpt-5.6-luna");
    expect(svgDefaultModel("openai")).toBe("gpt-5.6-luna");
  });
});
