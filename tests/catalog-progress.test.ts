import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { app } from "../src/app.js";
import { createCourse } from "../src/services/course.service.js";

let mongo: MongoMemoryServer;
let token: string;
let courseId: string;
let lessonId: string;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  const res = await request(app).post("/api/auth/register").send({
    name: "Catalog Tester",
    username: "catalogtester",
    email: "catalog@example.com",
    password: "supersecret123",
  });
  token = res.body.data.accessToken;

  // Progress is only recorded against a course the caller owns, and against a
  // lessonId that course actually contains — both are checked server-side.
  const course = await createCourse(res.body.data.user.id, {
    title: "Python for AI",
    chapters: [
      { title: "Ch", modules: [{ title: "M", topics: [{ title: "One", lessonId: "ignored" }] }] },
    ],
  });
  courseId = String(course._id);
  lessonId = course.chapters![0]!.modules[0]!.topics[0]!.lessonId;
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

const auth = () => ({ Authorization: `Bearer ${token}` });

describe("enrollments listing", () => {
  it("returns enrolled courses with completed lessons", async () => {
    await request(app).post("/api/progress/enroll").set(auth()).send({ courseId });
    await request(app)
      .post("/api/progress/complete-lesson")
      .set(auth())
      .send({ courseId, lessonId });

    const res = await request(app).get("/api/progress/enrollments").set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].courseId).toBe(courseId);
    expect(res.body.data[0].completedLessonIds).toEqual([lessonId]);
  });
});

describe("project progress", () => {
  it("starts a project as in_progress", async () => {
    await request(app).post("/api/progress/project/ai-chat-assistant/start").set(auth());
    const res = await request(app).get("/api/progress/projects").set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].status).toBe("in_progress");
  });

  it("submitting marks the project completed and awards project_builder", async () => {
    await request(app)
      .post("/api/progress/project/ai-chat-assistant/submit")
      .set(auth())
      .send({ method: "github", value: "https://github.com/example/repo" });

    const list = await request(app).get("/api/progress/projects").set(auth());
    expect(list.body.data[0].status).toBe("completed");
    expect(list.body.data[0].submissions).toHaveLength(1);

    const stats = await request(app).get("/api/user/stats").set(auth());
    expect(stats.body.data.projectsCompleted).toBe(1);
    expect(
      stats.body.data.achievements.some((a: { key: string }) => a.key === "project_builder"),
    ).toBe(true);
  });

  it("rejects an invalid submission method", async () => {
    const res = await request(app)
      .post("/api/progress/project/ai-chat-assistant/submit")
      .set(auth())
      .send({ method: "carrier-pigeon", value: "x" });
    expect(res.status).toBe(400);
  });
});
