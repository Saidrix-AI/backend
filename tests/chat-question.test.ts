import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Mock the chat agent as an inspectable vi.fn so we can (a) script a turn that
// emits ask_questions and (b) assert the questions are re-injected into the
// history the next turn receives.
const { streamMock } = vi.hoisted(() => ({ streamMock: vi.fn() }));

vi.mock("../src/agents/chat-agent/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agents/chat-agent/index.js")>();
  return { ...actual, streamChatAgent: streamMock };
});

const { app } = await import("../src/app.js");

const questions = [
  { question: "Have you programmed before?", header: "Experience", options: ["Never", "A little", "A lot"] },
  { question: "What's your goal?", header: "Goal", options: ["Career switch", "Curiosity"] },
];

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
    name: "Question Tester",
    username: "questiontester",
    email: "question@example.com",
    password: "supersecret123",
  });
  token = res.body.data.accessToken;
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

describe("chat stream ask_questions", () => {
  it("streams the ask_questions event, persists it, and re-injects it into the next turn's history", async () => {
    streamMock.mockImplementationOnce(async function* () {
      yield {
        type: "tool_call",
        id: "0-0",
        name: "ask_questions",
        label: "Preparing questions",
        query: "",
      };
      yield { type: "ask_questions", id: "0-0", questions };
      yield {
        type: "tool_result",
        id: "0-0",
        name: "ask_questions",
        ok: true,
        label: "Asked 2 questions",
      };
      yield { type: "content", delta: "Pick an answer for each question." };
    });

    const res = await request(app)
      .post("/api/chat/stream")
      .set("Authorization", `Bearer ${token}`)
      .send({ message: "ami data scientist hote chai" });

    expect(res.status).toBe(200);
    const events = parseSse(res.text);

    const questionEvent = events.find((e) => e.type === "ask_questions");
    expect(questionEvent).toBeDefined();
    expect(questionEvent.questions).toHaveLength(2);
    expect(questionEvent.questions[0]).toMatchObject({ header: "Experience" });

    const done = events.find((e) => e.type === "done");
    expect(done).toBeDefined();

    const history = await request(app)
      .get(`/api/chat/${done.conversationId}`)
      .set("Authorization", `Bearer ${token}`);
    expect(history.status).toBe(200);

    const assistantMsg = history.body.data.messages[1];
    expect(assistantMsg.role).toBe("assistant");
    expect(assistantMsg.questions).toHaveLength(2);
    expect(assistantMsg.questions[0]).toMatchObject({
      question: "Have you programmed before?",
      header: "Experience",
      options: ["Never", "A little", "A lot"],
    });
    expect(assistantMsg.actions).toHaveLength(1);
    expect(assistantMsg.actions[0]).toMatchObject({ name: "ask_questions", ok: true });

    // Turn 2: the compiled answers — the mocked agent just answers, but the
    // history it receives must carry the questions as text (tool messages are
    // not replayed) so the model can tell what it asked.
    streamMock.mockImplementationOnce(async function* () {
      yield { type: "content", delta: "Got it, building your plan now." };
    });

    const res2 = await request(app)
      .post("/api/chat/stream")
      .set("Authorization", `Bearer ${token}`)
      .send({
        message: "Experience: A little\nGoal: Career switch",
        conversationId: done.conversationId,
      });
    expect(res2.status).toBe(200);

    const secondHistory = streamMock.mock.calls[1]![0] as { role: string; content: string }[];
    const lastAssistant = [...secondHistory].reverse().find((m) => m.role === "assistant");
    expect(lastAssistant?.content).toContain("[Questions you asked as interactive cards:");
    expect(lastAssistant?.content).toContain("1. [Experience] Have you programmed before?");
    expect(lastAssistant?.content).toContain("2. [Goal] What's your goal?");
  });
});
