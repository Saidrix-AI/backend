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

import {
  buildProfile,
  generateRound,
  QUESTIONS_PER_ROUND,
  TOTAL_ROUNDS,
} from "../src/agents/knowledge-profiler/index.js";

const mockRound = vi.mocked(generateRound);
const mockProfile = vi.mocked(buildProfile);

let mongo: MongoMemoryServer;
let token: string;
let userId: string;

const auth = () => ({ Authorization: `Bearer ${token}` });

/**
 * The single round is all diagnostics now. The self-report questions that used
 * to fill rounds 1 and 4 moved to the intake's own slots — asking them here as
 * well was the duplication the redesign removed.
 */
function roundQuestions(round: number) {
  const diagnostic = true;
  return Array.from({ length: QUESTIONS_PER_ROUND }, (_, i) => ({
    header: `R${round}Q${i + 1}`,
    question: `Round ${round} question ${i + 1}?`,
    options: ["right", "wrong", "also wrong"],
    multiSelect: false,
    kind: (diagnostic ? "diagnostic" : "self_report") as "diagnostic" | "self_report",
    ...(diagnostic ? { correctIndex: 0, concept: `concept-${round}-${i}` } : {}),
  }));
}

/** Answers this round, picking the correct option for `correctCount` of them. */
function answersFor(_round: number, correctCount = QUESTIONS_PER_ROUND) {
  return Array.from({ length: QUESTIONS_PER_ROUND }, (_, i) => ({
    answer: i < correctCount ? "right" : "wrong",
  }));
}

// The check is no longer a chat tool of its own, nor the four-round exam it once
// was: it is the guided intake's optional diagnostic probe (see intake.test.ts),
// asked only when the director judges it worthwhile. These tests drive the
// service directly.
async function startCheck(scope: "single" | "multi" = "single", language?: string) {
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
  // Was four rounds of four. The sixteen-question exam is gone: rounds 1 and 4
  // asked what the intake slots now own, and rounds 2-3 fired eight code
  // diagnostics at everyone including absolute beginners.
  it("runs one short round and then returns the profile", async () => {
    const first = await startCheck();
    expect(first.round).toBe(1);
    expect(first.questions).toHaveLength(QUESTIONS_PER_ROUND);
    expect(first.totalRounds).toBe(TOTAL_ROUNDS);
    expect(first.totalQuestions).toBe(QUESTIONS_PER_ROUND);

    const res = await request(app)
      .post(`/api/assessments/${first.assessmentId}/answers`)
      .set(auth())
      .send({ round: 1, answers: answersFor(1) });
    expect(res.status).toBe(200);

    const payload = res.body.data;
    expect(payload.done).toBe(true);
    expect(payload.answered).toBe(QUESTIONS_PER_ROUND);
    expect(payload.nextAction).toBe("generate_course");
    expect(payload.summary).toContain("Starts at the basics");

    const doc = await KnowledgeAssessmentModel.findById(first.assessmentId).lean();
    expect(doc!.status).toBe("completed");
    expect(doc!.asked).toHaveLength(QUESTIONS_PER_ROUND);
    expect(doc!.answers).toHaveLength(QUESTIONS_PER_ROUND);
  });

  // The probe's questions come from the intake director, which writes them in
  // the same call that decides whether to ask at all — generating a round here
  // would cost a second round-trip and could not see the intake answers.
  it("uses pre-written questions instead of generating a round", async () => {
    const started = await startAssessment(userId, {
      topic: "Python",
      objective: "Learn Python",
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
    expect(mockRound).not.toHaveBeenCalled();
    expect(started.questions).toHaveLength(1);
    expect(started.questions[0]!.question).toBe("What does range(3) yield?");
  });

  it("never exposes the correct answer or the concept tag to the client", async () => {
    const started = await startCheck();
    const id = started.assessmentId;

    // The stored questions carry a correctIndex; the payload must not.
    const stored = await KnowledgeAssessmentModel.findById(id).lean();
    expect(stored!.asked.some((q) => q.correctIndex != null)).toBe(true);

    const fetched = await request(app).get(`/api/assessments/${id}`).set(auth());
    const serialized = JSON.stringify(fetched.body);
    expect(serialized).not.toContain("correctIndex");
    expect(serialized).not.toContain("concept");
    expect(fetched.body.data.questions[0]).toEqual({
      header: expect.any(String),
      question: expect.any(String),
      options: expect.any(Array),
      multiSelect: false,
    });
  });

  it("scores diagnostics server-side from the submitted option text", async () => {
    const started = await startCheck();
    const id = started.assessmentId;

    // Two of three correct.
    await request(app)
      .post(`/api/assessments/${id}/answers`)
      .set(auth())
      .send({ round: 1, answers: answersFor(1, 2) });

    const doc = await KnowledgeAssessmentModel.findById(id).lean();
    expect(doc!.answers.map((a) => a.correct)).toEqual([true, true, false]);
    // The profile is told the measured score, not a self-reported one.
    expect(mockProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        history: expect.arrayContaining([expect.objectContaining({ correct: true })]),
      }),
    );
  });

  it("rejects answers for the wrong round", async () => {
    const started = await startCheck();
    const id = started.assessmentId;

    const res = await request(app)
      .post(`/api/assessments/${id}/answers`)
      .set(auth())
      .send({ round: 2, answers: answersFor(2) });
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

  // The language is chosen on the intake's language card and must reach the
  // round and the profile call — questions used to be written in whatever
  // script the model inferred from the objective.
  it("writes the questions in the chosen language, not a guessed one", async () => {
    const started = await startCheck("single", "bn");
    expect(mockRound).toHaveBeenLastCalledWith(expect.objectContaining({ language: "bn" }));

    await request(app)
      .post(`/api/assessments/${started.assessmentId}/answers`)
      .set(auth())
      .send({ round: 1, answers: answersFor(1) });
    expect(mockProfile).toHaveBeenCalledWith(expect.objectContaining({ language: "bn" }));

    const doc = await KnowledgeAssessmentModel.findById(started.assessmentId).lean();
    expect(doc!.language).toBe("bn");
  });

  // The language set is open — a student can type one the app has no entry for
  // and it must survive all the way through rather than being coerced.
  it("carries a language that is not on the card", async () => {
    const started = await startCheck("single", "ja");
    expect(mockRound).toHaveBeenLastCalledWith(expect.objectContaining({ language: "ja" }));
    const doc = await KnowledgeAssessmentModel.findById(started.assessmentId).lean();
    expect(doc!.language).toBe("ja");
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

    const res = await request(app)
      .post(`/api/assessments/${started.assessmentId}/answers`)
      .set(auth())
      .send({ round: 1, answers: answersFor(1) });
    expect(res.body.data.nextAction).toBe("propose_courses");
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
