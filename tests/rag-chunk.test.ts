import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { chunkFile, chunkId, chunkHash, embeddingText } from "../src/rag/chunk.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const WEBRTC = path.resolve(
  here,
  "../../Course-Content/16-Emerging-and-Specialized/WebRTC/README.md",
);
const REL = "Course-Content/16-Emerging-and-Specialized/WebRTC/README.md";

describe("chunkFile (curriculum splitter)", () => {
  const md = readFileSync(WEBRTC, "utf8");
  const chunks = chunkFile(md, REL);

  it("derives skill from the H1 title and category from the path", () => {
    expect(chunks.length).toBeGreaterThan(5);
    for (const c of chunks) {
      expect(c.skill).toBe("WebRTC (Real-Time Communication)");
      expect(c.category).toBe("Emerging and Specialized");
      expect(c.categoryNumber).toBe(16);
      expect(c.sourcePath).toBe(REL);
    }
  });

  it("tags the three difficulty levels from the 🟢/🟡/🔴 headings", () => {
    const levels = new Set(chunks.map((c) => c.level));
    expect(levels.has("beginner")).toBe(true);
    expect(levels.has("intermediate")).toBe(true);
    expect(levels.has("advanced")).toBe(true);
    expect(levels.has("overview")).toBe(true); // Overview/Glossary/etc.

    // A chunk under "## 🟢 BEGINNER" (or its ### modules) must be beginner-tagged.
    const beginner = chunks.filter((c) => c.level === "beginner");
    expect(beginner.length).toBeGreaterThan(0);
    expect(beginner.every((c) => c.section.length > 0)).toBe(true);
  });

  it("produces sequential, unique chunk ids and bounded chunk sizes", () => {
    const ids = chunks.map(chunkId);
    expect(new Set(ids).size).toBe(ids.length); // unique
    chunks.forEach((c, i) => expect(c.chunkIndex).toBe(i)); // sequential
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(4200); // MAX_CHARS*1.5
  });

  it("hashes content and builds embedding text with skill/section context", () => {
    const c = chunks[0]!;
    expect(chunkHash(c)).toMatch(/^[0-9a-f]{40}$/); // sha1 hex
    expect(embeddingText(c)).toContain(c.skill);
    expect(embeddingText(c)).toContain(c.section);
  });
});
