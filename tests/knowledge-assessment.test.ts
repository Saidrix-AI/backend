import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/app.js";
import { KnowledgeAssessmentModel } from "../src/database/models/knowledgeAssessment.model.js";
import { startAssessment } from "../src/services/assessment.service.js";

// The profiler is the LLM boundary; the rounds themselves are deterministic here
// so the round machine, the scoring and the payload redaction can be asserted.
vi.mock("../src/agents/knowledge-profiler/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agents/knowledge-profiler/index.js")>();
  return { ...actual, generateRound: vi.fn(), buildProfile: vi.fn() };
});

import { buildProfile, generateRound } from "../src/agents/knowledge-profiler/index.js";

const mockRound = vi.mocked(generateRound);
const mockProfile = vi.mocked(buildProfile);

let mongo: MongoMemoryServer;
let token: string;
let userId: string;

const auth = () => ({ Authorization: `Bearer ${token}` });

/** Round 1 and 4 are self-report; 2 and 3 are diagnostics with a right answer. */
function roundQuestions(round: number) {
  const diagnostic = round === 2 || round === 3;
  return Array.from({ length: 4 }, (_, i) => ({
    header: `R${round}Q${i + 1}`,
    question: `Round ${round} question ${i + 1}?`,
    options: ["right", "wrong", "also wrong"],
    multiSelect: false,
    kind: (diagnostic ? "diagnostic" : "self_report") as "diagnostic" | "self_report",
    ...(diagnostic ? { correctIndex: 0, concept: `concept-${round}-${i}` } : {}),
  }));
}

/** Answers this round, picking the correct option for `correctCount` of them. */
function answersFor(round: number, correctCount = 4) {
  return Array.from({ length: 4 }, (_, i) => ({
    answer: round === 2 || round === 3 ? (i < correctCount ? "right" : "wrong") : "some answer",
  }));
}

// The check is no longer a chat tool of its own — it is the third stage of the
// guided intake (see intake.test.ts), so these tests drive the service directly.
async function startCheck(scope: "single" | "multi" = "single", language?: "en" | "bn" | "bn-latn") {
  return startAssessment(userId, {
    topic: "Python",
    objective: "Learn Python for data analysis",
    scope,
    ...(language ? { language } : {}),
  });
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  const reg = await request(app).post("/api/auth/register").send({
    name: "Assessed User",
    username: "assessed",
    email: "assessed@example.com",
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
  mockRound.mockReset();
  mockProfile.mockReset();
  mockRound.mockImplementation(async (ctx) => roundQuestions(ctx.round));
  mockProfile.mockResolvedValue({
    level: "Beginner",
    knownConcepts: ["variables"],
    gapConcepts: ["pandas"],
    goal: "Analyze data",
    weeklyHours: 5,
    styleNotes: "Prefers projects",
    summary: "Starts at the basics, move fast through syntax.",
    diagnosticScore: 100,
  });
  await KnowledgeAssessmentModel.deleteMany({});
});

describe("knowledge check rounds", () => {
  it("runs four rounds of four questions and then returns the profile", async () => {
    const first = await startCheck();
    expect(first.round).toBe(1);
    expect(first.questions).toHaveLength(4);
    expect(first.totalQuestions).toBe(16);

    let payload: Record<string, unknown> = first as unknown as Record<string, unknown>;
    for (let round = 1; round <= 4; round++) {
      const res = await request(app)
        .post(`/api/assessments/${first.assessmentId}/answers`)
        .set(auth())
        .send({ round, answers: answersFor(round) });
      expect(res.status).toBe(200);
      payload = res.body.data;
      if (round < 4) {
        expect(payload.round).toBe(round + 1);
        expect(payload.answered).toBe(round * 4);
        expect(payload.totalQuestions).toBe(16);
      }
    }

    expect(payload.done).toBe(true);
    expect(payload.answered).toBe(16);
    expect(payload.nextAction).toBe("generate_course");
    expect(payload.summary).toContain("Starts at the basics");

    const doc = await KnowledgeAssessmentModel.findById(first.assessmentId).lean();
    expect(doc!.status).toBe("completed");
    expect(doc!.asked).toHaveLength(16);
    expect(doc!.answers).toHaveLength(16);
  });

  it("never exposes the correct answer or the concept tag to the client", async () => {
    const started = await startCheck();
    const id = started.assessmentId;

    const next = await request(app)
      .post(`/api/assessments/${id}/answers`)
      .set(auth())
      .send({ round: 1, answers: answersFor(1) });

    // Round 2 is the diagnostic round — the stored questions have a correctIndex.
    const stored = await KnowledgeAssessmentModel.findById(id).lean();
    expect(stored!.asked.some((q) => q.correctIndex != null)).toBe(true);

    const serialized = JSON.stringify(next.body);
    expect(serialized).not.toContain("correctIndex");
    expect(serialized).not.toContain("concept");
    expect(next.body.data.questions[0]).toEqual({
      header: expect.any(String),
      question: expect.any(String),
      options: expect.any(Array),
      multiSelect: false,
    });
  });

  it("scores diagnostics server-side from the submitted option text", async () => {
    const started = await startCheck();
    const id = started.assessmentId;

    await request(app).post(`/api/assessments/${id}/answers`).set(auth()).send({ round: 1, answers: answersFor(1) });
    // Round 2: two of four correct.
    await request(app)
      .post(`/api/assessments/${id}/answers`)
      .set(auth())
      .send({ round: 2, answers: answersFor(2, 2) });

    const doc = await KnowledgeAssessmentModel.findById(id).lean();
    const round2 = doc!.answers.filter((a) => a.round === 2);
    expect(round2.map((a) => a.correct)).toEqual([true, true, false, false]);
    // Self-report answers are never scored.
    expect(doc!.answers.filter((a) => a.round === 1).every((a) => a.correct == null)).toBe(true);

    // The next round is told the measured score, not a self-reported one.
    expect(mockRound).toHaveBeenLastCalledWith(expect.objectContaining({ round: 3, diagnosticScore: 50 }));
  });

  it("rejects answers for the wrong round", async () => {
    const started = await startCheck();
    const id = started.assessmentId;

    const res = await request(app)
      .post(`/api/assessments/${id}/answers`)
      .set(auth())
      .send({ round: 3, answers: answersFor(3) });
    expect(res.status).toBe(409);

    const doc = await KnowledgeAssessmentModel.findById(id).lean();
    expect(doc!.answers).toHaveLength(0);
  });

  it("rejects a round with the wrong number of answers", async () => {
    const started = await startCheck();
    const res = await request(app)
      .post(`/api/assessments/${started.assessmentId}/answers`)
      .set(auth())
      .send({ round: 1, answers: [{ answer: "only one" }] });
    expect(res.status).toBe(400);
  });

  it("does not leak another user's assessment", async () => {
    const started = await startCheck();
    const other = await request(app).post("/api/auth/register").send({
      name: "Other User",
      username: "otheruser",
      email: "other@example.com",
      password: "supersecret123",
    });

    const res = await request(app)
      .get(`/api/assessments/${started.assessmentId}`)
      .set({ Authorization: `Bearer ${other.body.data.accessToken}` });
    expect(res.status).toBe(404);
  });

  // The language is chosen on the intake's language card and must reach every
  // round and the profile call — questions used to be written in whatever script
  // the model inferred from the objective.
  it("writes the questions in the chosen language, not a guessed one", async () => {
    const started = await startCheck("single", "bn-latn");
    expect(mockRound).toHaveBeenLastCalledWith(expect.objectContaining({ language: "bn-latn" }));

    for (let round = 1; round <= 4; round++) {
      await request(app)
        .post(`/api/assessments/${started.assessmentId}/answers`)
        .set(auth())
        .send({ round, answers: answersFor(round) });
    }
    expect(mockRound).toHaveBeenLastCalledWith(expect.objectContaining({ round: 4, language: "bn-latn" }));
    expect(mockProfile).toHaveBeenCalledWith(expect.objectContaining({ language: "bn-latn" }));

    const doc = await KnowledgeAssessmentModel.findById(started.assessmentId).lean();
    expect(doc!.language).toBe("bn-latn");
  });

  it("defaults to English when no language was chosen", async () => {
    await startCheck();
    expect(mockRound).toHaveBeenLastCalledWith(expect.objectContaining({ language: "en" }));
  });

  it("carries a multi-course scope through to the next action", async () => {
    const started = await startAssessment(userId, {
      topic: "Data science",
      objective: "Become a data scientist",
      scope: "multi",
    });

    const id = started.assessmentId;
    let body: Record<string, unknown> = {};
    for (let round = 1; round <= 4; round++) {
      const res = await request(app)
        .post(`/api/assessments/${id}/answers`)
        .set(auth())
        .send({ round, answers: answersFor(round) });
      body = res.body.data;
    }
    expect(body.nextAction).toBe("propose_courses");
  });
});

// A round is one tool call, so a single badly-shaped question used to 502 the
// whole round — which now dead-ends the guided intake. The normalizer runs
// before zod and rescues the shapes glm-5.2 actually emits.
describe("normalizeRound", () => {
  const base = { header: "H", question: "What?", options: ["a", "b", "c"] };

  it("resolves the correct answer however the model names it", async () => {
    const { normalizeRound } = await import("../src/agents/knowledge-profiler/schema.js");
    const cases: [Record<string, unknown>, number][] = [
      [{ correctIndex: 1 }, 1],
      [{ correct_index: 2 }, 2],
      [{ answer: "c" }, 2], // option text
      [{ correct: "B" }, 1], // letter label
      [{ correctAnswer: 3 }, 2], // 1-based
    ];
    for (const [extra, expected] of cases) {
      const out = normalizeRound({ questions: [{ ...base, kind: "diagnostic", ...extra }] }) as {
        questions: { correctIndex?: number; kind: string }[];
      };
      expect(out.questions[0]).toMatchObject({ kind: "diagnostic", correctIndex: expected });
    }
  });

  it("demotes an unscoreable diagnostic instead of failing the round", async () => {
    const { normalizeRound } = await import("../src/agents/knowledge-profiler/schema.js");
    const out = normalizeRound({
      questions: [
        { ...base, kind: "diagnostic" }, // no correct answer at all
        { text: "Second?", choices: ["x", "y"] }, // alternate field names
        { question: "No options?" }, // unusable — dropped
      ],
    }) as { questions: { kind: string; question: string }[] };

    expect(out.questions).toHaveLength(2);
    expect(out.questions[0]!.kind).toBe("self_report");
    expect(out.questions[1]!.question).toBe("Second?");
  });
});

describe("normalizeProfile", () => {
  it("rescues a loosely-shaped profile rather than losing the whole check", async () => {
    const { normalizeProfile } = await import("../src/agents/knowledge-profiler/schema.js");
    const out = normalizeProfile({
      level: "beginner-ish",
      known_concepts: "variables, loops",
      gaps: ["pandas"],
      weeklyHours: "5-7 hours",
      goal: "Build ML models",
    }) as Record<string, unknown>;

    expect(out).toMatchObject({
      level: "Beginner",
      knownConcepts: ["variables", "loops"],
      gapConcepts: ["pandas"],
      weeklyHours: 5,
    });
    // A missing summary is generated from what is known — the schema requires one.
    expect(out.summary).toContain("pandas");
  });

  it("maps the level from what the model actually wrote", async () => {
    const { normalizeProfile } = await import("../src/agents/knowledge-profiler/schema.js");
    const level = (v: string) =>
      (normalizeProfile({ level: v, summary: "x" }) as { level: string }).level;
    expect(level("ADVANCED")).toBe("Advanced");
    expect(level("intermediate learner")).toBe("Intermediate");
    expect(level("complete novice")).toBe("Beginner");
    expect(level("???")).toBe("Beginner");
  });
});

describe("latestProfile", () => {
  it("feeds the newest completed profile to the course brief", async () => {
    const { latestProfile } = await import("../src/services/assessment.service.js");
    expect(await latestProfile(userId)).toBeNull();

    const fresh = await startCheck();
    for (let round = 1; round <= 4; round++) {
      await request(app)
        .post(`/api/assessments/${fresh.assessmentId}/answers`)
        .set(auth())
        .send({ round, answers: answersFor(round) });
    }

    const found = await latestProfile(userId);
    expect(found!.topic).toBe("Python");
    expect(found!.profile.gapConcepts).toEqual(["pandas"]);
  });
});
