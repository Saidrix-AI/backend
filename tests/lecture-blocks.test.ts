import { describe, expect, it } from "vitest";

import {
  easyBlockSchema,
  emitTopicBlocksTool,
  finalBlockSchema,
  lecturePlanSchema,
  BLOCK_PLAN_TYPES,
} from "../src/agents/lecture-maker/schema.js";
import { fixMermaidCode } from "../src/agents/lecture-maker/mermaid.js";

/**
 * The library-backed visual blocks (mermaid, tree) and the retirement of the
 * `diagram` plan type. These are the contracts the topic worker emits and the
 * planner may choose, so a regression here ships a block the frontend can't
 * render or lets the planner pick a type that no longer exists.
 */

describe("mermaid block", () => {
  it("accepts a mermaid block with code and alt", () => {
    const parsed = easyBlockSchema.safeParse({
      type: "mermaid",
      code: "flowchart TD\n  A[Start] --> B[End]",
      alt: "A two-step flow from start to end.",
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects a mermaid block with no alt", () => {
    const parsed = easyBlockSchema.safeParse({ type: "mermaid", code: "flowchart TD\n A-->B" });
    expect(parsed.success).toBe(false);
  });

  it("rejects an empty mermaid code", () => {
    const parsed = easyBlockSchema.safeParse({ type: "mermaid", code: "x", alt: "too short" });
    expect(parsed.success).toBe(false);
  });
});

describe("tree block", () => {
  it("accepts a nested tree with attributes", () => {
    const parsed = easyBlockSchema.safeParse({
      type: "tree",
      alt: "A small binary search tree rooted at 8.",
      root: {
        name: "8",
        children: [
          { name: "3", attributes: { height: "1" }, children: [{ name: "1" }, { name: "6" }] },
          { name: "10" },
        ],
      },
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects a tree whose root has no name", () => {
    const parsed = easyBlockSchema.safeParse({
      type: "tree",
      alt: "broken",
      root: { children: [{ name: "a" }] },
    });
    expect(parsed.success).toBe(false);
  });
});

describe("table block", () => {
  it("accepts a table with columns and rows", () => {
    const parsed = easyBlockSchema.safeParse({
      type: "table",
      columns: ["Method", "Idempotent", "Safe"],
      rows: [
        ["GET", "yes", "yes"],
        ["POST", "no", "no"],
        ["PUT", "yes", "no"],
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects a table with no columns", () => {
    expect(easyBlockSchema.safeParse({ type: "table", columns: [], rows: [["a"]] }).success).toBe(false);
  });

  it("rejects a table with no rows", () => {
    expect(easyBlockSchema.safeParse({ type: "table", columns: ["A"], rows: [] }).success).toBe(false);
  });
});

describe("math block", () => {
  it("accepts a display equation", () => {
    const parsed = easyBlockSchema.safeParse({
      type: "math",
      tex: "\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}",
      display: true,
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects empty tex", () => {
    expect(easyBlockSchema.safeParse({ type: "math", tex: "" }).success).toBe(false);
  });
});

// Verified against a real Mermaid parser in Chromium: the two failing cases
// below parse after fixing, and every untouched case parsed before and after.
describe("fixMermaidCode", () => {
  it("quotes a label whose parentheses break the parser", () => {
    expect(fixMermaidCode("flowchart TD\n  A[Start] --> B[range(n)]")).toContain('B["range(n)"]');
    expect(fixMermaidCode("flowchart TD\n  A[Start Loop] --> B[range(start, stop)]")).toContain(
      'B["range(start, stop)"]',
    );
  });

  it("leaves clean labels and other diagram kinds untouched", () => {
    for (const code of [
      "flowchart TD\n  A[Start] --> B[Middle]\n  B --> C{Done?}\n  C -->|yes| D[End]",
      'flowchart TD\n  A["already quoted (fine)"] --> B[Plain]',
      "sequenceDiagram\n  Client->>Server: GET /user",
      "stateDiagram-v2\n  [*] --> Idle\n  Idle --> Loading: fetch",
      "flowchart LR\n  A[List: 5.99, 12.49] --> B[total += price]",
      "mindmap\n  root((Loops))\n    For",
    ]) {
      expect(fixMermaidCode(code)).toBe(code);
    }
  });

  it("does not double-quote a label it already fixed", () => {
    const once = fixMermaidCode("flowchart TD\n  A[range(n)]");
    expect(fixMermaidCode(once)).toBe(once);
  });
});

/**
 * The resources block is the one block type whose content comes from outside
 * the model: every link is copied from a live search result. What makes an
 * invented URL impossible is that no model in the pipeline can emit this type
 * at all — so these four locks ARE the feature's safety property, not incidental
 * schema trivia. If any of them loosens, a topic writer can start inventing
 * links and nothing else in the system would notice.
 */
describe("resources block", () => {
  const link = {
    kind: "doc",
    title: "React reference",
    url: "https://react.dev/reference/react",
    domain: "react.dev",
    why: "The exact behaviour of every hook.",
  };
  const block = { type: "resources", intro: "A few places to go next.", links: [link] };

  it("cannot be emitted by a topic worker", () => {
    expect(easyBlockSchema.safeParse(block).success).toBe(false);
  });

  it("cannot be planned", () => {
    expect(BLOCK_PLAN_TYPES).not.toContain("resources");
  });

  it("is not offered to the topic worker's tool", () => {
    const props = emitTopicBlocksTool.function.parameters as {
      properties: { blocks: { items: { properties: { type: { enum: string[] } } } } };
    };
    expect(props.properties.blocks.items.properties.type.enum).not.toContain("resources");
  });

  it("is accepted in the assembled document, with an id", () => {
    expect(finalBlockSchema.safeParse({ ...block, id: "b42", topicId: 9 }).success).toBe(true);
  });

  it("rejects a second video — one is the whole point", () => {
    const video = { ...link, kind: "video", url: "https://www.youtube.com/watch?v=aaaaaaaaaaa" };
    const two = {
      ...block,
      id: "b42",
      links: [video, { ...video, url: "https://www.youtube.com/watch?v=bbbbbbbbbbb" }],
    };
    expect(finalBlockSchema.safeParse(two).success).toBe(false);
  });

  it("rejects a link with no url", () => {
    const noUrl = { ...block, id: "b42", links: [{ ...link, url: "" }] };
    expect(finalBlockSchema.safeParse(noUrl).success).toBe(false);
  });
});

describe("planner block types", () => {
  it("offers mermaid, tree, table and math, and no longer offers diagram", () => {
    expect(BLOCK_PLAN_TYPES).toContain("mermaid");
    expect(BLOCK_PLAN_TYPES).toContain("tree");
    expect(BLOCK_PLAN_TYPES).toContain("table");
    expect(BLOCK_PLAN_TYPES).toContain("math");
    expect(BLOCK_PLAN_TYPES).not.toContain("diagram");
  });

  // Every visual kind is plannable anywhere, including nowhere: the per-topic
  // quota that forced one into each topic has been removed, and where a picture
  // earns its place is decided by the lesson analyst instead.
  it("accepts any block type as a topic's only content, visual or not", () => {
    const plan = (blockType: string) => ({
      title: "V",
      outline: [
        { id: 1, title: "One", duration: "3:00" },
        { id: 2, title: "Two", duration: "3:00" },
      ],
      blocks: [
        { type: "heading", topicId: 1, brief: "h" },
        { type: blockType, topicId: 1, brief: "x" },
        { type: "paragraph", topicId: 1, brief: "p" },
        { type: "mermaid", topicId: 2, brief: "v2" },
        { type: "paragraph", topicId: 2, brief: "p2" },
        { type: "quiz", topicId: 2, brief: "q" },
      ],
    });
    for (const type of ["table", "math", "paragraph", "mermaid", "tree", "chart", "code"]) {
      expect(lecturePlanSchema.safeParse(plan(type)).success).toBe(true);
    }
  });

  it("rejects a plan that still uses the retired diagram type", () => {
    const plan = {
      title: "Legacy",
      outline: [
        { id: 1, title: "One", duration: "3:00" },
        { id: 2, title: "Two", duration: "3:00" },
      ],
      blocks: [
        { type: "heading", topicId: 1, brief: "h" },
        { type: "mermaid", topicId: 1, brief: "v1" },
        { type: "paragraph", topicId: 1, brief: "p" },
        { type: "diagram", topicId: 2, brief: "old" },
        { type: "paragraph", topicId: 2, brief: "p2" },
        { type: "quiz", topicId: 2, brief: "q" },
      ],
    };
    // Fails on the type enum: diagram is no longer a plannable block.
    expect(lecturePlanSchema.safeParse(plan).success).toBe(false);
  });

  it("accepts an entirely visual-free plan for a genuinely verbal lesson", () => {
    const plan = {
      title: "Verbal",
      outline: [
        { id: 1, title: "One", duration: "3:00" },
        { id: 2, title: "Two", duration: "3:00" },
      ],
      blocks: [
        { type: "heading", topicId: 1, brief: "h" },
        { type: "paragraph", topicId: 1, brief: "p" },
        { type: "list", topicId: 1, brief: "the rules" },
        { type: "table", topicId: 2, brief: "comparison" },
        { type: "paragraph", topicId: 2, brief: "p2" },
        { type: "quiz", topicId: 2, brief: "q" },
      ],
    };
    expect(lecturePlanSchema.safeParse(plan).success).toBe(true);
  });
});
