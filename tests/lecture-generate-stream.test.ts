import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// The pipeline is unit-tested in lecture-maker.test.ts; here the LLM boundary
// is mocked and the SSE endpoint/service wiring (job sharing, replay, errors)
// is exercised for real.
vi.mock("../src/agents/lecture-maker/index.js", () => ({
  makeLecture: vi.fn(),
}));

import {
  makeLecture,
  type LectureProgressEvent,
  type MadeLecture,
} from "../src/agents/lecture-maker/index.js";
import { app } from "../src/app.js";
import { CourseModel } from "../src/database/models/course.model.js";
import { LectureModel } from "../src/database/models/lecture.model.js";
import { ApiError } from "../src/utils/apiError.js";

const mockMake = vi.mocked(makeLecture);

let mongo: MongoMemoryServer;
let token: string;

const LESSON = "stream-course-c1m1t1";
const OTHER_LESSON = "stream-other-users-lesson";

const auth = () => ({ Authorization: `Bearer ${token}` });

function userIdFromToken(t: string): string {
  return JSON.parse(Buffer.from(t.split(".")[1]!, "base64url").toString()).sub as string;
}

function cannedLecture(): MadeLecture {
  return {
    title: "Loops in Python",
    language: "en",
    kind: "concept",
    outline: [{ id: 1, title: "Why loops", duration: "3:00" }],
    blocks: [{ id: "b1", type: "heading", topicId: 1, text: "Why loops" }],
  };
}

async function seedCourse(userId: string, title: string, lessonId: string) {
  await CourseModel.create({
    userId: new Types.ObjectId(userId),
    title,
    desc: "A course used by the stream tests.",
    level: "Beginner",
    chapters: [
      {
        title: "Foundations",
        modules: [{ title: "Control Flow", topics: [{ title: "Loops", lessonId }] }],
      },
    ],
  });
}

/** supertest buffers the whole SSE body once the response ends; unpack the events. */
function parseSse(text: string): { type: string; [k: string]: unknown }[] {
  return text
    .split("\n\n")
    .map((chunk) => chunk.split("\n").find((l) => l.startsWith("data:")))
    .filter((l): l is string => Boolean(l))
    .map((l) => JSON.parse(l.slice(5).trim()));
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());

  const reg = await request(app).post("/api/auth/register").send({
    name: "Stream User",
    username: "streamuser",
    email: "stream@example.com",
    password: "supersecret123",
  });
  token = reg.body.data.accessToken;
  await seedCourse(userIdFromToken(token), "Python Basics", LESSON);

  const other = await request(app).post("/api/auth/register").send({
    name: "Other Stream User",
    username: "otherstreamuser",
    email: "otherstream@example.com",
    password: "supersecret123",
  });
  await seedCourse(userIdFromToken(other.body.data.accessToken), "Other Course", OTHER_LESSON);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

beforeEach(async () => {
  mockMake.mockReset();
  await LectureModel.deleteMany({});
});

describe("POST /api/lectures/:lessonId/generate/stream", () => {
  it("requires auth", async () => {
    const res = await request(app).post(`/api/lectures/${LESSON}/generate/stream`);
    expect(res.status).toBe(401);
  });

  it("streams every pipeline stage in order, then a done event carrying the lecture", async () => {
    mockMake.mockImplementation(async (_ctx, _deps, onProgress) => {
      onProgress?.({ stage: "planning" });
      onProgress?.({ stage: "planned", topics: 1, easyBlocks: 1, svgBlocks: 0 });
      onProgress?.({ stage: "topic", status: "start", index: 0, total: 1, title: "Why loops" });
      onProgress?.({ stage: "topic", status: "done", index: 0, total: 1, title: "Why loops" });
      onProgress?.({ stage: "assembling" });
      return cannedLecture();
    });

    const res = await request(app).post(`/api/lectures/${LESSON}/generate/stream`).set(auth());
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");

    const events = parseSse(res.text);
    const progress = events.filter((e) => e.type === "progress").map((e) => (e.event as LectureProgressEvent).stage);
    expect(progress).toEqual(["planning", "planned", "topic", "topic", "assembling"]);

    const done = events.at(-1)!;
    expect(done).toMatchObject({ type: "done", cached: false });
    expect((done.lecture as { title: string }).title).toBe("Loops in Python");

    const doc = await LectureModel.findOne({ lessonId: LESSON }).lean();
    expect(doc).not.toBeNull();
  });

  it("404s when the lessonId is not in the user's courses (as an error event, not an HTTP status)", async () => {
    // SSE has already committed to a 200 by the time the failure is known.
    const res = await request(app).post(`/api/lectures/${OTHER_LESSON}/generate/stream`).set(auth());
    expect(res.status).toBe(200);
    const events = parseSse(res.text);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "error", message: "Lesson not found in your courses" });
    expect(mockMake).not.toHaveBeenCalled();
  });

  it("emits a single cached done event when the lecture already exists — no pipeline run", async () => {
    mockMake.mockResolvedValue(cannedLecture());
    await request(app).post(`/api/lectures/${LESSON}/generate`).set(auth()); // populate via the plain endpoint

    const res = await request(app).post(`/api/lectures/${LESSON}/generate/stream`).set(auth());
    const events = parseSse(res.text);
    expect(events).toEqual([expect.objectContaining({ type: "done", cached: true })]);
    expect(mockMake).toHaveBeenCalledTimes(1); // only the earlier plain-endpoint call
  });

  it("dedupes two concurrent streams into one pipeline run", async () => {
    mockMake.mockImplementation(async (_ctx, _deps, onProgress) => {
      onProgress?.({ stage: "planning" });
      await new Promise((r) => setTimeout(r, 40));
      onProgress?.({ stage: "assembling" });
      return cannedLecture();
    });

    const [a, b] = await Promise.all([
      request(app).post(`/api/lectures/${LESSON}/generate/stream`).set(auth()),
      request(app).post(`/api/lectures/${LESSON}/generate/stream`).set(auth()),
    ]);

    expect(mockMake).toHaveBeenCalledTimes(1);
    expect(await LectureModel.countDocuments({ lessonId: LESSON })).toBe(1);

    for (const res of [a, b]) {
      const events = parseSse(res.text);
      expect(events.at(-1)).toMatchObject({ type: "done", cached: false });
      expect((events.at(-1)!.lecture as { title: string }).title).toBe("Loops in Python");
    }
  });

  it("propagates a pipeline failure as an error event and persists nothing", async () => {
    mockMake.mockRejectedValue(new ApiError(502, "Lecture generation failed."));
    const res = await request(app).post(`/api/lectures/${LESSON}/generate/stream`).set(auth());
    const events = parseSse(res.text);
    expect(events.at(-1)).toMatchObject({ type: "error", message: "Lecture generation failed." });
    expect(await LectureModel.countDocuments()).toBe(0);
  });
});
