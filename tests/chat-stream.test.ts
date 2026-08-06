import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Mock the chat agent to produce NO output at all. This reproduces the case
// that previously crashed the save with "content is required".
vi.mock("../src/agents/chat-agent/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agents/chat-agent/index.js")>();
  return {
    ...actual,
    // eslint-disable-next-line require-yield
    streamChatAgent: async function* () {
      // intentionally yields nothing (empty reply)
    },
  };
});

const { app } = await import("../src/app.js");

function parseSse(text: string) {
  return text
    .split("\n\n")
    .map((block) => block.split("\n").find((l) => l.startsWith("data:")))
    .filter((l): l is string => Boolean(l))
    .map((l) => JSON.parse(l.slice(5).trim()));
}

let mongo: MongoMemoryServer;
let token: string;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());

  const res = await request(app).post("/api/auth/register").send({
    name: "Stream Tester",
    username: "streamtester",
    email: "stream@example.com",
    password: "supersecret123",
  });
  token = res.body.data.accessToken;
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

describe("chat stream", () => {
  it("saves a fallback reply when the agent produces no content", async () => {
    const res = await request(app)
      .post("/api/chat/stream")
      .set("Authorization", `Bearer ${token}`)
      .send({ message: "hello" });

    expect(res.status).toBe(200);

    const events = parseSse(res.text);
    expect(events.some((e) => e.type === "error")).toBe(false);

    const done = events.find((e) => e.type === "done");
    expect(done).toBeDefined();
    expect(done.conversationId).toBeTypeOf("string");

    // A non-empty fallback answer was streamed to the client.
    const content = events
      .filter((e) => e.type === "content")
      .map((e) => e.delta)
      .join("");
    expect(content.length).toBeGreaterThan(0);

    // And the conversation persisted without a validation crash.
    const history = await request(app)
      .get(`/api/chat/${done.conversationId}`)
      .set("Authorization", `Bearer ${token}`);
    expect(history.status).toBe(200);
    expect(history.body.data.messages).toHaveLength(2);
    expect(history.body.data.messages[1].role).toBe("assistant");
    expect(history.body.data.messages[1].content.length).toBeGreaterThan(0);
  });
});
