import { describe, expect, it } from "vitest";
import { enforceLessonCap, countLessons } from "../src/agents/course-maker/expand.js";
import { buildCourseMakerUserMessage, buildExpandUserMessage } from "../src/agents/course-maker/prompt.js";
import type { ExpandedChapter, GeneratedCourse } from "../src/agents/course-maker/schema.js";

function chapter(topicsPerModule: number[]): ExpandedChapter {
  return {
    summary: "s",
    outcomes: ["do x"],
    estimatedHours: 1,
    difficulty: "Beginner",
    modules: topicsPerModule.map((n, mi) => ({
      title: `M${mi}`,
      summary: "s",
      topics: Array.from({ length: n }, (_, ti) => ({
        title: `T${mi}.${ti}`,
        summary: "s",
        brief: "b",
        durationMin: 15,
      })),
    })),
  };
}

describe("enforceLessonCap (< 60 lessons safety net)", () => {
  it("trims an over-budget course to at most 59 lessons", () => {
    const written = [chapter([10, 10, 5]), chapter([10, 10, 5]), chapter([10, 10, 5])]; // 75 total
    expect(countLessons(written)).toBe(75);
    enforceLessonCap(written);
    expect(countLessons(written)).toBeLessThanOrEqual(59);
    // never empties a module or a chapter
    for (const ch of written) {
      expect(ch.modules.length).toBeGreaterThan(0);
      for (const m of ch.modules) expect(m.topics.length).toBeGreaterThan(0);
    }
  });

  it("leaves an already-small course untouched", () => {
    const written = [chapter([3, 3]), chapter([2, 2])]; // 10 total
    enforceLessonCap(written);
    expect(countLessons(written)).toBe(10);
  });

  it("ignores null (failed) chapters", () => {
    const written = [chapter([30, 30]), null];
    enforceLessonCap(written);
    expect(countLessons(written)).toBeLessThanOrEqual(59);
  });
});

describe("prompt injection", () => {
  const gen = {
    title: "CSS",
    desc: "d",
    level: "Beginner",
    chapters: [
      { title: "Ch1", brief: "b1" },
      { title: "Ch2", brief: "b2" },
    ],
  } as unknown as GeneratedCourse;

  it("buildExpandUserMessage states the per-chapter lesson budget", () => {
    const msg = buildExpandUserMessage(gen, { objective: "o", withProjects: true }, gen.chapters, 0, "", 6);
    expect(msg).toContain("Lesson budget");
    expect(msg).toContain("6");
    expect(msg).toContain("maximum 8"); // budget + 2
  });

  it("buildCourseMakerUserMessage injects existing-course coverage as a do-not-duplicate boundary", () => {
    const msg = buildCourseMakerUserMessage({
      objective: "CSS for web design",
      withProjects: true,
      existingCoverage: '- "HTML": Document Structure, Tags and Attributes',
    });
    expect(msg).toContain("ALREADY has these courses");
    expect(msg).toContain("Document Structure");
  });

  // Both calls have their own web search, because "what is current" differs by
  // chapter — and the chapter writers' briefs are what the lecture writers
  // later build from, so a stale brief outlives the outline that produced it.
  it("buildCourseMakerUserMessage injects the live search block", () => {
    const msg = buildCourseMakerUserMessage(
      { objective: "React", withProjects: true },
      "",
      "CURRENT INFORMATION — live web search\n[1] React 19 is current",
    );
    expect(msg).toContain("CURRENT INFORMATION");
    expect(msg).toContain("React 19 is current");
  });

  it("buildExpandUserMessage injects the live search block", () => {
    const msg = buildExpandUserMessage(
      gen,
      { objective: "o", withProjects: true },
      gen.chapters,
      0,
      "",
      6,
      "CURRENT INFORMATION — live web search\n[1] React 19 is current",
    );
    expect(msg).toContain("CURRENT INFORMATION");
    expect(msg).toContain("React 19 is current");
  });

  it("omits the block entirely when the search returned nothing", () => {
    const msg = buildCourseMakerUserMessage({ objective: "React", withProjects: true });
    expect(msg).not.toContain("CURRENT INFORMATION");
  });
});
