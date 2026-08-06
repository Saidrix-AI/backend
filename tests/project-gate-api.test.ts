import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { app } from "../src/app.js";
import { ProjectModel } from "../src/database/models/project.model.js";

let mongo: MongoMemoryServer;
let token: string;
let courseId: string;
let starterId: string;
let capstoneId: string;
/** Chapter 1's two lesson ids, as assigned by the server. */
let lessonA: string;
let lessonB: string;

const auth = () => ({ Authorization: `Bearer ${token}` });

function userIdFromToken(t: string): string {
  return JSON.parse(Buffer.from(t.split(".")[1]!, "base64url").toString()).sub as string;
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());

  const reg = await request(app).post("/api/auth/register").send({
    name: "Gate User",
    username: "gateuser",
    email: "gate@example.com",
    password: "supersecret123",
  });
  token = reg.body.data.accessToken;

  const course = await request(app).post("/api/courses").set(auth()).send({
    title: "Gated Course",
    chapters: [
      { title: "Foundations", modules: [{ title: "M", topics: [{ title: "A", lessonId: "g1a" }, { title: "B", lessonId: "g1b" }] }] },
      { title: "Functions", modules: [{ title: "M", topics: [{ title: "C", lessonId: "g2a" }] }] },
    ],
  });
  courseId = course.body.data._id;
  // Lesson ids are assigned server-side, so read back what chapter 1 actually got.
  [lessonA, lessonB] = course.body.data.chapters[0].modules[0].topics.map(
    (t: { lessonId: string }) => t.lessonId,
  );

  // Created directly: the HTTP create contract has no difficulty/chapterIndex.
  const starter = await ProjectModel.create({
    userId: new mongoose.Types.ObjectId(userIdFromToken(token)),
    courseId,
    title: "Chapter 1 Practice",
    chapterIndex: 0,
    difficulty: "starter",
    goal: "g",
    requirements: ["r"],
  });
  starterId = String(starter._id);

  const capstone = await ProjectModel.create({
    userId: starter.userId,
    courseId,
    title: "Final Build",
    chapterIndex: 0,
    difficulty: "capstone",
    goal: "g",
    requirements: ["r"],
  });
  capstoneId = String(capstone._id);
});


afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

const detailProjects = async () => {
  const res = await request(app).get(`/api/courses/${courseId}/detail`).set(auth());
  return res.body.data.projects as Array<{ _id: string; locked: boolean; lockReason: string }>;
};

describe("project gating", () => {
  it("locks a chapter project until that chapter is finished", async () => {
    const before = (await detailProjects()).find((p) => p._id === starterId)!;
    expect(before.locked).toBe(true);
    expect(before.lockReason).toBe("Finish Chapter 1 · Foundations to unlock this project");

    await request(app).post("/api/progress/enroll").set(auth()).send({ courseId });
    await request(app).post("/api/progress/complete-lesson").set(auth()).send({ courseId, lessonId: lessonA });

    // One lesson short — still locked.
    expect((await detailProjects()).find((p) => p._id === starterId)!.locked).toBe(true);

    await request(app).post("/api/progress/complete-lesson").set(auth()).send({ courseId, lessonId: lessonB });
    expect((await detailProjects()).find((p) => p._id === starterId)!.locked).toBe(false);
  });

  it("keeps the capstone locked until the whole course is done", async () => {
    const capstone = (await detailProjects()).find((p) => p._id === capstoneId)!;
    expect(capstone.locked).toBe(true); // chapter 1 done, chapter 2 is not
    expect(capstone.lockReason).toMatch(/Finish the course/);
  });

  it("refuses a submission to a locked project, and allows it once unlocked", async () => {
    const blocked = await request(app)
      .post(`/api/progress/project/${capstoneId}/submit`)
      .set(auth())
      .send({ method: "github", value: "https://github.com/x/y" });
    expect(blocked.status).toBe(403);
    expect(blocked.body.message).toMatch(/Finish the course/);

    const allowed = await request(app)
      .post(`/api/progress/project/${starterId}/submit`)
      .set(auth())
      .send({ method: "github", value: "https://github.com/x/y" });
    expect(allowed.status).toBe(200);
  });

  it("does not mark a locked project as started", async () => {
    await request(app).post(`/api/progress/project/${capstoneId}/start`).set(auth());
    const rows = await request(app).get("/api/progress/projects").set(auth());
    const row = rows.body.data.find((r: { projectId: string }) => r.projectId === capstoneId);
    expect(row).toBeUndefined();
  });

  it("reports the lock on the list and detail endpoints too", async () => {
    const list = await request(app).get("/api/projects").set(auth());
    const capstone = list.body.data.find((p: { _id: string }) => p._id === capstoneId);
    expect(capstone.locked).toBe(true);

    const detail = await request(app).get(`/api/projects/${capstoneId}`).set(auth());
    expect(detail.body.data.locked).toBe(true);
    expect(detail.body.data.lockReason).toMatch(/Finish the course/);
  });
});
