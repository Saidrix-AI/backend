import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { BaseMessage, ToolMessage } from "@langchain/core/messages";
import {
  fakeDeps as sharedFakeDeps,
  textResponse,
  toolCallResponse as sharedToolCallResponse,
} from "./helpers/fakeLlm.js";
import { buildToolset } from "../src/agents/tools/registry.js";
import { courseIdSuffix, dedupeTitle, slugify, toCourseInput } from "../src/agents/course-maker/ids.js";
import {
  expandedChapterSchema,
  type ExpandedChapter,
  type GeneratedCourse,
} from "../src/agents/course-maker/schema.js";
import { createCourseSchema } from "../src/validation/course.schema.js";
import type { OrderedProject } from "../src/agents/project-planner/index.js";
import { CourseModel } from "../src/database/models/course.model.js";
import { ProjectModel } from "../src/database/models/project.model.js";
import { LearningPathModel } from "../src/database/models/learningPath.model.js";
import { createCourse } from "../src/services/course.service.js";
import { ApiError } from "../src/utils/apiError.js";

// The LLM boundary is mocked for tool-level tests; the "generator" describe
// below uses vi.importActual + an injected fake client to exercise the real
// repair loop (test env forces LLM_PROVIDER=google, so the default deps path
// is unreachable in tests by design). The pipeline's other two LLM phases —
// per-chapter enrichment and project planning — are mocked the same way.
vi.mock("../src/agents/course-maker/generator.js", () => ({
  resolveGeneratorDeps: vi.fn(),
  generateCoursePayload: vi.fn(),
}));
vi.mock("../src/agents/course-maker/expand.js", async (importActual) => {
  const actual = await importActual<typeof import("../src/agents/course-maker/expand.js")>();
  // Keep the real enforceLessonCap/countLessons (used by the assembler); only stub the LLM call.
  return { ...actual, expandChapters: vi.fn() };
});
vi.mock("../src/agents/project-planner/index.js", () => ({ planProjects: vi.fn() }));

import { generateCoursePayload } from "../src/agents/course-maker/generator.js";
import { expandChapters } from "../src/agents/course-maker/expand.js";
import { planProjects } from "../src/agents/project-planner/index.js";

const mockGenerate = vi.mocked(generateCoursePayload);
const mockExpand = vi.mocked(expandChapters);
const mockPlanProjects = vi.mocked(planProjects);

let mongo: MongoMemoryServer;
const userA = new Types.ObjectId().toString();
const tools = buildToolset({ userId: userA, searchEnabled: false });

function run(name: string, args: Record<string, unknown> = {}) {
  const tool = tools.get(name);
  if (!tool) throw new Error(`tool ${name} is not registered`);
  return tool.run({ userId: userA }, args);
}

function cannedPayload(): GeneratedCourse {
  return {
    title: "Data Analysis with Python",
    desc: "Learn to analyze data with Python from scratch.",
    level: "Beginner",
    estimatedHours: 30,
    icon: "python",
    thumb: "purple",
    chapters: [
      { title: "Foundations", brief: "Python syntax, variables, types and collections." },
      { title: "Analysis", brief: "Pandas DataFrames, filtering and plotting." },
    ],
    quizzes: [{ title: "Foundations Checkpoint" }, { title: "Analysis Checkpoint" }],
  };
}

/** A written chapter with `modules` modules of `topics` lessons each. */
function cannedChapter(modules: number, topics: number): ExpandedChapter {
  return {
    summary: "What this chapter covers.",
    outcomes: ["Write a loop"],
    estimatedHours: 5,
    difficulty: "Beginner",
    modules: Array.from({ length: modules }, (_, m) => ({
      title: `Module ${m + 1}`,
      summary: "Module summary.",
      topics: Array.from({ length: topics }, (_, t) => ({
        title: `Lesson ${m + 1}.${t + 1}`,
        summary: "Lesson summary.",
        brief: `Instruction for the lecture writer of lesson ${m + 1}.${t + 1}.`,
        durationMin: 20,
      })),
    })),
  };
}

/** What the project planner would return for `cannedPayload`'s two chapters. */
function cannedProjects(count = 2): OrderedProject[] {
  return Array.from({ length: count }, (_, i) => ({
    title: `Project ${i + 1}`,
    desc: "Build something.",
    goal: "The finished project must run end to end.",
    tags: ["Python"],
    icon: "chart" as const,
    chapterIndex: i % 2,
    order: i + 1,
    difficulty: (i === count - 1 ? "capstone" : "starter") as OrderedProject["difficulty"],
    estimatedHours: 3,
  }));
}

function collectLessonIds(course: { chapters: { modules: { topics: { lessonId: string }[] }[] }[] }): string[] {
  return course.chapters.flatMap((c) => c.modules.flatMap((m) => m.topics.map((t) => t.lessonId)));
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
  mockGenerate.mockReset();
  mockExpand.mockReset();
  mockPlanProjects.mockReset();
  // Default: both chapters written as 2 modules × 2 lessons, two projects.
  mockExpand.mockResolvedValue([cannedChapter(2, 2), cannedChapter(2, 2)]);
  mockPlanProjects.mockResolvedValue(cannedProjects());
  await CourseModel.deleteMany({});
  await ProjectModel.deleteMany({});
});

describe("generate_course tool", () => {
  it("creates a full course with derived lessons, unique ids and linked projects", async () => {
    mockGenerate.mockImplementation(async () => cannedPayload());

    const outcome = await run("generate_course", { objective: "Python for data analysis, from zero" });
    expect(outcome.ok).toBe(true);
    expect(outcome.changed).toBe("course");
    expect(outcome.label).toBe('Course "Data Analysis with Python" created (8 lessons, 2 projects)');

    const course = await CourseModel.findOne({ title: "Data Analysis with Python" }).lean();
    expect(course).not.toBeNull();
    expect(String(course!.userId)).toBe(userA);
    expect(course!.lessons).toBe(8); // derived from 2ch × 2m × 2t
    expect(course!.quizzes).toHaveLength(2);
    expect(course!.quizzes[0]!.quizId).toMatch(/-quiz1$/);

    const lessonIds = collectLessonIds(course as never);
    expect(lessonIds).toHaveLength(8);
    expect(new Set(lessonIds).size).toBe(8);
    // Ids are minted by course.service (assignCurriculumIds), not by the agent:
    // a random per-course namespace plus the topic's curriculum position. The
    // agent's own suggestions are discarded, so a caller cannot pick an id and
    // thereby claim another student's lecture namespace.
    for (const id of lessonIds) {
      expect(id).toMatch(/^[a-z0-9]{10}-c\d+m\d+t\d+$/);
      expect(id.length).toBeLessThanOrEqual(80);
    }

    const projects = await ProjectModel.find({ courseId: String(course!._id) }).lean();
    expect(projects).toHaveLength(2);
    expect(projects.map((p) => p.title).sort()).toEqual(["Project 1", "Project 2"]);
    // The planner's own goal is persisted, which is what lets createProject
    // skip its per-project requirements call.
    expect(projects.every((p) => p.goal.length > 0)).toBe(true);
    expect(projects.map((p) => p.order).sort()).toEqual([1, 2]);

    expect(outcome.modelText).toContain(String(course!._id));
    expect(outcome.modelText).toContain("lecture pages for the lessons are generated later");
  });

  it("skips projects when withProjects is false", async () => {
    mockGenerate.mockImplementation(async () => cannedPayload());
    const outcome = await run("generate_course", { objective: "Python", withProjects: false });
    expect(outcome.ok).toBe(true);
    expect(outcome.label).not.toContain("project");
    expect(mockPlanProjects).not.toHaveBeenCalled();
    expect(await ProjectModel.countDocuments({})).toBe(0);
  });

  it("dedupes against an existing course title with a ' II' suffix", async () => {
    await createCourse(userA, { title: "Data Analysis with Python" });
    mockGenerate.mockImplementation(async () => cannedPayload());

    const outcome = await run("generate_course", { objective: "Python data analysis" });
    expect(outcome.ok).toBe(true);
    expect(outcome.label).toContain('"Data Analysis with Python II"');
    expect(await CourseModel.countDocuments({ title: "Data Analysis with Python II" })).toBe(1);
  });

  it("assigns globally distinct lessonIds across two generations of the same course shape", async () => {
    mockGenerate.mockImplementation(async () => cannedPayload());
    await run("generate_course", { objective: "Python" });
    await run("generate_course", { objective: "Python again" });

    const courses = await CourseModel.find({}).lean();
    expect(courses).toHaveLength(2);
    const all = courses.flatMap((c) => collectLessonIds(c as never));
    expect(all).toHaveLength(16);
    expect(new Set(all).size).toBe(16);
  });

  it("threads priorKnowledge through to the generator brief", async () => {
    mockGenerate.mockImplementation(async () => cannedPayload());
    await run("generate_course", {
      objective: "Python",
      priorKnowledge: "Knows Excel; new to programming",
    });
    expect(mockGenerate).toHaveBeenCalledWith(
      expect.objectContaining({ priorKnowledge: "Knows Excel; new to programming" }),
      expect.any(Array),
    );
  });

  it("rejects invalid arguments without calling the generator", async () => {
    const outcome = await run("generate_course", {});
    expect(outcome.ok).toBe(false);
    expect(outcome.modelText).toContain("Invalid arguments");
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it("maps generator failures into an ok:false outcome and creates nothing", async () => {
    mockGenerate.mockRejectedValue(new ApiError(502, "Course generation failed: the model returned an invalid course structure."));
    const outcome = await run("generate_course", { objective: "Python" });
    expect(outcome.ok).toBe(false);
    expect(outcome.modelText).toContain("Course generation failed");
    expect(await CourseModel.countDocuments({})).toBe(0);
    expect(await ProjectModel.countDocuments({})).toBe(0);
  });

  it("persists a full 10-project plan with its chapter mapping and tiers", async () => {
    mockGenerate.mockImplementation(async () => cannedPayload());
    mockPlanProjects.mockResolvedValue(cannedProjects(10));

    const outcome = await run("generate_course", { objective: "Python" });
    expect(outcome.ok).toBe(true);
    expect(outcome.label).toContain("10 projects");

    const projects = await ProjectModel.find({}).sort({ order: 1 }).lean();
    expect(projects).toHaveLength(10);
    expect(projects.map((p) => p.order)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(projects.every((p) => p.chapterIndex >= 0)).toBe(true);
    expect(projects.at(-1)!.difficulty).toBe("capstone");
  });

  it("still creates the course when project planning fails", async () => {
    mockGenerate.mockImplementation(async () => cannedPayload());
    mockPlanProjects.mockRejectedValue(new ApiError(502, "Course generation failed"));

    const outcome = await run("generate_course", { objective: "Python" });
    expect(outcome.ok).toBe(true);
    expect(await CourseModel.countDocuments({})).toBe(1);
    expect(await ProjectModel.countDocuments({})).toBe(0);
    expect(outcome.modelText).toContain("could not be created");
  });

  it("saves each chapter as its writer produced it", async () => {
    mockGenerate.mockImplementation(async () => cannedPayload());
    mockExpand.mockResolvedValue([cannedChapter(2, 2), cannedChapter(3, 4)]);

    await run("generate_course", { objective: "Python" });
    const course = await CourseModel.findOne({}).lean();
    expect(course!.chapters[0]!.summary).toBe("What this chapter covers.");
    expect(course!.chapters[0]!.outcomes).toEqual(["Write a loop"]);
    expect(course!.chapters[0]!.modules[0]!.topics[0]!.durationMin).toBe(20);
    // Chapters are independent — a bigger second chapter is fine.
    expect(course!.chapters[1]!.modules).toHaveLength(3);
    expect(course!.lessons).toBe(2 * 2 + 3 * 4);
  });

  it("keeps a chapter whose writer failed, using its outline brief", async () => {
    mockGenerate.mockImplementation(async () => cannedPayload());
    mockExpand.mockResolvedValue([cannedChapter(2, 2), null]);

    await run("generate_course", { objective: "Python" });
    const course = await CourseModel.findOne({}).lean();
    expect(course!.chapters).toHaveLength(2);
    expect(course!.chapters[1]!.title).toBe("Analysis");
    expect(course!.chapters[1]!.summary).toBe("Pandas DataFrames, filtering and plotting.");
    expect(course!.chapters[1]!.modules).toEqual([]);
    expect(course!.lessons).toBe(4);
  });

  it("caps an over-large course under the 60-lesson limit", async () => {
    // 20 chapters × 5 modules × 8 lessons = 800 lessons as written; the assembler's
    // enforceLessonCap must trim it to fewer than 60 while keeping every chapter.
    mockGenerate.mockImplementation(async () => ({
      ...cannedPayload(),
      chapters: Array.from({ length: 20 }, (_, i) => ({
        title: `Chapter ${i + 1}`,
        brief: `Ground covered by chapter ${i + 1}.`,
      })),
    }));
    mockExpand.mockResolvedValue(Array.from({ length: 20 }, () => cannedChapter(5, 8)));

    const outcome = await run("generate_course", { objective: "Everything about Python" });
    expect(outcome.ok).toBe(true);

    const course = await CourseModel.findOne({}).lean();
    expect(course!.chapters).toHaveLength(20); // chapters kept; only lessons trimmed
    expect(course!.lessons).toBeLessThan(60);
    expect(course!.lessons).toBeGreaterThan(0);
    const lessonIds = collectLessonIds(course as never);
    expect(new Set(lessonIds).size).toBe(course!.lessons); // ids stay unique after trimming
    for (const id of lessonIds) expect(id.length).toBeLessThanOrEqual(80);
  });
});

describe("generator repair loop (real implementation, fake client)", () => {
  type Gen = typeof import("../src/agents/course-maker/generator.js");
  let realGenerate: Gen["generateCoursePayload"];
  let realResolveDeps: Gen["resolveGeneratorDeps"];

  beforeAll(async () => {
    const real = await vi.importActual<Gen>("../src/agents/course-maker/generator.js");
    realGenerate = real.generateCoursePayload;
    realResolveDeps = real.resolveGeneratorDeps;
  });

  const brief = { objective: "Python for data analysis", withProjects: true } as const;

  /** emit_course is the only tool this generator ever calls. */
  const toolCallResponse = (args: unknown, finishReason = "tool_calls") =>
    sharedToolCallResponse("emit_course", args, finishReason);

  const fakeDeps = sharedFakeDeps;

  it("repairs an invalid structure once and succeeds", async () => {
    const { deps, create } = fakeDeps(
      toolCallResponse({ title: "" }), // fails zod
      toolCallResponse(cannedPayload()),
    );
    const payload = await realGenerate(brief, [], deps);
    expect(payload.title).toBe("Data Analysis with Python");
    expect(create).toHaveBeenCalledTimes(2);
    const repair = create.mock.calls[1]![0] as BaseMessage[];
    const toolMsg = repair.find((m) => m._getType() === "tool") as ToolMessage | undefined;
    expect(toolMsg?.content).toContain("problems");
    // Load-bearing, not decoration: qwen3.8-max 500s on a tool message with no
    // function name, which is what moved this runner onto LangChain.
    expect(toolMsg?.name).toBe("emit_course");
  });

  it("repairs a plain-text (no tool call) response via a user correction", async () => {
    const { deps, create } = fakeDeps(
      textResponse("Here is a course idea..."),
      toolCallResponse(cannedPayload()),
    );
    const payload = await realGenerate(brief, [], deps);
    expect(payload.chapters).toHaveLength(2);
    const repair = create.mock.calls[1]![0] as BaseMessage[];
    expect(repair.at(-1)?._getType()).toBe("human");
    expect(repair.at(-1)?.content).toContain("emit_course");
  });

  /*
   * Folding this generator into the shared runner changed the truncation repair
   * for the better. It used to echo the truncated attempt back as a tool
   * message — thousands of tokens of the model's own half-finished sprawl,
   * which mostly invited more of the same. The shared runner restarts from the
   * original prompt with a firmer size instruction instead.
   */
  it("restarts clean on a truncated response instead of echoing it", async () => {
    const { deps, create } = fakeDeps(
      toolCallResponse(cannedPayload(), "length"),
      toolCallResponse(cannedPayload()),
    );
    await realGenerate(brief, [], deps);
    const repair = create.mock.calls[1]![0] as BaseMessage[];
    expect(repair.map((m) => m._getType())).toEqual(["system", "human"]);
    const restated = String(repair.at(-1)?.content);
    expect(restated).toContain("far too long");
    expect(restated).toContain("cut each brief to two short sentences");
  });

  it("throws ApiError 502 when both attempts fail", async () => {
    const { deps } = fakeDeps(toolCallResponse({}), toolCallResponse({ nope: true }));
    await expect(realGenerate(brief, [], deps)).rejects.toMatchObject({ statusCode: 502 });
  });

  it("resolveGeneratorDeps rejects non-OpenAI-compatible providers (test env is google)", () => {
    expect(() => realResolveDeps()).toThrowError(/OpenAI-compatible/);
  });
});

describe("course-maker prompt", () => {
  it("includes the prior-knowledge line only when given", async () => {
    const { buildCourseMakerUserMessage, buildCourseMakerSystemPrompt } = await import(
      "../src/agents/course-maker/prompt.js"
    );
    const withPk = buildCourseMakerUserMessage({
      objective: "Python",
      withProjects: true,
      priorKnowledge: "2 years of JS",
    });
    expect(withPk).toContain("Prior knowledge: 2 years of JS");

    const withoutPk = buildCourseMakerUserMessage({ objective: "Python", withProjects: true });
    expect(withoutPk).not.toContain("Prior knowledge");

    expect(buildCourseMakerSystemPrompt([])).toContain("prior knowledge is given, calibrate");
  });
});

describe("multi-course learning path coordination", () => {
  const pathCourses = [
    { title: "Python Basics", objective: "Python from zero", covers: "syntax, variables, control flow, functions" },
    { title: "Pandas for Analysis", objective: "Analyze data with Pandas", covers: "DataFrames, filtering, groupby, plotting" },
  ];

  it("propose_courses saves an ordered path and returns its pathId", async () => {
    await LearningPathModel.deleteMany({});
    const outcome = await run("propose_courses", { goal: "Become a Data Analyst", breadth: "subject", courses: pathCourses });
    expect(outcome.ok).toBe(true);

    const path = await LearningPathModel.findOne({ userId: userA }).lean();
    expect(path).not.toBeNull();
    expect(path!.goal).toBe("Become a Data Analyst");
    expect(path!.courses.map((c) => c.title)).toEqual(["Python Basics", "Pandas for Analysis"]);
    expect(path!.courses[0]!.covers).toContain("syntax");
    // The pathId is handed back so generate_course can reference it.
    expect(outcome.modelText).toContain(String(path!._id));
  });

  it("generate_course with pathId+order stamps the course and feeds sibling scope as prerequisites", async () => {
    await LearningPathModel.deleteMany({});
    await run("propose_courses", { goal: "Become a Data Analyst", breadth: "subject", courses: pathCourses });
    const path = await LearningPathModel.findOne({ userId: userA }).lean();
    const pathId = String(path!._id);

    mockGenerate.mockImplementation(async () => ({ ...cannedPayload(), title: "Pandas for Analysis" }));

    // A re-typed objective must be ignored in favour of the path entry's.
    const outcome = await run("generate_course", { objective: "WRONG should be overridden", pathId, order: 2 });
    expect(outcome.ok).toBe(true);

    // The course is stamped with the path linkage.
    const course = await CourseModel.findOne({ pathId: path!._id }).lean();
    expect(course).not.toBeNull();
    expect(course!.order).toBe(2);
    expect(course!.pathTotal).toBe(2);
    expect(course!.pathTitle).toBe("Become a Data Analyst");

    // The outline call received the authoritative objective + a boundary that
    // turns course 1 into a prerequisite (the mechanism that stops repetition).
    const brief = mockGenerate.mock.calls[0]![0];
    expect(brief.objective).toBe("Analyze data with Pandas");
    expect(brief.pathBoundary).toContain("STEP 2 OF 2");
    expect(brief.pathBoundary).toContain("PREREQUISITES");
    expect(brief.pathBoundary).toContain("syntax, variables, control flow, functions");
  });

  it("auto-links a course to a matching proposed path even when no pathId is passed", async () => {
    await LearningPathModel.deleteMany({});
    await run("propose_courses", { goal: "Become a Data Analyst", breadth: "subject", courses: pathCourses });
    const path = await LearningPathModel.findOne({ userId: userA }).lean();

    mockGenerate.mockImplementation(async () => ({ ...cannedPayload(), title: "Pandas for Analysis" }));

    // Only the objective is passed (exactly as proposed) — NO pathId/order. The
    // tool must match it to the path by objective and link it. This is what makes
    // "create these courses" auto-link without the model tracking pathId/order.
    const outcome = await run("generate_course", { objective: "Analyze data with Pandas" });
    expect(outcome.ok).toBe(true);

    const course = await CourseModel.findOne({ pathId: path!._id }).lean();
    expect(course).not.toBeNull();
    expect(course!.order).toBe(2); // 2nd entry in the path
    expect(course!.pathTotal).toBe(2);
    expect(mockGenerate.mock.calls[0]![0].pathBoundary).toContain("STEP 2 OF 2");
  });

  it("without pathId and no matching path, a course is created unstamped", async () => {
    await LearningPathModel.deleteMany({});
    mockGenerate.mockImplementation(async () => cannedPayload());
    await run("generate_course", { objective: "Something totally unrelated to any path" });
    const course = await CourseModel.findOne({ title: "Data Analysis with Python" }).lean();
    expect(course!.pathId).toBeUndefined();
    expect(course!.order).toBeUndefined();
  });
});

describe("existing-course dedup", () => {
  it("passes the student's other courses' coverage to the outline as a do-not-duplicate boundary", async () => {
    mockGenerate.mockImplementation(async () => cannedPayload());
    await createCourse(userA, {
      title: "HTML Course",
      level: "Beginner",
      chapters: [
        { title: "Document Structure", modules: [{ title: "M", topics: [{ title: "T", lessonId: "l1" }] }] },
      ],
    });

    await run("generate_course", { objective: "CSS for web design" });

    const brief = mockGenerate.mock.calls[0]![0];
    expect(brief.existingCoverage).toContain("HTML Course");
    expect(brief.existingCoverage).toContain("Document Structure");
  });
});

describe("ids helpers", () => {
  it("slugify falls back to 'course' for non-Latin titles", () => {
    expect(slugify("বাংলা কোর্স")).toBe("course");
    expect(courseIdSuffix("বাংলা কোর্স")).toMatch(/^course-[a-z0-9]{4}$/);
  });

  it("keeps lessonIds within 80 chars for very long titles", () => {
    const long = "A".repeat(120);
    // Written chapters are required: without them toCourseInput emits chapters
    // with `modules: []` and the assertion loop below never executes.
    const written = [cannedChapter(2, 3), cannedChapter(2, 3)];
    const input = toCourseInput(cannedPayload(), courseIdSuffix(long), written);
    const ids = input.chapters!.flatMap((ch) => ch.modules.flatMap((m) => m.topics.map((t) => t.lessonId)));
    expect(ids).toHaveLength(12);
    for (const id of ids) expect(id.length).toBeLessThanOrEqual(80);
  });

  // The brief is the one field the lecture planner reads, so it has to survive
  // the hop from emit_chapter into the course document.
  it("toCourseInput carries each topic's brief and still satisfies the create contract", () => {
    // The written chapters are what carry modules/topics — the outline alone has
    // only chapter titles and briefs.
    const written = [cannedChapter(1, 1), cannedChapter(1, 1)];
    const input = toCourseInput(cannedPayload(), courseIdSuffix("Brief Course"), written);
    const topic = input.chapters![0]!.modules[0]!.topics[0]!;
    expect(topic.brief).toBe("Instruction for the lecture writer of lesson 1.1.");
    expect(createCourseSchema.safeParse(input).success).toBe(true);
  });

  // Lenient on purpose: a writer that omits the brief must degrade to the
  // one-line summary, not fail the parse and cost the whole chapter.
  it("expandedChapterSchema defaults a missing brief to an empty string", () => {
    const raw = {
      summary: "s",
      outcomes: ["do x"],
      estimatedHours: 1,
      difficulty: "Beginner",
      modules: [
        { title: "M", summary: "s", topics: [{ title: "T", summary: "s", durationMin: 15 }] },
      ],
    };
    const parsed = expandedChapterSchema.safeParse(raw);
    expect(parsed.success).toBe(true);
    expect(parsed.data!.modules[0]!.topics[0]!.brief).toBe("");
  });

  it("dedupeTitle appends and escalates the suffix", () => {
    expect(dedupeTitle("React", [])).toBe("React");
    expect(dedupeTitle("React", ["react"])).toBe("React II");
    expect(dedupeTitle("React", ["react", "react ii"])).toBe("React III");
    expect(dedupeTitle("React", ["REACT"])).toBe("React II");
  });
});
