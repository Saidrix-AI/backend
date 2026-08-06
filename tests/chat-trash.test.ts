import { AIMessage } from "@langchain/core/messages";
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
    name: "Trash Tester",
    username: "trashtester",
    email: "trash@example.com",
    password: "supersecret123",
  });
  token = res.body.data.accessToken;
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

describe("chat trash", () => {
  it("moves a conversation to trash, hides it from the main list, and lists it in trash", async () => {
    const created = await request(app)
      .post("/api/chat")
      .set("Authorization", `Bearer ${token}`)
      .send({ message: "To be trashed" });
    const conversationId = created.body.data.conversationId;

    const del = await request(app)
      .delete(`/api/chat/${conversationId}`)
      .set("Authorization", `Bearer ${token}`);
    expect(del.status).toBe(200);

    const list = await request(app)
      .get("/api/chat")
      .set("Authorization", `Bearer ${token}`);
    expect(list.body.data.some((c: { _id: string }) => c._id === conversationId)).toBe(false);

    const trash = await request(app)
      .get("/api/chat/trash")
      .set("Authorization", `Bearer ${token}`);
    expect(trash.body.data.some((c: { _id: string }) => c._id === conversationId)).toBe(true);
  });

  it("restores a trashed conversation back to the main list", async () => {
    const created = await request(app)
      .post("/api/chat")
      .set("Authorization", `Bearer ${token}`)
      .send({ message: "To be restored" });
    const conversationId = created.body.data.conversationId;

    await request(app)
      .delete(`/api/chat/${conversationId}`)
      .set("Authorization", `Bearer ${token}`);

    const restore = await request(app)
      .post(`/api/chat/${conversationId}/restore`)
      .set("Authorization", `Bearer ${token}`);
    expect(restore.status).toBe(200);

    const list = await request(app)
      .get("/api/chat")
      .set("Authorization", `Bearer ${token}`);
    expect(list.body.data.some((c: { _id: string }) => c._id === conversationId)).toBe(true);
  });

  it("permanently deletes a conversation", async () => {
    const created = await request(app)
      .post("/api/chat")
      .set("Authorization", `Bearer ${token}`)
      .send({ message: "To be permanently deleted" });
    const conversationId = created.body.data.conversationId;

    const del = await request(app)
      .delete(`/api/chat/${conversationId}/permanent`)
      .set("Authorization", `Bearer ${token}`);
    expect(del.status).toBe(200);

    const fetch = await request(app)
      .get(`/api/chat/${conversationId}`)
      .set("Authorization", `Bearer ${token}`);
    expect(fetch.status).toBe(404);
  });
});
