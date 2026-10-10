import { describe, expect, it } from "vitest";
import { chunkFile, mergeSmallChunks } from "../src/rag/chunk.js";
import { pdfCategory, pdfTextToMarkdown } from "../src/rag/pdfText.js";

const PAGE = `Python Foundation Course

One complete foundation course

Course field    Details

Tools and setup

Supported interpreter, venv and pip.

Module 1 Syntax and values

Indentation; names; numbers.
Practice: Create a validated calculator.
                                                  1
\fModule 2 Control and functions

Conditions; loops.`;

describe("lesson PDF ingestion", () => {
  it("recovers title, section and module headings and joins table columns", () => {
    const md = pdfTextToMarkdown(PAGE);
    expect(md.startsWith("# Python Foundation Course")).toBe(true);
    expect(md).toContain("## Tools and setup");
    expect(md).toContain("### Module 1 Syntax and values");
    expect(md).toContain("### Module 2 Control and functions");
    expect(md).toContain("Course field | Details");
    expect(md).not.toMatch(/^\s*1\s*$/m); // page number dropped
  });

  it("merges heading-only pieces so no chunk is just a heading", () => {
    const md = pdfTextToMarkdown(PAGE);
    const raw = chunkFile(md, "Lesson-PDFs/python-foundation-course.pdf", pdfCategory("python-foundation-course.pdf"));
    const merged = mergeSmallChunks(raw);
    expect(raw.length).toBeGreaterThan(merged.length);
    expect(merged[0]!.text).toContain("Module 2");
    expect(merged.map((c) => c.chunkIndex)).toEqual(merged.map((_, i) => i));
    expect(merged[0]!.category).toBe("Programming Language Foundations");
  });

  it("files each PDF under its curriculum family", () => {
    expect(pdfCategory("ios-qa-course-roadmap.pdf").category).toBe("Career Roadmaps");
    expect(pdfCategory("software-engineering-career-structure.pdf").category).toBe("Career Guides");
  });
});
