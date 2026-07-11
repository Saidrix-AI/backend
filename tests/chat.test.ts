import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../src/agents/graph.js", () => ({
  tutorGraph: {
    invoke: vi.fn(async (input: { messages: unknown[] }) => ({
      messages: [...input.messages, new AIMessage("Mocked tutor reply")],
    })),
  },
}));

const { app } = await import("../src/app.js");

let mongo: MongoMemoryServer;
let token: string;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());

  const res = await request(app).post("/api/auth/register").send({
    name: "Chat Tester",
    email: "chat@example.com",
    password: "supersecret123",
  });
  token = res.body.data.token;
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

describe("chat", () => {
  it("rejects unauthenticated requests", async () => {
    const res = await request(app).post("/api/chat").send({ message: "hi" });
    expect(res.status).toBe(401);
  });

  it("creates a conversation and returns the agent reply", async () => {
    const res = await request(app)
      .post("/api/chat")
      .set("Authorization", `Bearer ${token}`)
      .send({ message: "Explain photosynthesis" });

    expect(res.status).toBe(200);
    expect(res.body.data.reply).toBe("Mocked tutor reply");
    expect(res.body.data.conversationId).toBeTypeOf("string");
  });

  it("continues an existing conversation and persists history", async () => {
    const first = await request(app)
      .post("/api/chat")
      .set("Authorization", `Bearer ${token}`)
      .send({ message: "First question" });
    const conversationId = first.body.data.conversationId;

    const second = await request(app)
      .post("/api/chat")
      .set("Authorization", `Bearer ${token}`)
      .send({ message: "Follow-up question", conversationId });
    expect(second.status).toBe(200);
    expect(second.body.data.conversationId).toBe(conversationId);

    const history = await request(app)
      .get(`/api/chat/${conversationId}`)
      .set("Authorization", `Bearer ${token}`);
    expect(history.status).toBe(200);
    expect(history.body.data.messages).toHaveLength(4);
    expect(history.body.data.messages[0].role).toBe("user");
    expect(history.body.data.messages[1].role).toBe("assistant");
  });

  it("404s for another user's conversation id", async () => {
    const other = await request(app).post("/api/auth/register").send({
      name: "Other",
      email: "other@example.com",
      password: "supersecret123",
    });
    const otherToken = other.body.data.token;

    const created = await request(app)
      .post("/api/chat")
      .set("Authorization", `Bearer ${token}`)
      .send({ message: "Private chat" });

    const res = await request(app)
      .get(`/api/chat/${created.body.data.conversationId}`)
      .set("Authorization", `Bearer ${otherToken}`);
    expect(res.status).toBe(404);
  });
});
