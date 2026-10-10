import { afterEach, describe, expect, it, vi } from "vitest";

// No browser: the one situation the syntax gate cannot see through.
vi.mock("../src/agents/lecture-maker/browser.js", () => ({
  parseMermaidCodes: vi.fn(async () => null),
}));

const { checkMermaidBlocks } = await import("../src/agents/lecture-maker/mermaid.js");
const { env } = await import("../src/config/env.js");
import type { EasyBlock } from "../src/agents/lecture-maker/schema.js";

/**
 * The gate returned null quietly when Chromium was missing — which it was, on
 * the dev machine, after a playwright-core bump. A diagram with a quote in a
 * bare label then reached a live class as "could not be rendered" (lesson
 * w8q5ij2ma4-c1m2t2, block b13, 2026-09-29). Accepting is still right; being
 * silent about it was the bug.
 */
describe("checkMermaidBlocks without a browser", () => {
  const original = env.LECTURE_SVG_RENDER_ENABLED;
  afterEach(() => {
    (env as { LECTURE_SVG_RENDER_ENABLED: boolean }).LECTURE_SVG_RENDER_ENABLED = original;
    vi.restoreAllMocks();
  });

  const blocks = () =>
    [{ type: "mermaid", code: 'flowchart TD\n  A[x] --> B[y]', alt: "d" }] as unknown as EasyBlock[];

  it("accepts the lecture but says the diagrams went unchecked", async () => {
    (env as { LECTURE_SVG_RENDER_ENABLED: boolean }).LECTURE_SVG_RENDER_ENABLED = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(await checkMermaidBlocks(blocks(), { isFinal: true })).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/WITHOUT a syntax check/));
  });

  it("stays quiet when checking was switched off on purpose", async () => {
    (env as { LECTURE_SVG_RENDER_ENABLED: boolean }).LECTURE_SVG_RENDER_ENABLED = false;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(await checkMermaidBlocks(blocks(), { isFinal: true })).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });
});
