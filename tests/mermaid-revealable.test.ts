import { describe, expect, it } from "vitest";
import { checkMermaidBlocks } from "../src/agents/lecture-maker/mermaid.js";
import { MAX_REVEALABLE_NODES, revealBlocker } from "../src/agents/lecture-maker/revealable.js";
import { env } from "../src/config/env.js";
import type { EasyBlock } from "../src/agents/lecture-maker/schema.js";

/**
 * The generation-time mirror of `voice-service/app/mermaid_plan.py`.
 *
 * These cases are not arbitrary: each one is a diagram the lecture-maker's
 * prompts would happily have produced before this gate existed, and each one
 * would have cost the class its part-by-part reveal silently — the tutor would
 * simply have shown the picture whole, and nobody would have known a feature
 * had quietly stopped working. That silence is why the rules are checked rather
 * than merely asked for.
 *
 * Two of them come straight from the old prompt's own worked examples.
 */

const GOOD = `flowchart TD
  Request[A file is requested] --> Cache{Is it cached?}
  Cache -->|yes| Hit[Serve the stored copy]
  Cache -->|no| Origin[Ask the origin server]
  Origin --> Store[Store it for next time]`;

describe("revealBlocker", () => {
  it("accepts the shape the prompt now teaches", () => {
    expect(revealBlocker(GOOD)).toBeNull();
    expect(revealBlocker("graph LR\n  A[One] --> B[Two]")).toBeNull();
  });

  it("rejects the diagram kinds the old prompt offered as equal choices", () => {
    // Both of these were worked examples in the worker prompt. They parse
    // perfectly, they teach fine, and they cannot be revealed — every other
    // diagram type lays its DOM ids out differently.
    expect(revealBlocker("sequenceDiagram\n  Client->>Server: GET /user")).toMatch(/flowchart/);
    expect(revealBlocker("stateDiagram-v2\n  [*] --> Idle")).toMatch(/flowchart/);
    expect(revealBlocker("mindmap\n  root((core))")).toMatch(/flowchart/);
  });

  it("rejects the directives a reveal cannot express", () => {
    expect(revealBlocker(`${GOOD}\n  subgraph edge\n  end`)).toMatch(/subgraph/);
    expect(revealBlocker(`${GOOD}\n  classDef warn fill:#f00`)).toMatch(/classDef/);
    expect(revealBlocker(`${GOOD}\n  style Cache fill:#eee`)).toMatch(/style/);
    expect(revealBlocker(`${GOOD}\n  click Cache "https://x"`)).toMatch(/click/);
    expect(revealBlocker("flowchart TD\n  A[One] --o B[Two] ")).toMatch(/--o/);
    expect(revealBlocker("flowchart TD\n  A e1@--> B")).toMatch(/edge ids/);
  });

  it("does not read a LABEL as structure", () => {
    // The whole reason labels are stripped by depth rather than by regex: a
    // label may legally contain the very syntax being looked for, and a naive
    // check would reject a perfectly good diagram for the word inside a box.
    expect(revealBlocker('flowchart TD\n  A["style it with CSS"] --> B[Done]')).toBeNull();
    expect(revealBlocker('flowchart TD\n  A["click here first"] --> B[Done]')).toBeNull();
    expect(revealBlocker('flowchart TD\n  A["Client --> DB"] --> B[Done]')).toBeNull();
  });

  it("names the first non-blank line, not line one, when the header is wrong", () => {
    const withLead = `\n\n  sequenceDiagram\n  A->>B: hi`;
    expect(revealBlocker(withLead)).toMatch(/sequenceDiagram/);
  });

  it("works with no browser at all", () => {
    // tests/setup.ts runs with LECTURE_SVG_RENDER_ENABLED=false, which is also
    // a supported production configuration ("if the deploy has no browser, set
    // this false and lectures still generate"). The source-only half of the
    // check must hold there — putting it behind the render call would mean the
    // whole gate quietly did nothing on those deployments.
    expect(env.LECTURE_SVG_RENDER_ENABLED).toBe(false);
    expect(revealBlocker("sequenceDiagram\n  A->>B: hi")).not.toBeNull();
  });

  it("exports the node ceiling the prompts now quote", () => {
    // The old prompt said "~9 nodes" while the gate allowed 8 — a suggestion
    // one over its own ceiling. Pinning the constant keeps the two in step.
    expect(MAX_REVEALABLE_NODES).toBe(8);
  });
});

describe("checkMermaidBlocks severity", () => {
  const block = (code: string) => [{ type: "mermaid", code, alt: "d" } as unknown as EasyBlock];

  it("asks once for a revealable diagram, then accepts what it got", async () => {
    // The whole point of the soft severity. A rejection costs a repair round,
    // and a SECOND failure drops the topic or 502s the lecture — so spending a
    // lecture's topic on an animation that would merely have been nice is the
    // wrong trade. One nudge, then take the diagram as it is: the tutor shows
    // it whole and talks through it, which is a designed outcome, not a defect.
    const bad = block("sequenceDiagram\n  Client->>Server: GET /user");

    const first = await checkMermaidBlocks(bad, { isFinal: false });
    expect(first).toMatch(/part by part/);

    const last = await checkMermaidBlocks(bad, { isFinal: true });
    expect(last, "the final attempt must not fail a lecture over this").toBeNull();
  });

  it("says nothing about a diagram that is already revealable", async () => {
    expect(await checkMermaidBlocks(block(GOOD), { isFinal: false })).toBeNull();
  });

  it("ignores lectures with no diagrams", async () => {
    expect(await checkMermaidBlocks([], { isFinal: false })).toBeNull();
  });
});
