import { describe, expect, it } from "vitest";
import { buildPlanUserMessage } from "../src/agents/intake/prompt.js";
import { intakePlanSchema, normalizePlan } from "../src/agents/intake/schema.js";
import { buildCourseMakerUserMessage } from "../src/agents/course-maker/prompt.js";
import { deepResearch } from "../src/agents/shared/deepResearch.js";
import { coursesOf, formatTemplate, type CurriculumMatch, type Template } from "../src/rag/curriculum.js";
import { slotFor, type IntakeState } from "../src/services/intake.slots.js";

// Part A + B: the intake, the proposal and the outline all follow the same
// Saidrix curriculum template when one matched.

const course = (title: string, modules: string[]) => ({
  title,
  summary: `${title} summary`,
  status: "",
  modules: modules.map((m) => ({ title: m, topics: "" })),
  tools: "",
  project: "",
});

const python: Template = {
  sourcePath: "Lesson-PDFs/python-foundation.pdf",
  kind: "foundation",
  skill: "Python",
  summary: "",
  aliases: [],
  courses: [course("Python Foundation", ["Setup", "Variables", "Control flow", "Functions"])],
};

const androidBackend: Template = {
  sourcePath: "Lesson-PDFs/android-backend-roadmap.pdf",
  kind: "roadmap",
  skill: "Android Backend Development",
  summary: "",
  aliases: [],
  courses: ["Kotlin", "Databases", "Spring Boot", "REST APIs", "Auth", "Testing", "Deployment"].map((t) =>
    course(t, ["m1", "m2"]),
  ),
};

describe("how many courses a template stands for", () => {
  it("a language's foundation is exactly one course", () => {
    expect(coursesOf({ template: python, courseIndex: null })).toHaveLength(1);
  });

  it("a career roadmap is exactly its steps, in order", () => {
    const steps = coursesOf({ template: androidBackend, courseIndex: null });
    expect(steps.map((s) => s.course.title)).toEqual(androidBackend.courses.map((c) => c.title));
    expect(steps.map((s) => s.index)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("one named step of a roadmap is that one course", () => {
    const steps = coursesOf({ template: androidBackend, courseIndex: 2 });
    expect(steps).toHaveLength(1);
    expect(steps[0]!.course.title).toBe("Spring Boot");
  });
});

describe("intake plan from the template", () => {
  it("puts the template in front of the planner", () => {
    const match: CurriculumMatch = { template: python, courseIndex: null };
    const msg = buildPlanUserMessage({
      topic: "Python",
      objective: "learn python",
      language: "en",
      reference: formatTemplate(match),
    });
    expect(msg).toContain("SAIDRIX CURRICULUM TEMPLATE");
    expect(msg).toContain("Module 3: Control flow");
  });

  it("keeps valid extra questions and drops broken ones without failing the plan", () => {
    const q = (header: string) => ({ header, question: `${header}?`, options: ["a", "b"] });
    const plan = intakePlanSchema.parse(
      normalizePlan({
        topicKind: "programming",
        needsLocalSetup: true,
        goalQuestion: q("Goal"),
        backgroundQuestion: q("Background"),
        extraQuestions: [q("Framework"), { header: "Broken", question: "no options" }],
      }),
    );
    expect(plan.extraQuestions.map((e) => e.header)).toEqual(["Framework"]);
  });

  it("asks the extras on the goal card", async () => {
    const q = (header: string) => ({ header, question: `${header}?`, options: ["a", "b"] });
    const state = {
      plannedQuestions: { goal: q("Goal"), background: q("Background"), extra: [q("Platform")] },
    } as unknown as IntakeState;
    const built = await slotFor("goal").build!(state);
    expect(built.map((b) => b.header)).toEqual(["Goal", "Platform"]);
  });
});

describe("course outline from the template", () => {
  it("pins the chapters to the template's modules", () => {
    const msg = buildCourseMakerUserMessage({
      objective: "Python",
      withProjects: false,
      template: { sourcePath: python.sourcePath, block: "SAIDRIX CURRICULUM TEMPLATE — Python", modules: ["a", "b", "c", "d"] },
    });
    expect(msg).toContain("SAIDRIX CURRICULUM TEMPLATE — Python");
    expect(msg).toContain("Write exactly 4 chapters");
  });

  it("deep research is empty, not an error, when web search is off", async () => {
    await expect(deepResearch("Rust embedded")).resolves.toBe("");
  });
});
