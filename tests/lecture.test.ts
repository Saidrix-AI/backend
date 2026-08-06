import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { app } from "../src/app.js";
import { LectureModel } from "../src/database/models/lecture.model.js";
import { createCourse } from "../src/services/course.service.js";

let mongo: MongoMemoryServer;
let token: string;
let otherToken: string;
/** The server-assigned lessonId of the owner's only topic. */
let lessonId: string;

const auth = () => ({ Authorization: `Bearer ${token}` });
const otherAuth = () => ({ Authorization: `Bearer ${otherToken}` });

async function register(name: string, username: string, email: string) {
  const res = await request(app).post("/api/auth/register").send({
    name,
    username,
    email,
    password: "supersecret123",
  });
  return { token: res.body.data.accessToken as string, userId: res.body.data.user.id as string };
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());

  const owner = await register("Lecture User", "lectureuser", "lecture@example.com");
  token = owner.token;
  const other = await register("Other User", "otherlecture", "other-lecture@example.com");
  otherToken = other.token;

  // A lecture is only reachable through a course the caller owns, so the fixture
  // needs the course too. Ids are assigned server-side, so read it back.
  const course = await createCourse(owner.userId, {
    title: "Course X",
    chapters: [
      { title: "Chapter 1", modules: [{ title: "M1", topics: [{ title: "Intro", lessonId: "ignored" }] }] },
    ],
  });
  lessonId = course.chapters![0]!.modules[0]!.topics[0]!.lessonId;

  await LectureModel.create({
    lessonId,
    version: 2,
    language: "bn",
    course: { title: "Course X", breadcrumb: ["Course X", "Chapter 1"] },
    title: "Test Lecture",
    outline: [{ id: 1, title: "Intro", duration: "3:00" }],
    blocks: [
      { id: "b1", topicId: 1, type: "heading", level: 1, text: "Hello" },
      { id: "b2", topicId: 1, type: "code", language: "python", code: "print('hi')" },
    ],
  });
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

describe("lectures API", () => {
  it("requires auth", async () => {
    const res = await request(app).get(`/api/lectures/${lessonId}`);
    expect(res.status).toBe(401);
  });

  it("returns the lecture JSON by lessonId", async () => {
    const res = await request(app).get(`/api/lectures/${lessonId}`).set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(lessonId);
    expect(res.body.data.language).toBe("bn");
    expect(res.body.data.version).toBe(2);
    expect(res.body.data.title).toBe("Test Lecture");
    expect(res.body.data.outline).toHaveLength(1);
    expect(res.body.data.blocks).toHaveLength(2);
    expect(res.body.data.blocks[1].code).toBe("print('hi')");
  });

  /**
   * The lecture collection is global and keyed by lessonId alone — it carries no
   * owner column — so the ownership question is answered against the caller's
   * courses before the document is read. This regression test is the reason the
   * gate exists: it used to return the full lecture to any signed-in account
   * that knew (or guessed) the id.
   */
  it("404s when another user asks for it, and does not say it exists", async () => {
    const res = await request(app).get(`/api/lectures/${lessonId}`).set(otherAuth());
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain("Test Lecture");
  });

  it("404s for an unknown lessonId", async () => {
    const res = await request(app).get("/api/lectures/nope").set(auth());
    expect(res.status).toBe(404);
  });

  it("upserting the same lessonId twice keeps one document (seed idempotency)", async () => {
    const patch = {
      $set: { version: 3, title: "Test Lecture v3", blocks: [{ id: "b1", type: "paragraph", text: "x" }] },
    };
    await LectureModel.updateOne({ lessonId }, patch, { upsert: true });
    await LectureModel.updateOne({ lessonId }, patch, { upsert: true });
    const count = await LectureModel.countDocuments({ lessonId });
    expect(count).toBe(1);
    const res = await request(app).get(`/api/lectures/${lessonId}`).set(auth());
    expect(res.body.data.version).toBe(3);
  });
});
