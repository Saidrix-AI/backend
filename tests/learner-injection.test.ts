import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildChatAgentPrompt } from "../src/agents/chat-agent/prompt.js";
import {
  buildCourseMakerUserMessage,
  buildExpandUserMessage,
  profileLines,
} from "../src/agents/course-maker/prompt.js";
import type { CourseBrief } from "../src/agents/course-maker/schema.js";
import {
  buildAnalystUserMessage,
  lectureLearnerLines,
  type LessonContext,
} from "../src/agents/lecture-maker/prompt.js";
import { LearnerProfileModel } from "../src/database/models/learnerProfile.model.js";
import { upsertLearnerProfile } from "../src/services/learnerProfile.service.js";

// The course-maker's own pipeline is not under test here — only what the tool
// hands it. Everything between the profile and the brief is real.
vi.mock("../src/agents/course-maker/index.js", () => ({ makeCourse: vi.fn() }));

import { makeCourse } from "../src/agents/course-maker/index.js";
import { buildToolset } from "../src/agents/tools/registry.js";

const mockMakeCourse = vi.mocked(makeCourse);

let mongo: MongoMemoryServer;
const userId = new Types.ObjectId().toString();

const LEARNER_HEADER = "About this student";

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

beforeEach(async () => {
  await LearnerProfileModel.deleteMany({});
  mockMakeCourse.mockReset();
  mockMakeCourse.mockResolvedValue({
    course: {
      _id: new Types.ObjectId(),
      title: "Kubernetes for Backend Engineers",
      level: "Intermediate",
      estimatedHours: 20,
      lessons: 12,
      chapters: [{ title: "Pods" }],
      quizzes: [],
    },
    projects: [],
    projectErrors: [],
  } as unknown as Awaited<ReturnType<typeof makeCourse>>);
});

describe("chat agent prompt", () => {
  const base = { dbTools: true, curriculum: false, today: "2026-08-01" };

  it("adds nothing when the student has no profile", () => {
    const prompt = buildChatAgentPrompt(base);
    expect(prompt).not.toContain(LEARNER_HEADER);
  });

  it("carries the block and forbids reciting it", () => {
    const prompt = buildChatAgentPrompt({
      ...base,
      learner: `${LEARNER_HEADER}:\nWork: Backend Engineer`,
    });
    expect(prompt).toContain("Work: Backend Engineer");
    expect(prompt).toContain("Never read it back to them");
    expect(prompt).toContain("call get_my_profile");
  });

  it("keeps the date line last so it is never swallowed by the block", () => {
    const prompt = buildChatAgentPrompt({ ...base, learner: "About this student:\nAge group: 25-34" });
    expect(prompt.trimEnd().endsWith("Today's date is 2026-08-01.")).toBe(true);
  });
});

describe("course-maker prompts", () => {
  const brief = (extra: Partial<CourseBrief> = {}): CourseBrief => ({
    objective: "Learn Kubernetes",
    withProjects: true,
    ...extra,
  });

  it("emits nothing when there is no learner block and no prior knowledge", () => {
    expect(profileLines(brief())).toEqual([]);
  });

  it("carries the block with no assessment profile", () => {
    const lines = profileLines(brief({ learner: `${LEARNER_HEADER}:\nWork: Backend Engineer` }));
    expect(lines.join("\n")).toContain("Work: Backend Engineer");
  });

  it("carries the block alongside the assessed profile, learner first", () => {
    const lines = profileLines(
      brief({
        learner: `${LEARNER_HEADER}:\nWork: Backend Engineer`,
        profile: {
          level: "Intermediate",
          knownConcepts: ["containers"],
          gapConcepts: ["networking"],
          goal: "Run production clusters",
          weeklyHours: 6,
          styleNotes: "Hands-on",
          summary: "Solid with containers.",
          diagnosticScore: 70,
        },
      }),
    );
    const text = lines.join("\n");
    expect(text.indexOf("Work: Backend Engineer")).toBeLessThan(text.indexOf("Assessed level"));
    expect(text).toContain("Assessed level: Intermediate");
  });

  it("keeps the free-text priorKnowledge fallback working alongside it", () => {
    const lines = profileLines(
      brief({ learner: `${LEARNER_HEADER}:\nAge group: 25-34`, priorKnowledge: "Some Docker" }),
    );
    const text = lines.join("\n");
    expect(text).toContain("Age group: 25-34");
    expect(text).toContain("Prior knowledge: Some Docker");
  });

  it("reaches both the outline and the chapter writer", () => {
    const b = brief({ learner: `${LEARNER_HEADER}:\nWork: Backend Engineer` });
    expect(buildCourseMakerUserMessage(b)).toContain("Work: Backend Engineer");

    const expand = buildExpandUserMessage(
      { title: "K8s", desc: "Clusters", level: "Intermediate" },
      b,
      [{ title: "Pods", brief: "What a pod is." }],
      0,
    );
    expect(expand).toContain("Work: Backend Engineer");
  });
});

describe("lecture-maker prompts", () => {
  const ctx = (learner?: string): LessonContext => ({
    lessonId: "l1",
    courseTitle: "Kubernetes",
    courseDesc: "Clusters",
    level: "Intermediate",
    chapterTitle: "Pods",
    moduleTitle: "Basics",
    topicTitle: "What a Pod Is",
    siblingTopics: ["Deployments"],
    ...(learner ? { learner } : {}),
  });

  it("emits nothing without a learner block", () => {
    expect(lectureLearnerLines(ctx())).toEqual([]);
    expect(buildAnalystUserMessage(ctx())).not.toContain(LEARNER_HEADER);
  });

  it("reaches the analyst and tells it not to write the facts into the lecture", () => {
    const out = buildAnalystUserMessage(ctx(`${LEARNER_HEADER}:\nWork: Backend Engineer`));
    expect(out).toContain("Work: Backend Engineer");
    expect(out).toContain("never write them into the lecture");
  });
});

describe("generate_course tool", () => {
  const run = (args: Record<string, unknown> = {}) =>
    buildToolset({ userId, searchEnabled: false })
      .get("generate_course")!
      .run({ userId }, { objective: "Learn Kubernetes", withProjects: false, ...args });

  const briefPassedToMaker = () =>
    mockMakeCourse.mock.calls[0]![1] as CourseBrief;

  it("passes no learner key when the student has no profile", async () => {
    await run();
    expect(briefPassedToMaker().learner).toBeUndefined();
  });

  it("passes the rendered block once the profile exists", async () => {
    await upsertLearnerProfile(
      userId,
      { occupation: "job", roleTitle: "Backend Engineer", industry: "Fintech" },
      "wizard",
    );
    await run();
    const learner = briefPassedToMaker().learner!;
    expect(learner).toContain("Work: Backend Engineer, in Fintech");
    expect(learner).toContain("Currently: working a job");
  });

  it("keeps the overlapping keys when no assessment has been taken", async () => {
    await upsertLearnerProfile(userId, { weeklyHours: 6, careerGoal: "Platform work" }, "wizard");
    await run();
    const learner = briefPassedToMaker().learner!;
    expect(learner).toContain("Available: about 6 hours a week");
    expect(learner).toContain("Career goal: Platform work");
  });
});
