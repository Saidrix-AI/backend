import { describe, expect, it } from "vitest";
import { projectLock } from "../src/services/projectGate.js";

const course = {
  chapters: [
    {
      title: "Foundations",
      modules: [
        { title: "M", topics: [{ lessonId: "c1a", title: "Variables" }, { lessonId: "c1b", title: "Loops" }] },
      ],
    },
    { title: "Functions", modules: [{ title: "M", topics: [{ lessonId: "c2a", title: "Defining" }] }] },
    { title: "Data", modules: [{ title: "M", topics: [{ lessonId: "c3a", title: "Lists" }] }] },
  ],
} as never;

const ALL = ["c1a", "c1b", "c2a", "c3a"];
const proj = (over: Record<string, unknown> = {}) => ({
  courseId: "course-1",
  chapterIndex: 0,
  difficulty: "starter",
  ...over,
});

describe("projectLock", () => {
  it("locks until every lesson of its own chapter is done", () => {
    expect(projectLock(proj(), course, []).locked).toBe(true);
    // A partially finished chapter is still locked — one lesson short counts.
    expect(projectLock(proj(), course, ["c1a"]).locked).toBe(true);
    expect(projectLock(proj(), course, ["c1a", "c1b"]).locked).toBe(false);
  });

  it("names the chapter that would unlock it", () => {
    const lock = projectLock(proj({ chapterIndex: 1 }), course, ["c1a", "c1b"]);
    expect(lock.locked).toBe(true);
    expect(lock.requiresChapter).toBe(2);
    expect(lock.lockReason).toBe("Finish Chapter 2 · Functions to unlock this project");
  });

  it("gates a capstone on the whole course, not just its filed chapter", () => {
    // Chapter 1 done — enough for a starter filed there, not for a capstone.
    const done = ["c1a", "c1b"];
    expect(projectLock(proj({ difficulty: "starter" }), course, done).locked).toBe(false);

    const capstone = projectLock(proj({ difficulty: "capstone" }), course, done);
    expect(capstone.locked).toBe(true);
    expect(capstone.requiresChapter).toBeNull();
    expect(capstone.lockReason).toMatch(/Finish the course/);

    expect(projectLock(proj({ difficulty: "capstone" }), course, ALL).locked).toBe(false);
  });

  // Anything the planner never mapped must stay reachable, or manually created
  // and pre-planner projects would be permanently locked with no way out.
  it("fails open for unmapped projects", () => {
    expect(projectLock(proj({ chapterIndex: -1 }), course, []).locked).toBe(false);
    expect(projectLock(proj({ chapterIndex: 99 }), course, []).locked).toBe(false);
    expect(projectLock(proj({ courseId: "" }), course, []).locked).toBe(false);
    expect(projectLock(proj(), null, []).locked).toBe(false);
    expect(projectLock(proj(), { chapters: [] } as never, []).locked).toBe(false);
  });

  it("unlocks a chapter that has no lessons at all", () => {
    const thin = { chapters: [{ title: "Empty", modules: [] }] } as never;
    expect(projectLock(proj(), thin, []).locked).toBe(false);
  });

  /**
   * The chapter gate is the blunt version of the same idea: "finish all nine
   * lessons of chapter 2" when the project only needs the three that taught
   * the skill. A lesson gate opens it the moment the student can actually do
   * it, which is the difference between building something and reading nine
   * more lessons first.
   */
  describe("when the planner named the lesson that opens it", () => {
    it("opens on that one lesson rather than the whole chapter", () => {
      const p = proj({ unlockLessonId: "c1a" });
      expect(projectLock(p, course, []).locked).toBe(true);
      // c1b is NOT required, although it is in the same chapter.
      expect(projectLock(p, course, ["c1a"]).locked).toBe(false);
    });

    it("names the lesson, not the chapter", () => {
      const lock = projectLock(proj({ unlockLessonId: "c2a", chapterIndex: 1 }), course, []);
      expect(lock.lockReason).toBe('Finish "Defining" to unlock this project');
      expect(lock.requiresLessonId).toBe("c2a");
      // Still says which chapter it lives in, for anything grouping by chapter.
      expect(lock.requiresChapter).toBe(2);
    });

    it("still gates a capstone on the whole course", () => {
      // The capstone rule is about what the project IS, not where it was filed,
      // so a lesson gate must not be a way to open one early.
      const capstone = proj({ difficulty: "capstone", unlockLessonId: "c1a" });
      expect(projectLock(capstone, course, ["c1a"]).locked).toBe(true);
      expect(projectLock(capstone, course, ALL).locked).toBe(false);
    });

    it("falls back to the chapter rule when the lesson no longer exists", () => {
      // A regenerated or re-written course can orphan a lessonId. Locking the
      // project forever is the one outcome this module exists to avoid, so an
      // unknown id is ignored and the chapter gate answers instead.
      const p = proj({ unlockLessonId: "gone", chapterIndex: 0 });
      expect(projectLock(p, course, ["c1a"]).locked).toBe(true);
      expect(projectLock(p, course, ["c1a", "c1b"]).locked).toBe(false);
    });
  });
});
