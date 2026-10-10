import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/app.js";
import { buildToolset } from "../src/agents/tools/registry.js";
import { LearningIntakeModel } from "../src/database/models/learningIntake.model.js";
import { KnowledgeAssessmentModel } from "../src/database/models/knowledgeAssessment.model.js";

// The three LLM boundaries are mocked: the intake plan (classification + the
// two topic questions), the probe director, and the closing report. Everything
// else — the slot machine, the skip rules, the scoring, what reaches the chat
// agent — is real.
vi.mock("../src/agents/intake/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agents/intake/index.js")>();
  return { ...actual, generateIntakePlan: vi.fn() };
});
vi.mock("../src/agents/intake/director.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agents/intake/director.js")>();
  return { ...actual, decideProbe: vi.fn() };
});
vi.mock("../src/agents/intake/report.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agents/intake/report.js")>();
  return { ...actual, buildIntakeReport: vi.fn() };
});

import { generateIntakePlan } from "../src/agents/intake/index.js";
import { decideProbe } from "../src/agents/intake/director.js";
import { buildIntakeReport } from "../src/agents/intake/report.js";
import { findReusableIntake, isSameTopic, latestIntake } from "../src/services/intake.service.js";
import { latestProfile } from "../src/services/assessment.service.js";
import { getLearnerProfile } from "../src/services/learnerProfile.service.js";

const mockPlan = vi.mocked(generateIntakePlan);
const mockProbe = vi.mocked(decideProbe);
const mockReport = vi.mocked(buildIntakeReport);

let mongo: MongoMemoryServer;
let token: string;
let userId: string;

const auth = () => ({ Authorization: `Bearer ${token}` });

function post(id: string, body: Record<string, unknown>) {
  return request(app).post(`/api/intake/${id}/answers`).set(auth()).send(body);
}

const answer = (text: string) => [{ answer: text }];

async function startIntakeViaTool(scope: "single" | "multi" = "single", topic = "Python") {
  const tools = buildToolset({ userId, searchEnabled: false });
  return tools.get("start_learning_intake")!.run(
    { userId },
    { topic, objective: `ami ${topic} shikhte chai`, scope },
  );
}

/**
 * Answers whatever stage the intake is on, until it reports done.
 *
 * `language` gets a real default rather than the generic "ok": every other slot
 * accepts anything, but that one VALIDATES, and "Ok" is a plausible-looking
 * language name that the tutor cannot speak — so the generic answer would put
 * the walk in a re-ask loop. (Before the check existed it quietly produced a
 * course in a language called "Ok".)
 */
async function walk(id: string, replies: Partial<Record<string, string[]>>) {
  let payload = (await request(app).get(`/api/intake/${id}`).set(auth())).body.data;
  const seen: string[] = [];
  for (let step = 0; step < 20 && !payload.done; step++) {
    const stage = payload.stage as string;
    seen.push(stage);
    const fallback = stage === "language" ? ["English"] : payload.questions.map(() => "ok");
    const given = replies[stage] ?? fallback;
    const res = await post(id, {
      stage,
      ...(payload.round ? { round: payload.round } : {}),
      answers: given.map((a: string) => ({ answer: a })),
    });
    expect(res.status).toBe(200);
    payload = res.body.data;
  }
  return { seen, done: payload as Record<string, unknown> };
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
  mockPlan.mockReset();
  mockProbe.mockReset();
  mockReport.mockReset();

  mockPlan.mockResolvedValue({
    topicKind: "programming",
    needsLocalSetup: true,
    goalQuestion: { header: "Goal", question: "Ki korte chao?", options: ["Job", "Project"] },
    backgroundQuestion: {
      header: "Background",
      question: "Age ki korecho?",
      options: ["Kichu na", "Ektu"],
    },
  });
  mockProbe.mockResolvedValue({ ask: false, reason: "absolute beginner" });
  mockReport.mockResolvedValue({
    level: "Beginner",
    startFrom: "what a variable is",
    skip: [],
    knownConcepts: [],
    gapConcepts: ["variables", "loops"],
    goal: "Build projects",
    weeklyHours: 5,
    styleNotes: "Prefers projects",
    summary: "Starts at the basics.",
    diagnosticScore: null,
  });

  await LearningIntakeModel.deleteMany({});
  await KnowledgeAssessmentModel.deleteMany({});
});

describe("start_learning_intake tool", () => {
  it("opens on the language card with no model call in front of it", async () => {
    const started = await startIntakeViaTool();
    expect(started.ok).toBe(true);
    const intake = started.intake!;
    expect(intake.stage).toBe("language");
    expect(intake.stageIndex).toBe(1);
    expect(intake.questions).toHaveLength(1);
    // The plan call is deferred until the language is known, so the first card
    // costs nothing and the topic questions get written in the right language.
    expect(mockPlan).not.toHaveBeenCalled();
    expect(started.modelText).toContain("do NOT create any course yet");
  });

  it("offers four distinct languages and no Banglish", async () => {
    const started = await startIntakeViaTool();
    const options = started.intake!.questions[0]!.options;
    expect(options).toHaveLength(4);
    expect(options.join(" ")).not.toMatch(/banglish/i);
    expect(options.filter((o) => /bangla|বাংলা/i.test(o))).toHaveLength(1);
  });
});

/**
 * A language we can WRITE but cannot SPEAK.
 *
 * The lessons are taught out loud, so a course in a language the tutor has no
 * voice for is a document the student meets in silence. The honest moment to
 * say so is at the card, not when they open a classroom ten minutes later.
 */
describe("a language the tutor cannot speak", () => {
  it("asks again instead of accepting it", async () => {
    const started = await startIntakeViaTool();
    const id = started.intake!.intakeId;

    const res = await post(id, { stage: "language", answers: answer("Nepali") });
    expect(res.status).toBe(200);
    // Same stage, new question — the intake has not moved on.
    expect(res.body.data.stage).toBe("language");
    expect(res.body.data.done).toBeFalsy();

    const asked = res.body.data.questions[0];
    // Names their language back rather than calling it unsupported.
    expect(asked.question).toContain("नेपाली");
    expect(asked.question).toMatch(/can't yet SPEAK it/i);
    // Neighbours, not the generic four: Nepali's are Hindi and Bangla.
    expect(asked.options[0]).toContain("Hindi");
    expect(asked.options.join(" ")).toMatch(/বাংলা/);
  });

  it("does not spend the plan call on a language it is about to refuse", async () => {
    const started = await startIntakeViaTool();
    const id = started.intake!.intakeId;

    await post(id, { stage: "language", answers: answer("Nepali") });
    // The plan is a model round-trip written IN the chosen language. Paying for
    // one in a language we are rejecting is paying for an answer we discard.
    expect(mockPlan).not.toHaveBeenCalled();

    await post(id, { stage: "language", answers: answer("हिन्दी (Hindi)") });
    expect(mockPlan).toHaveBeenCalledTimes(1);
    expect(mockPlan.mock.calls[0]![0]).toMatchObject({ language: "hi" });
  });

  it("carries on normally once they pick one we can speak", async () => {
    const started = await startIntakeViaTool();
    const id = started.intake!.intakeId;

    await post(id, { stage: "language", answers: answer("Swahili") });
    const res = await post(id, { stage: "language", answers: answer("বাংলা (Bangla)") });
    expect(res.body.data.stage).toBe("goal");

    const doc = await LearningIntakeModel.findById(id).lean();
    expect(doc!.language).toBe("bn");
    // Both attempts are in the transcript: what they asked for first is part of
    // the conversation, and the report reads better for having it.
    const asked = doc!.answers.filter((a) => a.stage === "language").map((a) => a.answer);
    expect(asked).toEqual(["Swahili", "বাংলা (Bangla)"]);
  });

  it("offers the generic four when it cannot even name the language", async () => {
    const started = await startIntakeViaTool();
    const id = started.intake!.intakeId;

    const res = await post(id, { stage: "language", answers: answer("Swahili") });
    expect(res.body.data.questions[0].question).toContain("Swahili");
    // A slug carries no family information, so suggesting neighbours would be
    // invention. The card's own four is the honest fallback.
    expect(res.body.data.questions[0].options).toHaveLength(4);
  });
});

describe("the slot machine", () => {
  it("walks a coding beginner in 8 questions and never tests them", async () => {
    const started = await startIntakeViaTool();
    const id = started.intake!.intakeId;

    const { seen, done } = await walk(id, {
      language: ["বাংলা (Bangla)"],
      goal: ["Project"],
      os: ["Windows"],
      tools: ["I don't know what that is"],
      background: ["Kichu na"],
      schedule: ["Within 1 month", "About 1 hour"],
      routine: ["Yes — evenings (06:00 PM)"],
    });

    // foundation is skipped: they just said they do not know what an editor is,
    // which answers the programming-basics question. probe is skipped by the
    // director. That is 8 questions where the old intake asked 23.
    expect(seen).toEqual(["language", "goal", "os", "tools", "background", "schedule", "routine"]);
    expect(done.done).toBe(true);

    const doc = await LearningIntakeModel.findById(id).lean();
    expect(doc!.status).toBe("completed");
    expect(doc!.skipped).toContain("foundation");
    expect(doc!.skipped).toContain("probe");
    expect(doc!.answers).toHaveLength(8);
  });

  it("skips the computer, editor and programming slots for a non-technical subject", async () => {
    mockPlan.mockResolvedValue({
      topicKind: "non-technical",
      needsLocalSetup: false,
      goalQuestion: { header: "Goal", question: "Why IELTS?", options: ["Study abroad", "Work"] },
      backgroundQuestion: { header: "Background", question: "Taken it before?", options: ["No", "Yes"] },
    });
    const started = await startIntakeViaTool("single", "IELTS preparation");
    const { seen } = await walk(started.intake!.intakeId, {
      schedule: ["Within 1 month", "About 1 hour"],
      routine: ["No — I'll set it up myself later"],
    });

    expect(seen).toEqual(["language", "goal", "background", "schedule", "routine"]);
    expect(seen).not.toContain("os");
    expect(seen).not.toContain("tools");
    expect(seen).not.toContain("foundation");
  });

  it("asks the programming question when the student knows what an editor is", async () => {
    const started = await startIntakeViaTool();
    const { seen } = await walk(started.intake!.intakeId, {
      tools: ["Yes — VS Code"],
      schedule: ["Within 1 month", "About 1 hour"],
      routine: ["No — I'll set it up myself later"],
    });
    expect(seen).toContain("foundation");
  });

  it("runs the diagnostic when the director asks for one", async () => {
    mockProbe.mockResolvedValue({
      ask: true,
      reason: "claims real experience",
      questions: [
        {
          header: "Loops",
          question: "What does range(3) yield?",
          options: ["0 1 2", "1 2 3"],
          multiSelect: false,
          kind: "diagnostic",
          correctIndex: 0,
          concept: "range",
        },
      ],
    });

    const started = await startIntakeViaTool();
    const id = started.intake!.intakeId;
    const { seen } = await walk(id, {
      tools: ["Yes — VS Code"],
      background: ["Ektu"],
      probe: ["0 1 2"],
      schedule: ["Within 1 month", "About 1 hour"],
      routine: ["Yes — mornings (08:00 AM)"],
    });

    expect(seen).toContain("probe");
    // The answer key never left the server, so the score is computed here.
    expect(mockReport).toHaveBeenCalledWith(
      expect.objectContaining({ diagnostic: expect.objectContaining({ correct: 1, total: 1 }) }),
    );
  });

  it("rejects answers for a stage the intake is not on", async () => {
    const started = await startIntakeViaTool();
    const res = await post(started.intake!.intakeId, { stage: "routine", answers: answer("x") });
    expect(res.status).toBe(409);
  });

  it("resumes mid-intake instead of restarting", async () => {
    const started = await startIntakeViaTool();
    const id = started.intake!.intakeId;
    await post(id, { stage: "language", answers: answer("English") });

    const resumed = await request(app).get(`/api/intake/${id}`).set(auth());
    expect(resumed.status).toBe(200);
    expect(resumed.body.data.stage).toBe("goal");
    expect(resumed.body.data.questions[0].question).toBe("Ki korte chao?");
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
});

describe("language", () => {
  it("stamps the chosen language and writes the topic questions in it", async () => {
    const started = await startIntakeViaTool();
    const id = started.intake!.intakeId;
    await post(id, { stage: "language", answers: answer("বাংলা (Bangla)") });

    expect(mockPlan).toHaveBeenCalledWith(expect.objectContaining({ language: "bn" }));
    const doc = await LearningIntakeModel.findById(id).lean();
    expect(doc!.language).toBe("bn");
  });

  // The regression the open language set exists for.
  it("honours a typed language that is not on the card", async () => {
    const started = await startIntakeViaTool();
    const id = started.intake!.intakeId;
    await post(id, { stage: "language", answers: answer("Japanese") });

    const doc = await LearningIntakeModel.findById(id).lean();
    expect(doc!.language).toBe("ja");
    expect(mockPlan).toHaveBeenCalledWith(expect.objectContaining({ language: "ja" }));
  });
});

describe("the finished intake", () => {
  it("hands the chat agent a brief rather than a dump of answers", async () => {
    const started = await startIntakeViaTool();
    const { done } = await walk(started.intake!.intakeId, {
      language: ["বাংলা (Bangla)"],
      os: ["my macbook"],
      tools: ["No, nothing installed yet"],
      schedule: ["Within 1 month", "About 2 hours"],
      routine: ["Yes — evenings (06:00 PM)"],
    });

    const summary = done.summary as string;
    expect(done.nextAction).toBe("propose_courses");
    expect(summary).toContain("Level: Beginner");
    expect(summary).toContain("Start from: what a variable is");
    expect(summary).toContain("no diagnostic was asked");
    expect(summary).toContain("include a setup lesson");
    expect(summary).toContain("120 minutes a day");
    expect(summary).toContain("Auto-routine: YES");
    expect(summary).toContain("06:00 PM");
  });

  it("tells the agent NOT to build a routine when the student declined", async () => {
    const started = await startIntakeViaTool();
    const { done } = await walk(started.intake!.intakeId, {
      schedule: ["Within 1 month", "About 1 hour"],
      routine: ["No — I'll set it up myself later"],
    });
    expect(done.summary as string).toContain("Auto-routine: NO");
    expect(done.summary as string).toContain("do not build one");
  });

  it("saves the operating system onto the learner profile for the setup lane", async () => {
    const started = await startIntakeViaTool();
    await walk(started.intake!.intakeId, {
      os: ["my macbook"],
      schedule: ["Within 1 month", "About 1 hour"],
      routine: ["No — I'll set it up myself later"],
    });
    const learner = await getLearnerProfile(userId);
    expect(learner!.operatingSystem).toBe("macos");
  });

  // The regression that would otherwise be invisible: with no diagnostic there
  // is no KnowledgeAssessment, so latestProfile() finds nothing and the
  // course-maker silently loses the whole learner picture.
  it("always leaves a completed knowledge profile, even with no diagnostic", async () => {
    const started = await startIntakeViaTool();
    await walk(started.intake!.intakeId, {
      schedule: ["Within 1 month", "About 1 hour"],
      routine: ["No — I'll set it up myself later"],
    });

    const found = await latestProfile(userId);
    expect(found).not.toBeNull();
    expect(found!.profile.level).toBe("Beginner");
    expect(found!.profile.diagnosticScore).toBeNull();
    expect(found!.profile.gapConcepts).toContain("variables");
  });
});

// A blanket "this student did an intake recently → skip it" rule sent brand-new
// topics straight to course creation with no questions at all. Reuse is scoped
// to the topic, and deliberately errs towards asking again.
describe("topic-scoped intake reuse", () => {
  async function completeIntake(topic = "Python") {
    const started = await startIntakeViaTool("single", topic);
    await walk(started.intake!.intakeId, {
      language: ["বাংলা (Bangla)"],
      schedule: ["Within 1 month", "About 1 hour"],
      routine: ["No — I'll set it up myself later"],
    });
  }

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

  it("shows cards for a new topic and skips them for a repeat", async () => {
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
    expect(fresh.intake?.stage).toBe("language");
  });
});

describe("latestIntake", () => {
  it("hands the course generator the language, the brief and the schedule", async () => {
    expect(await latestIntake(userId)).toBeNull();

    const started = await startIntakeViaTool();
    await walk(started.intake!.intakeId, {
      language: ["বাংলা (Bangla)"],
      tools: ["No, nothing installed yet"],
      schedule: ["Within 2 weeks", "About 2 hours"],
      routine: ["Yes — mornings (08:00 AM)"],
    });

    const found = await latestIntake(userId);
    expect(found!.language).toBe("bn");
    expect(found!.dailyMinutes).toBe(120);
    expect(found!.finishByDays).toBe(14);
    expect(found!.autoRoutine).toBe(true);
    expect(found!.routineTime).toBe("08:00 AM");
    expect(found!.report!.startFrom).toBe("what a variable is");
    // Derived from the editor answer, never from the model.
    expect(found!.report!.needsSetupLesson).toBe(true);
    expect(found!.timetable).toContain("Daily time");
  });

  it("ignores an intake that is still in progress", async () => {
    await startIntakeViaTool();
    expect(await latestIntake(userId)).toBeNull();
  });
});
