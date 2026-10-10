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
    version: 3,
    title: "Spoken Lecture",
    outline: [],
    sections: [
      {
        id: "t1b1",
        topicId: 1,
        title: "variables",
        kind: "theory",
        blocks: [{ id: "b1", type: "paragraph", text: "Narrate me." }],
        tutor: {
          goal: "can name a value",
          explain: ["a name points at a value"],
          ask: { question: "know this?", expectedPoints: ["a variable binds a name to a value"], worth: "ask" },
          check: { mustShow: "explains binding without being prompted", mode: "verbal" },
        },
      },
    ],
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

  it("reads what comes after the lesson, for its goodbye", async () => {
    const res = await request(app).get(`/api/lectures/${lessonId}/next`).set(asAgent());
    expect(res.status).toBe(200);
    // One topic in the fixture, so there is nothing after it — and the tutor
    // has to be able to say that rather than invent a next lesson.
    expect(res.body.data).toMatchObject({ nextLessonId: "", nextLessonTitle: "" });
  });
});

/**
 * The tutor gets the whole teaching spine; the browser gets three fields of it.
 *
 * `probe.expectedPoints` and `checkpoint.mustShow` are the rubrics a spoken
 * answer is marked against. A student who opened the network tab could read
 * back exactly what counts as understanding, and the probe would then measure
 * nothing at all — it is the tutor's only instrument for finding out where to
 * start, and an instrument whose answers are visible reports confidence that
 * was never there.
 */
describe("who sees the marking rubrics", () => {
  it("gives the tutor the full beats", async () => {
    const res = await request(app).get(`/api/lectures/${lessonId}`).set(asAgent());
    const beat = res.body.data.beats[0];
    expect(beat.probe.expectedPoints).toEqual(["a variable binds a name to a value"]);
    expect(beat.checkpoint.mustShow).toBe("explains binding without being prompted");
    expect(beat.teach.plain.points).toHaveLength(1);
  });

  it("gives the browser only enough to label the concept", async () => {
    const res = await request(app).get(`/api/lectures/${lessonId}`).set(asUser());
    expect(res.body.data.beats).toEqual([{ id: "t1b1", topicId: 1, concept: "variables", kind: "theory" }]);
    expect(JSON.stringify(res.body)).not.toContain("explains binding");
  });
});

describe("the tutor's memory of a class", () => {
  it("starts empty, keeps what the tutor writes, and reads it back with the student context", async () => {
    const first = await request(app).get(`/api/lectures/${lessonId}/tutor-context`).set(asAgent());
    expect(first.status).toBe(200);
    expect(first.body.data.classNotes).toBe("");
    const save = await request(app)
      .put(`/api/lectures/${lessonId}/class-notes`)
      .set(asAgent())
      .send({ notes: "Taught for loops; struggled with range end." });
    expect(save.status).toBe(200);
    const again = await request(app).get(`/api/lectures/${lessonId}/tutor-context`).set(asAgent());
    expect(again.body.data.classNotes).toBe("Taught for loops; struggled with range end.");
  });

  it("is the tutor's alone — a student's own token is refused", async () => {
    const res = await request(app).get(`/api/lectures/${lessonId}/tutor-context`).set(asUser());
    expect(res.status).toBe(403);
    const search = await request(app).post(`/api/lectures/${lessonId}/web-search`).set(asUser()).send({ query: "python 3.13" });
    expect(search.status).toBe(403);
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
