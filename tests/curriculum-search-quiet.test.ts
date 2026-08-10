import { describe, expect, it, vi } from "vitest";

/**
 * The curriculum search must ground the model WITHOUT narrating itself into the
 * transcript. It used to emit `sources`, which rendered as a "From the knowledge
 * base" strip of unclickable internal file paths under nearly every answer.
 *
 * Two halves of the contract are pinned here; the third (not persisting the
 * "Curriculum search complete" action) lives in chat-actions-hidden.test.ts.
 */

const CHUNKS = [
  {
    skill: "Express.js",
    category: "Backend Development",
    level: "beginner",
    section: "🟢 BEGINNER",
    sourcePath: "Course-Content/03-Backend-Development/Express.js/README.md",
    text: "Middleware runs in the order it is registered.",
    score: 0.9,
  },
];

vi.mock("../src/rag/retriever.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/rag/retriever.js")>();
  return { ...actual, retrieveKnowledge: vi.fn().mockResolvedValue(CHUNKS) };
});

const { courseContentSearchToolDef } = await import("../src/agents/tools/course-content-search.js");

describe("search_course_content stays out of the transcript", () => {
  it("returns no sources, so nothing renders a citation strip", async () => {
    const out = await courseContentSearchToolDef.run({ userId: "u1" }, { query: "express middleware" });
    expect(out.ok).toBe(true);
    expect(out.sources).toBeUndefined();
  });

  it("still feeds the retrieved text to the model", async () => {
    const out = await courseContentSearchToolDef.run({ userId: "u1" }, { query: "express middleware" });
    // The whole point of the tool: hiding the UI artifacts must not cost the
    // grounding, or answers quietly get worse with nothing to show for it.
    expect(out.modelText).toContain("Middleware runs in the order it is registered.");
    expect(out.modelText).toContain("Express.js");
  });
});
