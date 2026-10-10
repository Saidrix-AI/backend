import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { app } from "../src/app.js";

/**
 * The durable "where was I" checkpoint behind resuming a lecture.
 *
 * The voice agent keeps the same value in Redis, but that key expires in two
 * hours — ending a class and coming back later found nothing and restarted the
 * lesson from block 0. These endpoints are the floor underneath it, so they
 * have to be per-user, upserting, and honest about a finished lecture.
 */
let mongo: MongoMemoryServer;
let token: string;
let otherToken: string;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  const register = (name: string, username: string, email: string) =>
    request(app)
      .post("/api/auth/register")
      .send({ name, username, email, password: "supersecret123" });

  token = (await register("Position Tester", "positiontester", "position@example.com")).body.data
    .accessToken;
  otherToken = (await register("Other Student", "otherstudent", "other@example.com")).body.data
    .accessToken;
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

const auth = (t = token) => ({ Authorization: `Bearer ${t}` });

describe("lecture position checkpoint", () => {
  it("starts at block 0 when the student has never opened the lecture", async () => {
    const res = await request(app).get("/api/lectures/lesson-a/position").set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ blockIndex: 0, mode: "lecture" });
  });

  it("round-trips the position the agent saved", async () => {
    const save = await request(app)
      .put("/api/lectures/lesson-a/position")
      .set(auth())
      .send({ blockIndex: 7, mode: "paused", courseId: "python-for-ai" });
    expect(save.status).toBe(200);

    const res = await request(app).get("/api/lectures/lesson-a/position").set(auth());
    // A v1 lecture has no concepts to be in the middle of, so the beat fields
    // come back empty rather than absent — the agent reads them unconditionally.
    expect(res.body.data).toEqual({
      blockIndex: 7,
      mode: "paused",
      beatId: "",
      beatPhase: "",
      knownBeats: [],
      partlyBeats: [],
    });
  });

  /**
   * `blockIndex` alone cannot resume a conversation: coming back to the block
   * the tutor happened to be showing loses whether that concept had been
   * probed, explained or checked, so the student is asked "do you already know
   * this?" about something they were halfway through understanding.
   */
  it("round-trips which concept was being taught, and how far into it", async () => {
    await request(app)
      .put("/api/lectures/lesson-a/position")
      .set(auth())
      .send({
        blockIndex: 4,
        mode: "awaiting",
        beatId: "t2b1",
        beatPhase: "topic_check",
        knownBeats: ["t2b2"],
        partlyBeats: ["t2b3"],
      });

    const res = await request(app).get("/api/lectures/lesson-a/position").set(auth());
    // The topic's opening-question result rides along: resuming mid-topic must
    // not re-teach a concept the student already said they had.
    expect(res.body.data).toEqual({
      blockIndex: 4,
      mode: "awaiting",
      beatId: "t2b1",
      beatPhase: "topic_check",
      knownBeats: ["t2b2"],
      partlyBeats: ["t2b3"],
    });
  });

  /**
   * Written unconditionally, empty string included. Treating "" as "leave it
   * alone" would resume a concept the student has already moved off — the one
   * case where a stale checkpoint is worse than none.
   */
  it("clears the beat when the agent sends an empty one", async () => {
    await request(app)
      .put("/api/lectures/lesson-a/position")
      .set(auth())
      .send({ blockIndex: 5, mode: "lecture", beatId: "t3b2", beatPhase: "teach", knownBeats: ["t3b1"] });
    await request(app)
      .put("/api/lectures/lesson-a/position")
      .set(auth())
      .send({ blockIndex: 6, mode: "lecture", beatId: "", beatPhase: "", knownBeats: [], partlyBeats: [] });

    const res = await request(app).get("/api/lectures/lesson-a/position").set(auth());
    expect(res.body.data).toEqual({
      blockIndex: 6,
      mode: "lecture",
      beatId: "",
      beatPhase: "",
      knownBeats: [],
      partlyBeats: [],
    });
  });

  it("upserts rather than duplicating as narration moves", async () => {
    await request(app)
      .put("/api/lectures/lesson-a/position")
      .set(auth())
      .send({ blockIndex: 9, mode: "lecture" });

    const res = await request(app).get("/api/lectures/lesson-a/position").set(auth());
    expect(res.body.data).toMatchObject({ blockIndex: 9, mode: "lecture" });
  });

  it("records a finished lecture as done, so it reopens fresh", async () => {
    await request(app)
      .put("/api/lectures/lesson-a/position")
      .set(auth())
      .send({ blockIndex: 12, mode: "done" });

    const res = await request(app).get("/api/lectures/lesson-a/position").set(auth());
    expect(res.body.data.mode).toBe("done");
  });

  it("keeps each student's position to themselves", async () => {
    const res = await request(app).get("/api/lectures/lesson-a/position").set(auth(otherToken));
    expect(res.body.data).toEqual({ blockIndex: 0, mode: "lecture" });
  });

  it("rejects a negative or non-integer block index", async () => {
    const negative = await request(app)
      .put("/api/lectures/lesson-a/position")
      .set(auth())
      .send({ blockIndex: -1 });
    expect(negative.status).toBe(400);

    const fractional = await request(app)
      .put("/api/lectures/lesson-a/position")
      .set(auth())
      .send({ blockIndex: 2.5 });
    expect(fractional.status).toBe(400);
  });

  it("requires authentication", async () => {
    const res = await request(app).get("/api/lectures/lesson-a/position");
    expect(res.status).toBe(401);
  });
});
