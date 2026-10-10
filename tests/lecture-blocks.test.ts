import { describe, expect, it } from "vitest";

import { easyBlockSchema, finalBlockSchema } from "../src/agents/lecture-maker/schema.js";
import { WRITER_BLOCK_TYPES } from "../src/agents/lecture-maker/sections.js";
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

  // The diagram that broke a live Bangla HTML class (2026-09-29). Measured in
  // Chromium on Mermaid 11.16: `\"` in a label is a parse error, `#quot;`
  // renders as the literal "&quot;", raw `<head>` is silently deleted by strict
  // mode, and `'` / `#lt;` / `#gt;` render as written. The frontend applies the
  // same rewrite at render time for lectures already stored.
  it("rewrites escaped quotes and HTML tags inside labels so they render", () => {
    const fixed = fixMermaidCode(
      'flowchart TD\n  Doctype["<!DOCTYPE html> declaration"] --> Root["<html lang=\\"bn\\"> root"]',
    );
    expect(fixed).toContain(`Root["#lt;html lang='bn'#gt; root"]`);
    expect(fixed).toContain('Doctype["#lt;!DOCTYPE html#gt; declaration"]');
    expect(fixed).not.toContain('\\"');
  });

  it("escapes the tags in a label it had to quote itself", () => {
    expect(fixMermaidCode("flowchart TD\n  A[<head> info]")).toContain('A["#lt;head#gt; info"]');
  });

  // The next class of the same course (block b13): a quote inside a bare label.
  it("quotes a bare label that has a double quote inside it", () => {
    const fixed = fixMermaidCode('flowchart TD\n  B[HTML bytes] --> C[charset="UTF-8" নির্দেশ]');
    expect(fixed).toContain(`C["charset='UTF-8' নির্দেশ"]`);
    expect(fixed).toContain("B[HTML bytes] --> ");
  });

  it("is idempotent on labels it rewrote", () => {
    const once = fixMermaidCode('flowchart TD\n  R["<html lang=\\"bn\\">"] --> H[<head>]');
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

  it("is not offered to the section writer", () => {
    expect(WRITER_BLOCK_TYPES).not.toContain("resources");
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
