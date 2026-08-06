import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Mock the chat agent to simulate a turn where a db tool ran, so we can assert
// the tool_result event reaches the client and the action is persisted.
vi.mock("../src/agents/chat-agent/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agents/chat-agent/index.js")>();
  return {
    ...actual,
    streamChatAgent: async function* () {
      yield {
        type: "tool_call",
        id: "0-0",
        name: "create_course",
        label: 'Creating course "React Basics"',
        query: "",
      };
      yield {
        type: "tool_result",
        id: "0-0",
        name: "create_course",
        ok: true,
        label: 'Course "React Basics" created',
        changed: "course",
      };
      yield { type: "content", delta: "Done! I created the React Basics course for you." };
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
    name: "Action Tester",
    username: "actiontester",
    email: "actions@example.com",
    password: "supersecret123",
  });
  token = res.body.data.accessToken;
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

describe("chat stream tool actions", () => {
  it("streams tool_result events and persists actions on the assistant message", async () => {
    const res = await request(app)
      .post("/api/chat/stream")
      .set("Authorization", `Bearer ${token}`)
      .send({ message: "amar ekta React course banao" });

    expect(res.status).toBe(200);
    const events = parseSse(res.text);

    const toolResult = events.find((e) => e.type === "tool_result");
    expect(toolResult).toMatchObject({
      name: "create_course",
      ok: true,
      label: 'Course "React Basics" created',
      changed: "course",
    });

    const done = events.find((e) => e.type === "done");
    expect(done).toBeDefined();

    const history = await request(app)
      .get(`/api/chat/${done.conversationId}`)
      .set("Authorization", `Bearer ${token}`);
    expect(history.status).toBe(200);

    const [userMsg, assistantMsg] = history.body.data.messages;
    expect(userMsg.actions).toBeUndefined();
    expect(assistantMsg.role).toBe("assistant");
    expect(assistantMsg.actions).toHaveLength(1);
    expect(assistantMsg.actions[0]).toMatchObject({
      name: "create_course",
      ok: true,
      label: 'Course "React Basics" created',
      changed: "course",
    });
  });
});
