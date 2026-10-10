import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { app } from "../src/app.js";
import { QuizAttemptModel } from "../src/database/models/quizAttempt.model.js";
import { createCourse } from "../src/services/course.service.js";
import { signVoiceAgentToken } from "../src/services/token.service.js";

/**
 * What the live tutor assumes about a student before they speak.
 *
 * The class that produced this: a student scored 1/8 on a lesson's exam, went
 * straight into the next lesson, and was asked "what do you already know?" six
 * topics in a row. The tutor had no way to know about the exam. This endpoint is
 * how it finds out — so it must reflect THIS course's graded attempts only, and
 * carry nothing a prompt could be steered by.
 */

let mongo: MongoMemoryServer;
let userId: string;
let agentToken: string;
let otherToken: string;
let lessonId: string;
let courseId: string;

const asAgent = () => ({ Authorization: `Bearer ${agentToken}` });

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  const register = (name: string, username: string, email: string) =>
    request(app).post("/api/auth/register").send({ name, username, email, password: "supersecret123" });

  const reg = await register("Signal Student", "signalstudent", "signal@example.com");
  userId = reg.body.data.user.id;
  agentToken = signVoiceAgentToken(userId);
  otherToken = (await register("Other Signal", "othersignal", "other-signal@example.com")).body.data.accessToken;

  const course = await createCourse(userId, {
    title: "HTML Basics",
    chapters: [{ title: "Ch", modules: [{ title: "M", topics: [{ title: "T", lessonId: "ignored" }] }] }],
  });
  lessonId = course.chapters![0]!.modules[0]!.topics[0]!.lessonId;
  courseId = String(course._id);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

describe("learner signal", () => {
  it("is the course level with no exam evidence before any exam", async () => {
    const res = await request(app).get(`/api/lectures/${lessonId}/learner-signal`).set(asAgent());
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ level: "beginner", recentExamPct: null, recentExams: 0 });
  });

  it("averages this course's recent graded exams, ignoring retakes and other courses", async () => {
    const uid = new Types.ObjectId(userId);
    await QuizAttemptModel.create([
      { userId: uid, quizId: "l1", courseId, score: 12.5 },
      { userId: uid, quizId: "l1", courseId, score: 100, graded: false }, // retake with the key
      { userId: uid, quizId: "x1", courseId: "another-course", score: 100 },
    ]);
    const res = await request(app).get(`/api/lectures/${lessonId}/learner-signal`).set(asAgent());
    expect(res.body.data).toEqual({ level: "beginner", recentExamPct: 13, recentExams: 1 });
  });

  it("is not readable for a lesson the caller does not own", async () => {
    const res = await request(app)
      .get(`/api/lectures/${lessonId}/learner-signal`)
      .set({ Authorization: `Bearer ${otherToken}` });
    expect(res.status).toBe(404);
  });
});
