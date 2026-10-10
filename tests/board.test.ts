import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { app } from "../src/app.js";
import { createCourse } from "../src/services/course.service.js";
import { signVoiceAgentToken } from "../src/services/token.service.js";

/**
 * The board snapshot store. The voice agent owns a class's board and is the
 * only writer; the student's browser only reads it back (on load and after a
 * reconnect). These pin who may write, whose board a reader gets, and that a
 * late write can never roll the board back.
 */

let mongo: MongoMemoryServer;
let userToken: string;
let otherToken: string;
let agentToken: string;
let lessonId: string;

const asUser = () => ({ Authorization: `Bearer ${userToken}` });
const asOther = () => ({ Authorization: `Bearer ${otherToken}` });
const asAgent = () => ({ Authorization: `Bearer ${agentToken}` });
const el = (id: string) => ({ id, kind: "shape", x: 0, y: 0, w: 100, h: 60, label: id });
const url = () => `/api/lectures/${lessonId}/board`;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  const register = (name: string, username: string, email: string) =>
    request(app).post("/api/auth/register").send({ name, username, email, password: "supersecret123" });
  const reg = await register("Board Student", "boardstudent", "board-student@example.com");
  userToken = reg.body.data.accessToken;
  agentToken = signVoiceAgentToken(reg.body.data.user.id);
  otherToken = (await register("Other Student", "boardother", "board-other@example.com")).body.data.accessToken;
  const course = await createCourse(reg.body.data.user.id, {
    title: "Web Basics",
    chapters: [{ title: "Ch", modules: [{ title: "M", topics: [{ title: "T", lessonId: "ignored" }] }] }],
  });
  lessonId = course.chapters![0]!.modules[0]!.topics[0]!.lessonId;
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

describe("board store", () => {
  it("reads an untouched board as empty", async () => {
    const res = await request(app).get(url()).set(asUser());
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ rev: 0, elements: [] });
  });

  it("round-trips what the agent wrote to the student's browser", async () => {
    const saved = await request(app).put(url()).set(asAgent()).send({ rev: 3, elements: [el("a"), el("b")] });
    expect(saved.status).toBe(200);
    expect(saved.body.data).toEqual({ rev: 3 });
    const read = await request(app).get(url()).set(asUser());
    expect(read.body.data.rev).toBe(3);
    expect(read.body.data.elements.map((e: { id: string }) => e.id)).toEqual(["a", "b"]);
    expect(read.body.data.elements[0].label).toBe("a"); // unknown element fields survive validation
  });

  it("lets only the agent write", async () => {
    const res = await request(app).put(url()).set(asUser()).send({ rev: 9, elements: [] });
    expect(res.status).toBe(403);
  });

  it("refuses a stale write and accepts the same rev again", async () => {
    const stale = await request(app).put(url()).set(asAgent()).send({ rev: 2, elements: [] });
    expect(stale.status).toBe(409);
    const same = await request(app).put(url()).set(asAgent()).send({ rev: 3, elements: [el("a")] });
    expect(same.status).toBe(200);
  });

  it("does not show another student's board, and does not admit it exists", async () => {
    const res = await request(app).get(url()).set(asOther());
    expect(res.status).toBe(404);
  });

  it("rejects malformed and oversized boards", async () => {
    const bad = await request(app).put(url()).set(asAgent()).send({ rev: 4, elements: [{ kind: "shape" }] });
    expect(bad.status).toBe(400);
    const many = Array.from({ length: 2001 }, (_, i) => el(`e${i}`));
    const tooMany = await request(app).put(url()).set(asAgent()).send({ rev: 5, elements: many });
    expect(tooMany.status).toBe(400);
  });
});
