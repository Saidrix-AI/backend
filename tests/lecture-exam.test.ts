import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { app } from "../src/app.js";
import { KnowledgeAssessmentModel } from "../src/database/models/knowledgeAssessment.model.js";
import { LectureModel } from "../src/database/models/lecture.model.js";
import { QuizAttemptModel } from "../src/database/models/quizAttempt.model.js";
import { recordQuizOutcome } from "../src/services/assessment.service.js";
import { createCourse } from "../src/services/course.service.js";

// The lecture's closing quiz is a graded exam: the browser must never receive
// the answer key, and the result has to reach both the attempt log and the
// knowledge profile that calibrates future courses.

let mongo: MongoMemoryServer;
let token: string;
let userId: string;
let otherToken: string;

// Server-assigned lesson ids for the three fixture lectures.
let examLesson: string;
let untaggedLesson: string;
let noQuizLesson: string;

const auth = () => ({ Authorization: `Bearer ${token}` });
const otherAuth = () => ({ Authorization: `Bearer ${otherToken}` });

const QUESTIONS = [
  {
    question: "What does print() do?",
    options: ["Reads input", "Writes output", "Deletes a file"],
    correctIndex: 1,
    explanation: "print() writes to standard output.",
    concept: "output",
  },
  {
    question: "Which quote style works for a Python string?",
    options: ["Only double", "Single or double", "Only backticks"],
    correctIndex: 1,
    explanation: "Python accepts both.",
    concept: "strings",
  },
];

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  const reg = await request(app).post("/api/auth/register").send({
    name: "Exam User",
    username: "examuser",
    email: "exam@example.com",
    password: "supersecret123",
  });
  token = reg.body.data.accessToken;
  userId = reg.body.data.user.id ?? reg.body.data.user._id;

  const other = await request(app).post("/api/auth/register").send({
    name: "Other Exam User",
    username: "otherexamuser",
    email: "other-exam@example.com",
    password: "supersecret123",
  });
  otherToken = other.body.data.accessToken;

  // An exam is only reachable through a course the caller owns, so the fixture
  // needs one. Lesson ids are assigned server-side — read them back.
  const course = await createCourse(userId, {
    title: "Python",
    chapters: [
      {
        title: "Ch",
        modules: [
          {
            title: "M",
            topics: [
              { title: "Exam", lessonId: "ignored" },
              { title: "Untagged", lessonId: "ignored" },
              { title: "No quiz", lessonId: "ignored" },
            ],
          },
        ],
      },
    ],
  });
  const topics = course.chapters![0]!.modules[0]!.topics;
  examLesson = topics[0]!.lessonId;
  untaggedLesson = topics[1]!.lessonId;
  noQuizLesson = topics[2]!.lessonId;

  await LectureModel.create({
    lessonId: examLesson,
    title: "Exam Lecture",
    outline: [{ id: 1, title: "Intro", duration: "3:00" }],
    blocks: [
      { id: "b1", topicId: 1, type: "paragraph", text: "Body text." },
      { id: "b2", topicId: 1, type: "quiz", title: "Check", questions: QUESTIONS },
    ],
  });

  // A lecture from before questions carried concept tags.
  await LectureModel.create({
    lessonId: untaggedLesson,
    title: "Untagged Lecture",
    outline: [{ id: 1, title: "Intro", duration: "1:00" }],
    blocks: [
      {
        id: "u1",
        topicId: 1,
        type: "quiz",
        questions: [{ question: "2 + 2?", options: ["3", "4"], correctIndex: 1 }],
      },
    ],
  });
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

beforeEach(async () => {
  await QuizAttemptModel.deleteMany({});
  await KnowledgeAssessmentModel.deleteMany({});
});

describe("the answer key never reaches the browser", () => {
  it("strips correctIndex, explanation and concept from a served lecture", async () => {
    const res = await request(app).get(`/api/lectures/${examLesson}`).set(auth());
    expect(res.status).toBe(200);

    const quiz = res.body.data.blocks.find((b: { type: string }) => b.type === "quiz");
    expect(quiz.questions).toHaveLength(2);
    for (const q of quiz.questions) {
      expect(q.question).toBeTruthy();
      expect(q.options).toHaveLength(3);
      expect(q).not.toHaveProperty("correctIndex");
      expect(q).not.toHaveProperty("explanation");
      expect(q).not.toHaveProperty("concept");
    }
    // Belt and braces: the key must not survive anywhere in the payload.
    expect(JSON.stringify(res.body)).not.toContain("correctIndex");
  });

  it("leaves non-quiz blocks untouched", async () => {
    const res = await request(app).get(`/api/lectures/${examLesson}`).set(auth());
    const para = res.body.data.blocks.find((b: { type: string }) => b.type === "paragraph");
    expect(para.text).toBe("Body text.");
  });
});

describe("grading", () => {
  it("scores a fully correct attempt and returns the key with the result", async () => {
    const res = await request(app)
      .post(`/api/lectures/${examLesson}/quiz`)
      .set(auth())
      .send({ answers: [1, 1] });

    expect(res.status).toBe(200);
    expect(res.body.data.score).toBe(100);
    expect(res.body.data.correctCount).toBe(2);
    expect(res.body.data.questions[0]).toMatchObject({ correct: true, correctIndex: 1 });
    expect(res.body.data.questions[0].explanation).toContain("standard output");
  });

  it("scores a partly wrong attempt and marks which one failed", async () => {
    const res = await request(app)
      .post(`/api/lectures/${examLesson}/quiz`)
      .set(auth())
      .send({ answers: [0, 1] });

    expect(res.body.data.score).toBe(50);
    expect(res.body.data.questions[0].correct).toBe(false);
    expect(res.body.data.questions[1].correct).toBe(true);
  });

  it("records the attempt so it counts toward progress", async () => {
    await request(app).post(`/api/lectures/${examLesson}/quiz`).set(auth()).send({ answers: [1, 0] });

    const attempts = await QuizAttemptModel.find({}).lean();
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.score).toBe(50);
    expect(attempts[0]!.quizId).toBe(examLesson);
    // First sitting counts; see the retake test below.
    expect(attempts[0]!.graded).toBe(true);
  });

  /**
   * Submitting returns the answer key, because reviewing what you missed is the
   * point of the exam. That makes a retake an exam sat with the answers in hand,
   * so it is recorded as practice and cannot move the score. Without this,
   * "submit anything, read correctIndex, resubmit" scored 100 on every lesson.
   */
  it("records a retake as practice, not as a graded attempt", async () => {
    const first = await request(app).post(`/api/lectures/${examLesson}/quiz`).set(auth()).send({ answers: [0, 0] });
    expect(first.body.data.score).toBe(0);
    expect(first.body.data.graded).toBe(true);

    // The key came back, so a second attempt can be perfect — and must not count.
    const key = first.body.data.questions.map((q: { correctIndex: number }) => q.correctIndex);
    const retake = await request(app).post(`/api/lectures/${examLesson}/quiz`).set(auth()).send({ answers: key });
    expect(retake.body.data.score).toBe(100);
    expect(retake.body.data.graded).toBe(false);

    const attempts = await QuizAttemptModel.find({}).sort({ createdAt: 1 }).lean();
    expect(attempts.map((a) => a.graded)).toEqual([true, false]);
  });

  it("counts an out-of-range pick as wrong instead of erroring", async () => {
    const res = await request(app)
      .post(`/api/lectures/${examLesson}/quiz`)
      .set(auth())
      .send({ answers: [1, 47] });
    expect(res.status).toBe(200);
    expect(res.body.data.score).toBe(50);
  });

  it("rejects a malformed body", async () => {
    for (const body of [{}, { answers: "1,2" }, { answers: [] }, { answers: [-1] }]) {
      const res = await request(app).post(`/api/lectures/${examLesson}/quiz`).set(auth()).send(body);
      expect(res.status).toBe(400);
    }
  });

  it("404s a lecture that has no quiz", async () => {
    await LectureModel.create({
      lessonId: noQuizLesson,
      title: "No Quiz",
      outline: [],
      blocks: [{ id: "x", type: "paragraph", text: "nothing here" }],
    });
    const res = await request(app).post(`/api/lectures/${noQuizLesson}/quiz`).set(auth()).send({ answers: [0] });
    expect(res.status).toBe(404);
  });

  it("requires auth", async () => {
    const res = await request(app).post(`/api/lectures/${examLesson}/quiz`).send({ answers: [1, 1] });
    expect(res.status).toBe(401);
  });

  /**
   * The grading route took no user id at all and ran no ownership check, so any
   * signed-in account could post to another student's lesson and receive
   * `correctIndex` plus `explanation` for every question. This is the regression
   * test for that.
   */
  it("404s another user's exam and leaks no part of the answer key", async () => {
    const res = await request(app)
      .post(`/api/lectures/${examLesson}/quiz`)
      .set(otherAuth())
      .send({ answers: [1, 1] });

    expect(res.status).toBe(404);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain("correctIndex");
    expect(body).not.toContain("standard output");

    // And it must not have recorded an attempt for them either.
    expect(await QuizAttemptModel.countDocuments({})).toBe(0);
  });
});

describe("the exam moves the knowledge profile", () => {
  const seedProfile = (over: Record<string, unknown> = {}) =>
    KnowledgeAssessmentModel.create({
      userId: new mongoose.Types.ObjectId(userId),
      topic: "Python",
      objective: "Learn Python",
      status: "completed",
      profile: {
        level: "Beginner",
        knownConcepts: [],
        gapConcepts: ["output"],
        goal: "",
        weeklyHours: 0,
        styleNotes: "",
        summary: "",
        diagnosticScore: 40,
        ...over,
      },
    });

  it("clears a concept out of gapConcepts once it is answered correctly", async () => {
    await seedProfile();
    await recordQuizOutcome(userId, {
      score: 100,
      concepts: [{ concept: "output", correct: true }],
    });

    const doc = await KnowledgeAssessmentModel.findOne({}).lean();
    expect(doc!.profile!.gapConcepts).not.toContain("output");
    expect(doc!.profile!.knownConcepts).toContain("output");
  });

  it("moves a failed concept into gapConcepts and out of known", async () => {
    await seedProfile({ knownConcepts: ["strings"], gapConcepts: [] });
    await recordQuizOutcome(userId, {
      score: 0,
      concepts: [{ concept: "strings", correct: false }],
    });

    const doc = await KnowledgeAssessmentModel.findOne({}).lean();
    expect(doc!.profile!.gapConcepts).toContain("strings");
    expect(doc!.profile!.knownConcepts).not.toContain("strings");
  });

  it("raises the level on strong results", async () => {
    await seedProfile();
    await recordQuizOutcome(userId, { score: 100, concepts: [] });
    const doc = await KnowledgeAssessmentModel.findOne({}).lean();
    expect(doc!.profile!.level).toBe("Advanced");
    expect(doc!.profile!.diagnosticScore).toBe(100);
  });

  it("blends over recent attempts, so one bad exam does not demote", async () => {
    await seedProfile();
    for (const score of [100, 100, 100]) {
      await QuizAttemptModel.create({
        userId: new mongoose.Types.ObjectId(userId),
        quizId: "prior",
        score,
      });
    }
    await recordQuizOutcome(userId, { score: 0, concepts: [] });

    const doc = await KnowledgeAssessmentModel.findOne({}).lean();
    // (0 + 100*3) / 4 = 75 — still Intermediate, not knocked back to Beginner.
    expect(doc!.profile!.level).toBe("Intermediate");
  });

  it("does nothing when the student has no completed knowledge check", async () => {
    await expect(recordQuizOutcome(userId, { score: 90, concepts: [] })).resolves.toBeUndefined();
  });

  it("still records a score for a lecture whose questions have no concept tags", async () => {
    await seedProfile();
    const res = await request(app)
      .post(`/api/lectures/${untaggedLesson}/quiz`)
      .set(auth())
      .send({ answers: [1] });

    expect(res.status).toBe(200);
    expect(res.body.data.score).toBe(100);
    expect(res.body.data.concepts).toEqual([]);
    const attempts = await QuizAttemptModel.find({}).lean();
    expect(attempts).toHaveLength(1);
  });
});
