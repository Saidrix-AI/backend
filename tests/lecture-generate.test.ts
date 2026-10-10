import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// The pipeline is unit-tested in lecture-maker.test.ts; here the LLM boundary
// is mocked and the endpoint/service wiring is exercised for real.
vi.mock("../src/agents/lecture-maker/index.js", () => ({
  makeLecture: vi.fn(),
}));

import { makeLecture, type MadeLecture } from "../src/agents/lecture-maker/index.js";
import { app } from "../src/app.js";
import { CourseModel } from "../src/database/models/course.model.js";
import { LectureModel } from "../src/database/models/lecture.model.js";
import { ApiError } from "../src/utils/apiError.js";

const mockMake = vi.mocked(makeLecture);

let mongo: MongoMemoryServer;
let token: string;

const LESSON = "gen-course-c1m1t1";
const OTHER_LESSON = "other-users-lesson";

const auth = () => ({ Authorization: `Bearer ${token}` });

function userIdFromToken(t: string): string {
  return JSON.parse(Buffer.from(t.split(".")[1]!, "base64url").toString()).sub as string;
}

function cannedLecture(): MadeLecture {
  return {
    title: "Loops in Python",
    language: "en",
    kind: "concept",
    outline: [
      { id: 1, title: "Why loops", duration: "3:00" },
      { id: 2, title: "for loops", duration: "4:30" },
    ],
    sections: [
      { id: "s1", topicId: 1, title: "Why loops", kind: "theory", blocks: [{ id: "b1", type: "paragraph", text: "Why loops" }] },
      { id: "s2", topicId: 2, title: "for loops", kind: "theory", blocks: [{ id: "b2", type: "paragraph", text: "Loops repeat work for you." }] },
    ],
  };
}

async function seedCourse(userId: string, title: string, lessonId: string) {
  await CourseModel.create({
    userId: new Types.ObjectId(userId),
    title,
    desc: "A course used by the generate tests.",
    level: "Beginner",
    chapters: [
      {
        title: "Foundations",
        modules: [
          {
            title: "Control Flow",
            topics: [
              { title: "Loops", lessonId },
              { title: "Conditionals", lessonId: `${lessonId}-sibling` },
            ],
          },
        ],
      },
    ],
  });
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());

  const reg = await request(app).post("/api/auth/register").send({
    name: "Gen User",
    username: "genuser",
    email: "gen@example.com",
    password: "supersecret123",
  });
  token = reg.body.data.accessToken;
  await seedCourse(userIdFromToken(token), "Python Basics", LESSON);

  const other = await request(app).post("/api/auth/register").send({
    name: "Other User",
    username: "otheruser",
    email: "other@example.com",
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

describe("POST /api/lectures/:lessonId/generate", () => {
  it("requires auth", async () => {
    const res = await request(app).post(`/api/lectures/${LESSON}/generate`);
    expect(res.status).toBe(401);
  });

  it("404s when the lessonId is not in the user's courses", async () => {
    const res = await request(app).post(`/api/lectures/${OTHER_LESSON}/generate`).set(auth());
    expect(res.status).toBe(404);
    expect(mockMake).not.toHaveBeenCalled();
  });

  it("201 generates, persists and returns the lecture json shape", async () => {
    mockMake.mockResolvedValue(cannedLecture());
    const res = await request(app).post(`/api/lectures/${LESSON}/generate`).set(auth());
    expect(res.status).toBe(201);
    expect(res.body.data.id).toBe(LESSON);
    expect(res.body.data.title).toBe("Loops in Python");
    expect(res.body.data.blocks).toHaveLength(2);
    expect(res.body.data.course).toEqual({
      title: "Python Basics",
      breadcrumb: ["Python Basics", "Foundations", "Control Flow"],
    });

    const ctx = mockMake.mock.calls[0]![0];
    expect(ctx.topicTitle).toBe("Loops");
    expect(ctx.siblingTopics).toEqual(["Conditionals"]);

    const doc = await LectureModel.findOne({ lessonId: LESSON }).lean();
    expect(doc).not.toBeNull();
    expect(doc!.version).toBe(3);
    expect(doc!.language).toBe("en");
  });

  // The planner's scope statement comes from the curriculum. `brief` is the
  // field the Course-maker writes today; `summary` is what pre-brief courses
  // have, and it must still be used rather than dropped on the floor.
  it("passes the topic brief to the lecture maker, falling back to summary then nothing", async () => {
    const uid = userIdFromToken(token);
    await CourseModel.create({
      userId: new Types.ObjectId(uid),
      title: "Fallback Course",
      level: "Beginner",
      chapters: [
        {
          title: "Ch",
          modules: [
            {
              title: "M",
              topics: [
                { title: "Both", lessonId: "fb-both", summary: "the summary", brief: "the brief" },
                { title: "Summary only", lessonId: "fb-summary", summary: "the summary", brief: "" },
                { title: "Neither", lessonId: "fb-neither", summary: "", brief: "" },
              ],
            },
          ],
        },
      ],
    });

    const briefFor = async (lessonId: string) => {
      mockMake.mockReset();
      mockMake.mockResolvedValue(cannedLecture());
      const res = await request(app).post(`/api/lectures/${lessonId}/generate`).set(auth());
      expect(res.status).toBe(201);
      return mockMake.mock.calls[0]![0].topicBrief;
    };

    expect(await briefFor("fb-both")).toBe("the brief");
    expect(await briefFor("fb-summary")).toBe("the summary");
    expect(await briefFor("fb-neither")).toBeUndefined();
  });

  it("200s on the second call without re-generating", async () => {
    mockMake.mockResolvedValue(cannedLecture());
    await request(app).post(`/api/lectures/${LESSON}/generate`).set(auth());
    const second = await request(app).post(`/api/lectures/${LESSON}/generate`).set(auth());
    expect(second.status).toBe(200);
    expect(second.body.data.title).toBe("Loops in Python");
    expect(mockMake).toHaveBeenCalledTimes(1);
  });

  it("GET /api/lectures/:lessonId returns the generated doc", async () => {
    mockMake.mockResolvedValue(cannedLecture());
    await request(app).post(`/api/lectures/${LESSON}/generate`).set(auth());
    const res = await request(app).get(`/api/lectures/${LESSON}`).set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data.title).toBe("Loops in Python");
    expect(res.body.data.blocks).toHaveLength(2);
  });

  it("dedupes concurrent generates into one pipeline run", async () => {
    mockMake.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 50));
      return cannedLecture();
    });
    const [a, b] = await Promise.all([
      request(app).post(`/api/lectures/${LESSON}/generate`).set(auth()),
      request(app).post(`/api/lectures/${LESSON}/generate`).set(auth()),
    ]);
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(mockMake).toHaveBeenCalledTimes(1);
    expect(await LectureModel.countDocuments({ lessonId: LESSON })).toBe(1);
  });

  it("persists nothing when the pipeline fails", async () => {
    mockMake.mockRejectedValue(new ApiError(502, "Lecture generation failed."));
    const res = await request(app).post(`/api/lectures/${LESSON}/generate`).set(auth());
    expect(res.status).toBe(502);
    expect(await LectureModel.countDocuments()).toBe(0);
  });
});
