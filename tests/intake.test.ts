import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/app.js";
import { buildToolset } from "../src/agents/tools/registry.js";
import { LearningIntakeModel } from "../src/database/models/learningIntake.model.js";
import { KnowledgeAssessmentModel } from "../src/database/models/knowledgeAssessment.model.js";

// Both LLM boundaries are mocked: the intake's own goal-question writer and the
// knowledge profiler behind the test stage. Everything else — the stage
// machine, the stage guards, what reaches the chat agent — is real.
vi.mock("../src/agents/intake/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agents/intake/index.js")>();
  return { ...actual, generateGoalQuestions: vi.fn() };
});
vi.mock("../src/agents/knowledge-profiler/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agents/knowledge-profiler/index.js")>();
  return { ...actual, generateRound: vi.fn(), buildProfile: vi.fn() };
});

import { generateGoalQuestions } from "../src/agents/intake/index.js";
import { buildProfile, generateRound } from "../src/agents/knowledge-profiler/index.js";
import { findReusableIntake, isSameTopic, latestIntake } from "../src/services/intake.service.js";
import { getLearnerProfile } from "../src/services/learnerProfile.service.js";

const mockGoal = vi.mocked(generateGoalQuestions);
const mockRound = vi.mocked(generateRound);
const mockProfile = vi.mocked(buildProfile);

let mongo: MongoMemoryServer;
let token: string;
let userId: string;

const auth = () => ({ Authorization: `Bearer ${token}` });

function roundQuestions(round: number) {
  const diagnostic = round === 2 || round === 3;
  return Array.from({ length: 4 }, (_, i) => ({
    header: `R${round}Q${i + 1}`,
    question: `Round ${round} question ${i + 1}?`,
    options: ["right", "wrong"],
    multiSelect: false,
    kind: (diagnostic ? "diagnostic" : "self_report") as "diagnostic" | "self_report",
    ...(diagnostic ? { correctIndex: 0, concept: `c-${round}-${i}` } : {}),
  }));
}

const answers = (n: number, text = "right") => Array.from({ length: n }, () => ({ answer: text }));

async function startIntakeViaTool(scope: "single" | "multi" = "single") {
  const tools = buildToolset({ userId, searchEnabled: false });
  return tools.get("start_learning_intake")!.run(
    { userId },
    { topic: "Python", objective: "ami python shikhte chai", scope },
  );
}

function post(id: string, body: Record<string, unknown>) {
  return request(app).post(`/api/intake/${id}/answers`).set(auth()).send(body);
}

/** Walks a fresh intake all the way to the finished summary. */
async function completeIntake(scope: "single" | "multi" = "single", language = "বাংলা (Bangla)") {
  const started = await startIntakeViaTool(scope);
  const id = started.intake!.intakeId;
  await post(id, { stage: "goal", answers: answers(2, "Build my own project") });
  await post(id, { stage: "language", answers: [{ answer: language }] });
  await post(id, { stage: "device", answers: [{ answer: "Windows" }] });
  for (let round = 1; round <= 4; round++) {
    await post(id, { stage: "test", round, answers: answers(4) });
  }
  const last = await post(id, { stage: "timetable", answers: answers(3, "Every day") });
  return { id, done: last.body.data as Record<string, unknown> };
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  const reg = await request(app).post("/api/auth/register").send({
    name: "Intake User",
    username: "intakeuser",
    email: "intake@example.com",
    password: "supersecret123",
  });
  token = reg.body.data.accessToken;
  userId = reg.body.data.user.id ?? reg.body.data.user._id;
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

beforeEach(async () => {
  mockGoal.mockReset();
  mockRound.mockReset();
  mockProfile.mockReset();
  mockGoal.mockResolvedValue([
    { header: "Goal", question: "Ki korte chao?", options: ["Job", "Project"] },
    { header: "Target", question: "Koto dur?", options: ["Basics", "Mastery"] },
  ]);
  mockRound.mockImplementation(async (ctx) => roundQuestions(ctx.round));
  mockProfile.mockResolvedValue({
    level: "Beginner",
    knownConcepts: ["variables"],
    gapConcepts: ["pandas"],
    goal: "Build projects",
    weeklyHours: 5,
    styleNotes: "Prefers projects",
    summary: "Starts at the basics.",
    diagnosticScore: 100,
  });
  await LearningIntakeModel.deleteMany({});
  await KnowledgeAssessmentModel.deleteMany({});
});

describe("start_learning_intake tool", () => {
  it("opens on the goal stage and tells the model to stop", async () => {
    const started = await startIntakeViaTool();
    expect(started.ok).toBe(true);
    const intake = started.intake!;
    expect(intake.stage).toBe("goal");
    expect(intake.stageIndex).toBe(1);
    expect(intake.totalStages).toBe(5);
    expect(intake.questions).toHaveLength(2);
    expect(intake.questions[0]!.header).toBe("Goal");
    expect(started.modelText).toContain("do NOT create any course yet");
  });

  it("falls back to fixed questions when the writer fails", async () => {
    mockGoal.mockRejectedValueOnce(new Error("model down"));
    const started = await startIntakeViaTool();
    // generateGoalQuestions is the only LLM call in this stage and it swallows
    // its own failures — but a rejected mock must still not dead-end the intake.
    expect(started.ok).toBe(false);
    expect(started.label).toContain("Couldn't start");
  });
});

describe("intake stages", () => {
  it("walks goal → language → device → test → timetable and returns one summary", async () => {
    const started = await startIntakeViaTool();
    const id = started.intake!.intakeId;

    const language = await post(id, { stage: "goal", answers: answers(2, "Build my own project") });
    expect(language.status).toBe(200);
    expect(language.body.data.stage).toBe("language");
    expect(language.body.data.stageIndex).toBe(2);
    expect(language.body.data.questions[0].options).toHaveLength(3);

    const device = await post(id, { stage: "language", answers: [{ answer: "Banglish (Bangla in English letters)" }] });
    expect(device.body.data.stage).toBe("device");
    expect(device.body.data.stageIndex).toBe(3);
    expect(device.body.data.questions[0].options).toEqual(["Windows", "macOS", "Linux"]);

    const test = await post(id, { stage: "device", answers: [{ answer: "my macbook" }] });
    expect(test.body.data.stage).toBe("test");
    expect(test.body.data.stageIndex).toBe(4);
    expect(test.body.data.round).toBe(1);
    expect(test.body.data.totalQuestions).toBe(16);
    // The chosen language drives the questions rather than the objective's script.
    expect(mockRound).toHaveBeenLastCalledWith(expect.objectContaining({ language: "bn-latn" }));

    let payload: Record<string, unknown> = {};
    for (let round = 1; round <= 4; round++) {
      payload = (await post(id, { stage: "test", round, answers: answers(4) })).body.data;
    }
    expect(payload.stage).toBe("timetable");
    expect(payload.stageIndex).toBe(5);
    expect((payload.questions as { header: string }[]).map((q) => q.header)).toEqual([
      "Finish by",
      "Study days",
      "Study time",
    ]);

    const done = await post(id, { stage: "timetable", answers: answers(3, "Every day") });
    expect(done.body.data.done).toBe(true);
    expect(done.body.data.nextAction).toBe("propose_courses");
    const summary = done.body.data.summary as string;
    expect(summary).toContain("Goal: Build my own project");
    expect(summary).toContain("Banglish");
    expect(summary).toContain("Starts at the basics");
    expect(summary).toContain("Study time: Every day");

    const doc = await LearningIntakeModel.findById(id).lean();
    expect(doc!.status).toBe("completed");
    expect(doc!.language).toBe("bn-latn");
    expect(doc!.timetable).toHaveLength(3);
    // Free text, not one of the three options — and it still lands on the
    // profile, where the lecture-maker's setup lane reads it.
    expect(doc!.operatingSystem).toBe("macos");
    const learner = await getLearnerProfile(userId);
    expect(learner!.operatingSystem).toBe("macos");
  });

  it("rejects answers for a stage the intake is not on", async () => {
    const started = await startIntakeViaTool();
    const res = await post(started.intake!.intakeId, { stage: "timetable", answers: answers(3) });
    expect(res.status).toBe(409);
  });

  it("resumes mid-intake instead of restarting", async () => {
    const started = await startIntakeViaTool();
    const id = started.intake!.intakeId;
    await post(id, { stage: "goal", answers: answers(2) });

    const resumed = await request(app).get(`/api/intake/${id}`).set(auth());
    expect(resumed.status).toBe(200);
    expect(resumed.body.data.stage).toBe("language");
    expect(resumed.body.data.questions).toHaveLength(1);
  });

  it("does not leak another user's intake", async () => {
    const started = await startIntakeViaTool();
    const other = await request(app).post("/api/auth/register").send({
      name: "Other Intake",
      username: "otherintake",
      email: "otherintake@example.com",
      password: "supersecret123",
    });
    const res = await request(app)
      .get(`/api/intake/${started.intake!.intakeId}`)
      .set({ Authorization: `Bearer ${other.body.data.accessToken}` });
    expect(res.status).toBe(404);
  });

  it("falls back to English for an unrecognised typed language", async () => {
    const started = await startIntakeViaTool();
    const id = started.intake!.intakeId;
    await post(id, { stage: "goal", answers: answers(2) });
    await post(id, { stage: "language", answers: [{ answer: "Klingon" }] });

    const doc = await LearningIntakeModel.findById(id).lean();
    expect(doc!.language).toBe("en");
  });
});

// A blanket "this student did an intake recently → skip it" rule sent brand-new
// topics straight to course creation with no questions at all. Reuse is now
// scoped to the topic, and deliberately errs towards asking again.
describe("topic-scoped intake reuse", () => {
  it("treats a longer phrasing of the same topic as the same topic", () => {
    expect(isSameTopic("SQL", "SQL for data analysis")).toBe(true);
    expect(isSameTopic("sql for data analysis", "SQL For Data Analysis!")).toBe(true);
  });

  it("does NOT match a different topic that shares generic words", () => {
    expect(isSameTopic("Python for data analysis", "SQL for data analysis")).toBe(false);
    expect(isSameTopic("Docker", "SQL")).toBe(false);
    expect(isSameTopic("", "SQL")).toBe(false);
  });

  it("reuses a finished intake for the same topic but not for a new one", async () => {
    await completeIntake();

    const same = await findReusableIntake(userId, "Python for data work");
    expect(same?.topic).toBe("Python");
    expect(same?.language).toBe("bn");

    expect(await findReusableIntake(userId, "Docker")).toBeNull();
  });

  it("ignores an intake that is older than the window", async () => {
    await completeIntake();
    await LearningIntakeModel.updateMany(
      {},
      { $set: { updatedAt: new Date(Date.now() - 5 * 60 * 60 * 1000) } },
      { timestamps: false },
    );
    expect(await findReusableIntake(userId, "Python")).toBeNull();
  });

  // The tool — not the router — makes the call, so the topic is available.
  it("start_learning_intake shows cards for a new topic and skips them for a repeat", async () => {
    await completeIntake();
    const tools = buildToolset({ userId, searchEnabled: false });
    const start = (topic: string) =>
      tools.get("start_learning_intake")!.run({ userId }, { topic, objective: `learn ${topic}` });

    const repeat = await start("Python");
    expect(repeat.intake).toBeUndefined();
    expect(repeat.label).toBe("Using your recent setup");
    expect(repeat.modelText).toContain("propose_courses");
    expect(repeat.modelText).toContain("বাংলা");

    const fresh = await start("Docker");
    expect(fresh.intake?.stage).toBe("goal");
    expect(fresh.intake?.questions).toHaveLength(2);
  });
});

describe("latestIntake", () => {
  it("hands the chosen language and timetable to the course generator", async () => {
    expect(await latestIntake(userId)).toBeNull();
    await completeIntake();

    const found = await latestIntake(userId);
    expect(found!.language).toBe("bn");
    expect(found!.timetable).toContain("Study time: Every day");
    expect(found!.goal).toContain("Goal:");
  });

  it("ignores an intake that is still in progress", async () => {
    await startIntakeViaTool();
    expect(await latestIntake(userId)).toBeNull();
  });
});
