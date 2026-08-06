import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { app } from "../src/app.js";
import { LectureModel } from "../src/database/models/lecture.model.js";
import { createCourse } from "../src/services/course.service.js";
import {
  signAccessToken,
  signVoiceAgentToken,
  verifyAccessToken,
  verifyVoiceAgentToken,
} from "../src/services/token.service.js";

/**
 * The voice agent runs as a separate process and calls the API as the student
 * whose room it is in, which means it holds a key that can act as anyone.
 *
 * It used to hold JWT_ACCESS_SECRET itself and mint ordinary login tokens, so
 * read access to voice-service/.env — or a compromise of that host — was
 * account takeover for every user, on every route. These tests pin the two
 * properties that now contain it: an agent token is not a login token, and it
 * only opens the four routes the agent actually needs.
 */

let mongo: MongoMemoryServer;
let userToken: string;
let agentToken: string;
let userId: string;
let lessonId: string;
let courseId: string;

const asUser = () => ({ Authorization: `Bearer ${userToken}` });
const asAgent = () => ({ Authorization: `Bearer ${agentToken}` });

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());

  const reg = await request(app).post("/api/auth/register").send({
    name: "Voice Student",
    username: "voicestudent",
    email: "voice-student@example.com",
    password: "supersecret123",
  });
  userToken = reg.body.data.accessToken;
  userId = reg.body.data.user.id;
  agentToken = signVoiceAgentToken(userId);

  const course = await createCourse(userId, {
    title: "Spoken Course",
    chapters: [
      { title: "Ch", modules: [{ title: "M", topics: [{ title: "T", lessonId: "ignored" }] }] },
    ],
  });
  courseId = String(course._id);
  lessonId = course.chapters![0]!.modules[0]!.topics[0]!.lessonId;

  await LectureModel.create({
    lessonId,
    title: "Spoken Lecture",
    outline: [],
    blocks: [{ id: "b1", type: "paragraph", text: "Narrate me." }],
  });
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

describe("token issuers are not interchangeable", () => {
  it("rejects an agent token where a login token is expected", () => {
    expect(() => verifyAccessToken(agentToken)).toThrow();
  });

  it("rejects a login token where an agent token is expected", () => {
    expect(() => verifyVoiceAgentToken(signAccessToken(userId, "x@example.com"))).toThrow();
  });
});

describe("what a voice-agent token can reach", () => {
  it("reads the lecture it is narrating", async () => {
    const res = await request(app).get(`/api/lectures/${lessonId}`).set(asAgent());
    expect(res.status).toBe(200);
    expect(res.body.data.title).toBe("Spoken Lecture");
  });

  it("reads and writes the student's position", async () => {
    const save = await request(app)
      .put(`/api/lectures/${lessonId}/position`)
      .set(asAgent())
      .send({ blockIndex: 3, mode: "lecture", courseId });
    expect(save.status).toBe(200);

    const read = await request(app).get(`/api/lectures/${lessonId}/position`).set(asAgent());
    expect(read.body.data.blockIndex).toBe(3);
  });

  it("checks a lesson off when narration finishes", async () => {
    const res = await request(app)
      .post("/api/progress/complete-lesson")
      .set(asAgent())
      .send({ courseId, lessonId });
    expect(res.status).toBe(200);
  });
});

describe("what a voice-agent token must NOT reach", () => {
  // One representative route per surface the agent has no business touching.
  // Each must answer 401 — not 403 — because the credential is not accepted at
  // all here, rather than accepted and then found insufficient.
  const forbidden: [string, "get" | "post" | "patch"][] = [
    ["/api/user/profile", "get"],
    ["/api/billing/subscription", "get"],
    ["/api/billing/invoices", "get"],
    ["/api/courses", "get"],
    ["/api/projects", "get"],
    ["/api/routine", "get"],
    ["/api/progress/enrollments", "get"],
    ["/api/auth/me", "get"],
  ];

  for (const [path, method] of forbidden) {
    it(`401s ${method.toUpperCase()} ${path}`, async () => {
      const res = await request(app)[method](path).set(asAgent());
      expect(res.status).toBe(401);

      // Sanity: the same request with a real login token is not a 401, so the
      // rejection is about the credential and not about the route being broken.
      const asStudent = await request(app)[method](path).set(asUser());
      expect(asStudent.status).not.toBe(401);
    });
  }

  it("401s the lecture routes it does not need (generate, quiz)", async () => {
    const gen = await request(app).post(`/api/lectures/${lessonId}/generate`).set(asAgent());
    expect(gen.status).toBe(401);

    const quiz = await request(app)
      .post(`/api/lectures/${lessonId}/quiz`)
      .set(asAgent())
      .send({ answers: [0] });
    expect(quiz.status).toBe(401);
  });

  it("401s the other progress routes", async () => {
    const enroll = await request(app).post("/api/progress/enroll").set(asAgent()).send({ courseId });
    expect(enroll.status).toBe(401);
  });
});
