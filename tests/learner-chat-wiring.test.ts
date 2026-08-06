import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Proves the learner block actually travels the real chat path — chat.service
 * resolves it, streamChatAgent receives it, and the passive extractor is invoked
 * with the student's own messages after the turn is saved.
 *
 * The three prompt builders are unit-tested in learner-injection.test.ts; this
 * covers the wiring between them, which is what silently breaks.
 */

const seen: { learnerContext?: string }[] = [];

vi.mock("../src/agents/chat-agent/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agents/chat-agent/index.js")>();
  return {
    ...actual,
    streamChatAgent: async function* (
      _history: unknown,
      _message: string,
      options: { learnerContext?: string } = {},
    ) {
      seen.push(options);
      yield { type: "content", delta: "ok" } as never;
    },
  };
});

vi.mock("../src/agents/profile-extractor/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agents/profile-extractor/index.js")>();
  return { ...actual, updateProfileFromChat: vi.fn().mockResolvedValue([]) };
});

const { app } = await import("../src/app.js");
const { updateProfileFromChat } = await import("../src/agents/profile-extractor/index.js");
const { upsertLearnerProfile } = await import("../src/services/learnerProfile.service.js");
const { LearnerProfileModel } = await import(
  "../src/database/models/learnerProfile.model.js"
);

const mockExtract = vi.mocked(updateProfileFromChat);

let mongo: MongoMemoryServer;
let token: string;
let userId: string;

const send = (message: string, conversationId?: string) =>
  request(app)
    .post("/api/chat/stream")
    .set({ Authorization: `Bearer ${token}` })
    .send({ message, ...(conversationId ? { conversationId } : {}) });

/** The conversationId the stream reports, so a follow-up lands in the same thread. */
function conversationIdOf(res: { text: string }): string {
  for (const block of res.text.split("\n\n")) {
    const line = block.split("\n").find((l) => l.startsWith("data:"));
    if (!line) continue;
    const event = JSON.parse(line.slice(5).trim());
    if (event.conversationId) return event.conversationId as string;
  }
  throw new Error("no conversationId on the stream");
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  const res = await request(app).post("/api/auth/register").send({
    name: "Wiring Tester",
    username: "wiringtester",
    email: "wiring@example.com",
    password: "supersecret123",
  });
  token = res.body.data.accessToken;
  userId = res.body.data.user.id ?? res.body.data.user._id;
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

beforeEach(async () => {
  seen.length = 0;
  mockExtract.mockClear();
  await LearnerProfileModel.deleteMany({});
});

describe("learner context reaches the chat agent", () => {
  it("passes an empty string when the student has no profile", async () => {
    await send("hello");
    expect(seen[0]?.learnerContext).toBe("");
  });

  it("passes the rendered block once a profile exists", async () => {
    await upsertLearnerProfile(
      userId,
      { occupation: "job", roleTitle: "Backend Engineer", industry: "Fintech" },
      "wizard",
    );
    await send("hello");
    const context = seen[0]?.learnerContext ?? "";
    expect(context).toContain("About this student");
    expect(context).toContain("Work: Backend Engineer, in Fintech");
  });

  it("re-reads the profile each turn, so a mid-session edit takes effect", async () => {
    await send("first");
    expect(seen[0]?.learnerContext).toBe("");

    await upsertLearnerProfile(userId, { occupation: "student" }, "wizard");
    await send("second");
    expect(seen[1]?.learnerContext).toContain("Currently: a student");
  });
});

describe("the extractor runs after the turn is saved", () => {
  it("is called with the student's own message", async () => {
    await send("ami CSE 3rd year");
    expect(mockExtract).toHaveBeenCalledTimes(1);
    const [calledUserId, messages] = mockExtract.mock.calls[0]!;
    expect(calledUserId).toBe(userId);
    expect(messages).toContain("ami CSE 3rd year");
  });

  it("passes the whole conversation's user messages, never the assistant's", async () => {
    const first = await send("first");
    await send("second", conversationIdOf(first));

    const messages = mockExtract.mock.calls.at(-1)![1];
    expect(messages).toEqual(["first", "second"]);
    // "ok" is what the mocked agent replies with — it must never be read back
    // as something the student said about themselves.
    expect(messages).not.toContain("ok");
  });
});
