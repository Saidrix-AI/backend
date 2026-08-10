import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * The curriculum search must not be persisted as a message action.
 *
 * Sibling of chat-actions.test.ts, which pins the opposite case (a real write
 * IS kept). Separate file because the agent mock is module-level, so one file
 * can only simulate one kind of turn.
 */
vi.mock("../src/agents/chat-agent/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agents/chat-agent/index.js")>();
  return {
    ...actual,
    streamChatAgent: async function* () {
      yield {
        type: "tool_call",
        id: "0-0",
        name: "search_course_content",
        label: "Searching the curriculum",
        query: "authentication",
      };
      yield {
        type: "tool_result",
        id: "0-0",
        name: "search_course_content",
        ok: true,
        label: "Curriculum search complete",
      };
      yield { type: "content", delta: "Authentication means verifying who a user is." };
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
    name: "Hidden Tester",
    username: "hiddentester",
    email: "hidden@example.com",
    password: "supersecret123",
  });
  token = res.body.data.accessToken;
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

describe("hidden tool actions", () => {
  it("does not persist a curriculum search as an action", async () => {
    const res = await request(app)
      .post("/api/chat/stream")
      .set("Authorization", `Bearer ${token}`)
      .send({ message: "explain authentication" });

    expect(res.status).toBe(200);
    const events = parseSse(res.text);
    const done = events.find((e) => e.type === "done");
    expect(done).toBeDefined();

    const history = await request(app)
      .get(`/api/chat/${done.conversationId}`)
      .set("Authorization", `Bearer ${token}`);
    expect(history.status).toBe(200);

    const assistantMsg = history.body.data.messages.find(
      (m: { role: string }) => m.role === "assistant",
    );
    // The answer is kept; the plumbing that produced it is not.
    expect(assistantMsg.content).toContain("Authentication means");
    expect(assistantMsg.actions).toBeUndefined();
  });
});
