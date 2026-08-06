import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Proves each agent receives the slices it is supposed to receive — and, just as
 * importantly, not the ones it isn't.
 *
 * The renderers are unit-tested in student-memory-context.test.ts; this covers
 * the wiring between them and the three call sites, which is what silently
 * breaks when someone "simplifies" buildStudentContext back to one shape.
 */

const chatSeen: { learnerContext?: string }[] = [];

vi.mock("../src/agents/chat-agent/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agents/chat-agent/index.js")>();
  return {
    ...actual,
    streamChatAgent: async function* (
      _history: unknown,
      _message: string,
      options: { learnerContext?: string } = {},
    ) {
      chatSeen.push(options);
      yield { type: "content", delta: "ok" } as never;
    },
  };
});

vi.mock("../src/agents/profile-extractor/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agents/profile-extractor/index.js")>();
  return { ...actual, updateProfileFromChat: vi.fn().mockResolvedValue([]) };
});

vi.mock("../src/agents/memory-distiller/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agents/memory-distiller/index.js")>();
  return { ...actual, distillConversation: vi.fn().mockResolvedValue("") };
});

vi.mock("../src/agents/lecture-maker/index.js", () => ({ makeLecture: vi.fn() }));

const { app } = await import("../src/app.js");
const { makeLecture } = await import("../src/agents/lecture-maker/index.js");
const { CourseModel } = await import("../src/database/models/course.model.js");
const { EnrollmentModel } = await import("../src/database/models/enrollment.model.js");
const { KnowledgeAssessmentModel } = await import(
  "../src/database/models/knowledgeAssessment.model.js"
);
const { LearnerProfileModel } = await import("../src/database/models/learnerProfile.model.js");
const { StudentMemoryModel } = await import("../src/database/models/studentMemory.model.js");
const { upsertLearnerProfile } = await import("../src/services/learnerProfile.service.js");

const mockMakeLecture = vi.mocked(makeLecture);

let mongo: MongoMemoryServer;
let token: string;
let userId: string;

const LESSON = "mem-course-c1m1t1";

const IDENTITY_HEADER = "About this student";
const STATE_HEADER = "How this student is doing right now";
const MASTERY_HEADER = "has actually been measured on";
const NARRATIVE_HEADER = "Notes from this student's earlier sessions";

/** Gives this student something to say in all four slices. */
async function seedEverything() {
  await upsertLearnerProfile(userId, { occupation: "job", roleTitle: "Backend Engineer" }, "wizard");
  await EnrollmentModel.create({ userId, courseId: "c1", completedLessonIds: ["a", "b"] });
  await KnowledgeAssessmentModel.create({
    userId,
    topic: "JavaScript",
    objective: "Learn JavaScript",
    status: "completed",
    profile: { level: "Intermediate", knownConcepts: ["loops"], gapConcepts: ["recursion"] },
  });
  await StudentMemoryModel.create({ userId, narrative: "Keeps returning to interview prep." });
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());

  const res = await request(app).post("/api/auth/register").send({
    name: "Memory Tester",
    username: "memorytester",
    email: "memory@example.com",
    password: "supersecret123",
  });
  token = res.body.data.accessToken;
  userId = res.body.data.user.id ?? res.body.data.user._id;

  await CourseModel.create({
    userId: new Types.ObjectId(userId),
    title: "JavaScript from Zero",
    desc: "A course used by the memory injection tests.",
    level: "Beginner",
    chapters: [
      {
        title: "Foundations",
        modules: [{ title: "Control Flow", topics: [{ title: "Recursion", lessonId: LESSON }] }],
      },
    ],
  });
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

beforeEach(async () => {
  chatSeen.length = 0;
  mockMakeLecture.mockReset();
  mockMakeLecture.mockResolvedValue({
    title: "Recursion",
    language: "en",
    outline: [{ id: 1, title: "Why recursion", duration: "3:00" }],
    blocks: [{ id: "b1", type: "heading", topicId: 1, text: "Why recursion" }],
  } as unknown as Awaited<ReturnType<typeof makeLecture>>);
  await Promise.all([
    LearnerProfileModel.deleteMany({}),
    StudentMemoryModel.deleteMany({}),
    KnowledgeAssessmentModel.deleteMany({}),
    EnrollmentModel.deleteMany({}),
  ]);
});

describe("the chat agent", () => {
  it("gets nothing at all for a student with no record", async () => {
    await request(app)
      .post("/api/chat/stream")
      .set({ Authorization: `Bearer ${token}` })
      .send({ message: "hello" });
    expect(chatSeen[0]?.learnerContext).toBe("");
  });

  it("gets all four slices", async () => {
    await seedEverything();
    await request(app)
      .post("/api/chat/stream")
      .set({ Authorization: `Bearer ${token}` })
      .send({ message: "hello" });

    const context = chatSeen[0]?.learnerContext ?? "";
    expect(context).toContain(IDENTITY_HEADER);
    expect(context).toContain(STATE_HEADER);
    expect(context).toContain(MASTERY_HEADER);
    expect(context).toContain(NARRATIVE_HEADER);
    expect(context).toContain("Still getting wrong: recursion");
  });
});

describe("the lecture-maker", () => {
  const generate = () =>
    request(app)
      .post(`/api/lectures/${LESSON}/generate`)
      .set({ Authorization: `Bearer ${token}` })
      .send({});

  const learnerPassed = () =>
    (mockMakeLecture.mock.calls[0]?.[0] as { learner?: string } | undefined)?.learner ?? "";

  it("gets identity and mastery", async () => {
    await seedEverything();
    await generate();

    const learner = learnerPassed();
    expect(learner).toContain(IDENTITY_HEADER);
    expect(learner).toContain(MASTERY_HEADER);
    expect(learner).toContain("Still getting wrong: recursion");
  });

  it("gets neither the progress state nor the session notes", async () => {
    await seedEverything();
    await generate();

    const learner = learnerPassed();
    expect(learner).not.toContain(STATE_HEADER);
    expect(learner).not.toContain(NARRATIVE_HEADER);
    expect(learner).not.toContain("Keeps returning to interview prep.");
  });
});
