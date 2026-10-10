import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { expandChapters } from "../src/agents/course-maker/expand.js";
import type { CourseBrief, GeneratedCourse } from "../src/agents/course-maker/schema.js";
import { planProjects } from "../src/agents/project-planner/index.js";
import { ProjectModel } from "../src/database/models/project.model.js";
import { createProject } from "../src/services/project.service.js";
import { fakeDeps, toolCallResponse } from "./helpers/fakeLlm.js";

vi.mock("../src/agents/project-requirements/index.js", () => ({
  makeProjectRequirements: vi.fn(),
}));

import { makeProjectRequirements } from "../src/agents/project-requirements/index.js";

const mockRequirements = vi.mocked(makeProjectRequirements);

let mongo: MongoMemoryServer;
const userA = new Types.ObjectId().toString();

function outline(): GeneratedCourse {
  return {
    title: "Python for Data",
    desc: "Learn Python for data work.",
    level: "Beginner",
    estimatedHours: 30,
    icon: "python",
    thumb: "purple",
    chapters: [
      { title: "Foundations", brief: "Syntax, variables, types and control flow." },
      { title: "Pandas", brief: "DataFrames, loading and filtering data." },
    ],
    quizzes: [],
  };
}

const brief: CourseBrief = { objective: "Learn Python", withProjects: true };

/** An emit_chapter payload with `shape.length` modules of shape[i] lessons. */
function writtenChapter(shape: number[]) {
  return {
    summary: "What this chapter covers.",
    outcomes: ["Write a loop"],
    estimatedHours: 4,
    difficulty: "Beginner",
    modules: shape.map((topics, m) => ({
      title: `Module ${m + 1}`,
      summary: "Module summary.",
      topics: Array.from({ length: topics }, (_, t) => ({
        title: `Lesson ${m + 1}.${t + 1}`,
        summary: "Lesson summary.",
        brief: `Writer instruction for lesson ${m + 1}.${t + 1}.`,
        durationMin: 20,
      })),
    })),
  };
}

function plannedProject(i: number, chapterNumber: number, difficulty: string) {
  return {
    title: `Project ${i}`,
    desc: "Build a thing.",
    goal: "It must run end to end.",
    tags: ["Python"],
    icon: "chart",
    chapterNumber,
    difficulty,
    estimatedHours: 3,
  };
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

beforeEach(async () => {
  mockRequirements.mockReset();
  await ProjectModel.deleteMany({});
});

describe("chapter expansion", () => {
  it("writes one chapter per call, each free to be its own size", async () => {
    const { deps, create } = fakeDeps(
      toolCallResponse("emit_chapter", writtenChapter([6, 8, 5])),
      toolCallResponse("emit_chapter", writtenChapter([4])),
    );

    const written = await expandChapters(outline(), brief, deps);
    expect(written).toHaveLength(2);
    // No shape is imposed on the writer — 19 lessons in one chapter, 4 in the next.
    expect(written[0]!.modules).toHaveLength(3);
    expect(written[0]!.modules.reduce((n, m) => n + m.topics.length, 0)).toBe(19);
    expect(written[1]!.modules).toHaveLength(1);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("gives each writer its brief and the other chapters to avoid", async () => {
    const { deps, create } = fakeDeps(
      toolCallResponse("emit_chapter", writtenChapter([2, 1])),
      toolCallResponse("emit_chapter", writtenChapter([2])),
    );
    await expandChapters(outline(), brief, deps);

    const firstUser = JSON.stringify(create.mock.calls[0]![0]);
    expect(firstUser).toContain("Syntax, variables, types and control flow.");
    expect(firstUser).toContain("do not teach these");
    expect(firstUser).toContain("Pandas");
    // Nothing tells the writer how many modules or lessons to produce.
    expect(firstUser).not.toMatch(/exactly \d+ module/);
  });

  it("never asks a truncated writer to drop lessons", async () => {
    const { deps, create } = fakeDeps(
      toolCallResponse("emit_chapter", writtenChapter([2, 1]), "length"),
      toolCallResponse("emit_chapter", writtenChapter([2, 1])),
      toolCallResponse("emit_chapter", writtenChapter([2])),
    );
    await expandChapters(outline(), brief, deps);

    const repair = JSON.stringify(create.mock.calls.map((c) => c[0]));
    // On truncation the writer is told to shorten prose and stay within its lesson
    // budget — never to expand. (It must not be told to write MORE.)
    expect(repair).toContain("stay within the lesson budget");
    expect(repair).not.toContain("write more");
  });

  it("returns null for a chapter whose writer keeps failing", async () => {
    // Both chapters run concurrently: ch1 initial, ch2 initial, then ch1's repair.
    const { deps } = fakeDeps(
      toolCallResponse("emit_chapter", { nope: true }),
      toolCallResponse("emit_chapter", writtenChapter([2])),
      toolCallResponse("emit_chapter", { still: "wrong" }),
    );

    const written = await expandChapters(outline(), brief, deps);
    expect(written[0]).toBeNull();
    expect(written[1]).not.toBeNull();
  });
});

describe("project planner", () => {
  const ctx = {
    title: "Python for Data",
    desc: "Learn Python for data work.",
    level: "Beginner",
    objective: "Learn Python",
    chapters: [
      { title: "Foundations", covers: "Syntax and control flow." },
      { title: "Pandas", covers: "DataFrames and filtering." },
    ],
  };

  it("orders the plan starter → practice → capstone and maps chapters 0-based", async () => {
    const projects = [
      plannedProject(1, 2, "capstone"),
      plannedProject(2, 2, "practice"),
      plannedProject(3, 1, "starter"),
      plannedProject(4, 1, "starter"),
      plannedProject(5, 1, "practice"),
      plannedProject(6, 2, "practice"),
      plannedProject(7, 1, "starter"),
      plannedProject(8, 2, "starter"),
    ];
    const { deps } = fakeDeps(toolCallResponse("emit_project_plan", { projects }));

    const ordered = await planProjects(ctx, deps);
    expect(ordered).toHaveLength(8);
    expect(ordered.map((p) => p.order)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(ordered.map((p) => p.difficulty)).toEqual([
      "starter", "starter", "starter", "starter",
      "practice", "practice", "practice",
      "capstone",
    ]);
    // chapterNumber 1 → chapterIndex 0, and the field itself is not persisted.
    expect(ordered[0]!.chapterIndex).toBe(0);
    expect(ordered.at(-1)!.chapterIndex).toBe(1);
    expect(ordered[0]).not.toHaveProperty("chapterNumber");
  });

  it("marks an out-of-range chapter as unmapped instead of guessing", async () => {
    const { deps } = fakeDeps(
      toolCallResponse("emit_project_plan", {
        projects: Array.from({ length: 8 }, (_, i) => plannedProject(i, 9, "practice")),
      }),
    );
    const ordered = await planProjects(ctx, deps);
    expect(ordered.every((p) => p.chapterIndex === -1)).toBe(true);
  });

  it("asks again when the model emits too few projects", async () => {
    const short = { projects: Array.from({ length: 3 }, (_, i) => plannedProject(i, 1, "starter")) };
    const full = { projects: Array.from({ length: 9 }, (_, i) => plannedProject(i, 1, "practice")) };
    const { deps, create } = fakeDeps(
      toolCallResponse("emit_project_plan", short),
      toolCallResponse("emit_project_plan", full),
    );

    const ordered = await planProjects(ctx, deps);
    expect(ordered).toHaveLength(9);
    const repair = JSON.stringify(create.mock.calls[1]![0]);
    expect(repair).toContain("only 3 projects");
  });

  it("caps the plan at 10 projects", async () => {
    const { deps } = fakeDeps(
      toolCallResponse("emit_project_plan", {
        projects: Array.from({ length: 12 }, (_, i) => plannedProject(i, 1, "practice")),
      }),
    );
    expect(await planProjects(ctx, deps)).toHaveLength(10);
  });
});

describe("planned projects skip create-time requirement authoring", () => {
  it("does not call the requirements author when a goal is supplied", async () => {
    await createProject(userA, {
      title: "Planned project",
      desc: "From the planner.",
      goal: "It must run end to end.",
      difficulty: "starter",
      chapterIndex: 0,
      order: 1,
    });
    expect(mockRequirements).not.toHaveBeenCalled();

    const saved = await ProjectModel.findOne({ title: "Planned project" }).lean();
    expect(saved!.goal).toBe("It must run end to end.");
    // The checklist stays empty here and is backfilled on first open.
    expect(saved!.requirements).toEqual([]);
  });

  it("still authors requirements for a project created without a goal", async () => {
    mockRequirements.mockResolvedValue({ goal: "Authored goal", requirements: ["Must define main()"] });
    await createProject(userA, { title: "Manual project" });
    expect(mockRequirements).toHaveBeenCalledTimes(1);

    const saved = await ProjectModel.findOne({ title: "Manual project" }).lean();
    expect(saved!.goal).toBe("Authored goal");
  });
});
