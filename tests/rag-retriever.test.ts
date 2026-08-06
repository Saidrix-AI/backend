import { describe, expect, it } from "vitest";
import {
  formatForModel,
  toSources,
  retrieveKnowledge,
  retrieveGrounding,
  type RetrievedChunk,
} from "../src/rag/retriever.js";

const CHUNKS: RetrievedChunk[] = [
  {
    skill: "React",
    category: "Frontend Development",
    level: "beginner",
    section: "🟢 BEGINNER",
    sourcePath: "Course-Content/02-Frontend-Development/React/README.md",
    text: "Components are the building blocks of a React UI.",
    score: 0.91,
  },
  {
    skill: "React",
    category: "Frontend Development",
    level: "intermediate",
    section: "State management",
    sourcePath: "Course-Content/02-Frontend-Development/React/README.md",
    text: "useState and useReducer manage local component state.",
    score: 0.84,
  },
];

describe("formatForModel", () => {
  it("renders numbered, cited chunks", () => {
    const out = formatForModel(CHUNKS);
    expect(out).toContain("[1] React — 🟢 BEGINNER (beginner)");
    expect(out).toContain("[2] React — State management (intermediate)");
    expect(out).toContain("building blocks");
  });

  it("handles the empty case", () => {
    expect(formatForModel([])).toBe("No matching curriculum sections found.");
  });
});

describe("toSources", () => {
  it("maps chunks to the SearchSource shape the chat UI already renders", () => {
    const sources = toSources(CHUNKS);
    expect(sources).toHaveLength(2);
    expect(sources[0]).toMatchObject({
      title: "React — 🟢 BEGINNER",
      url: "Course-Content/02-Frontend-Development/React/README.md",
    });
    expect(sources[0]!.content!.length).toBeLessThanOrEqual(300);
  });
});

describe("degradation guard (RAG disabled in tests)", () => {
  it("retrieveKnowledge returns [] without throwing", async () => {
    await expect(retrieveKnowledge("anything")).resolves.toEqual([]);
  });

  it("retrieveGrounding returns an empty string", async () => {
    await expect(retrieveGrounding("anything")).resolves.toBe("");
  });

  it("empty query short-circuits to []", async () => {
    await expect(retrieveKnowledge("   ")).resolves.toEqual([]);
  });
});
