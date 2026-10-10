import { afterAll, describe, expect, it } from "vitest";
import { closeBrowser, outlineMermaid } from "../src/agents/lecture-maker/browser.js";
import { env } from "../src/config/env.js";

/**
 * The backend's advisory audit of a drawing's reveal plan.
 *
 * Skipped unless diagram rendering is on — tests/setup.ts turns it off so a
 * unit suite never launches Chromium, and svg-browser.test.ts does the same
 * dance. That skip is not a gap: the audit is advisory precisely BECAUSE it is
 * often unavailable, so "returns null when it cannot run" is as much a part of
 * the contract as the answer itself, and that half is covered below without a
 * browser.
 */

const RENDER = process.env.RUN_BROWSER_TESTS === "1";

const SOURCE = `flowchart TD
  Client[Browser sends a request] --> Edge{In the cache?}
  Edge -->|yes| Cache[(Redis)]
  Edge -->|no| Origin[Origin server]
  Origin --> Cache
`;

afterAll(async () => {
  await closeBrowser();
});

describe("outlineMermaid", () => {
  it("returns null rather than throwing when rendering is disabled", async () => {
    // The state tests/setup.ts puts the suite in, and the state a deployment
    // without Chromium is in. Callers must be able to treat it as "no opinion".
    expect(env.LECTURE_SVG_RENDER_ENABLED).toBe(false);
    expect(await outlineMermaid(SOURCE)).toBeNull();
  });

  it("returns null for an empty source without touching the browser", async () => {
    expect(await outlineMermaid("   ")).toBeNull();
  });

  it.runIf(RENDER)("reads back the keys mermaid really emitted", async () => {
    (env as { LECTURE_SVG_RENDER_ENABLED: boolean }).LECTURE_SVG_RENDER_ENABLED = true;
    try {
      const started = Date.now();
      const outline = await outlineMermaid(SOURCE);
      const took = Date.now() - started;

      expect(outline).not.toBeNull();
      expect(outline!.diagramType).toMatch(/^flowchart/);
      expect(outline!.nodeKeys.sort()).toEqual(["Cache", "Client", "Edge", "Origin"]);
      expect(outline!.edgeIds).toContain("L_Client_Edge_0");
      // This runs inside a live class while a student listens to a stall line.
      // If it ever costs more than a couple of seconds it is not worth having.
      expect(took).toBeLessThan(8000);
      console.log(`[outline] ${took}ms`);
    } finally {
      (env as { LECTURE_SVG_RENDER_ENABLED: boolean }).LECTURE_SVG_RENDER_ENABLED = false;
    }
  });

  it.runIf(RENDER)("says nothing useful about a non-flowchart, rather than guessing", async () => {
    (env as { LECTURE_SVG_RENDER_ENABLED: boolean }).LECTURE_SVG_RENDER_ENABLED = true;
    try {
      const outline = await outlineMermaid("sequenceDiagram\n  A->>B: hello\n");
      // It renders fine — it simply is not a flowchart, and its ids follow a
      // different scheme. The caller checks diagramType before believing the
      // empty key list means anything.
      expect(outline?.diagramType.startsWith("flowchart")).toBeFalsy();
    } finally {
      (env as { LECTURE_SVG_RENDER_ENABLED: boolean }).LECTURE_SVG_RENDER_ENABLED = false;
    }
  });

  it.runIf(RENDER)("batch mode queues instead of taking the live class's slots", async () => {
    // The live budget is 2 reserved slots that never queue, so a class waiting
    // on a stall line always gets an answer or a fast "I don't know". A lecture
    // BUILD calling this must not be able to occupy them — nobody is listening
    // to a build, and a background job stalling a paid class is the exact
    // failure the separate budget exists to prevent.
    (env as { LECTURE_SVG_RENDER_ENABLED: boolean }).LECTURE_SVG_RENDER_ENABLED = true;
    try {
      // Four concurrent batch outlines — twice the live budget. If batch mode
      // were taking live slots, two of these would return null immediately.
      const results = await Promise.all(
        Array.from({ length: 4 }, () => outlineMermaid(SOURCE, { live: false })),
      );
      for (const outline of results) {
        expect(outline, "a batch call must wait its turn, never give up").not.toBeNull();
        expect(outline!.nodeKeys.length).toBe(4);
      }
    } finally {
      (env as { LECTURE_SVG_RENDER_ENABLED: boolean }).LECTURE_SVG_RENDER_ENABLED = false;
    }
  });

  it.runIf(RENDER)("returns null for a diagram mermaid cannot parse", async () => {
    (env as { LECTURE_SVG_RENDER_ENABLED: boolean }).LECTURE_SVG_RENDER_ENABLED = true;
    try {
      expect(await outlineMermaid("flowchart TD\n  A --> --> B\n")).toBeNull();
    } finally {
      (env as { LECTURE_SVG_RENDER_ENABLED: boolean }).LECTURE_SVG_RENDER_ENABLED = false;
    }
  });
});
