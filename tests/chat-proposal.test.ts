import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Mock the chat agent as an inspectable vi.fn so we can (a) script a turn that
// emits a course_proposal and (b) assert the proposal is re-injected into the
// history the next turn receives.
const { streamMock } = vi.hoisted(() => ({ streamMock: vi.fn() }));

vi.mock("../src/agents/chat-agent/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agents/chat-agent/index.js")>();
  return { ...actual, streamChatAgent: streamMock };
});

const { app } = await import("../src/app.js");

const proposedCourses = [
  {
    title: "Python Foundations",
    objective: "Python from zero for data work",
    level: "Beginner",
    note: "Start here — foundation for the rest",
  },
  { title: "Data Analysis with Pandas", objective: "Analyze real datasets with pandas" },
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
    name: "Proposal Tester",
    username: "proposaltester",
    email: "proposal@example.com",
    password: "supersecret123",
  });
  token = res.body.data.accessToken;
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

describe("chat stream course proposals", () => {
  it("streams the course_proposal event, persists it, and re-injects it into the next turn's history", async () => {
    streamMock.mockImplementationOnce(async function* () {
      yield {
        type: "tool_call",
        id: "0-0",
        name: "propose_courses",
        label: "Preparing course suggestions",
        query: "",
      };
      yield { type: "course_proposal", id: "0-0", courses: proposedCourses };
      yield {
        type: "tool_result",
        id: "0-0",
        name: "propose_courses",
        ok: true,
        label: "Proposed 2 courses",
      };
      yield { type: "content", delta: "Pick the ones you want to start with." };
    });

    const res = await request(app)
      .post("/api/chat/stream")
      .set("Authorization", `Bearer ${token}`)
      .send({ message: "ami data scientist hote chai" });

    expect(res.status).toBe(200);
    const events = parseSse(res.text);

    const proposalEvent = events.find((e) => e.type === "course_proposal");
    expect(proposalEvent).toBeDefined();
    expect(proposalEvent.courses).toHaveLength(2);
    expect(proposalEvent.courses[0]).toMatchObject({
      title: "Python Foundations",
      level: "Beginner",
    });

    const done = events.find((e) => e.type === "done");
    expect(done).toBeDefined();

    const history = await request(app)
      .get(`/api/chat/${done.conversationId}`)
      .set("Authorization", `Bearer ${token}`);
    expect(history.status).toBe(200);

    const assistantMsg = history.body.data.messages[1];
    expect(assistantMsg.role).toBe("assistant");
    expect(assistantMsg.proposal).toHaveLength(2);
    expect(assistantMsg.proposal[0]).toMatchObject({
      title: "Python Foundations",
      objective: "Python from zero for data work",
      level: "Beginner",
      note: "Start here — foundation for the rest",
    });
    expect(assistantMsg.proposal[1]).toMatchObject({ title: "Data Analysis with Pandas" });
    expect(assistantMsg.actions).toHaveLength(1);
    expect(assistantMsg.actions[0]).toMatchObject({ name: "propose_courses", ok: true });

    // Turn 2: the selection message — the mocked agent just answers, but the
    // history it receives must carry the proposal as text (tool messages are
    // not replayed), so the model could resolve titles into objectives.
    streamMock.mockImplementationOnce(async function* () {
      yield { type: "content", delta: "Building them now." };
    });

    const res2 = await request(app)
      .post("/api/chat/stream")
      .set("Authorization", `Bearer ${token}`)
      .send({
        message: 'Create these courses: "Python Foundations"',
        conversationId: done.conversationId,
      });
    expect(res2.status).toBe(200);

    const secondHistory = streamMock.mock.calls[1]![0] as { role: string; content: string }[];
    const lastAssistant = [...secondHistory].reverse().find((m) => m.role === "assistant");
    expect(lastAssistant?.content).toContain("[Courses you proposed as selectable cards:");
    expect(lastAssistant?.content).toContain('1. "Python Foundations" — Python from zero for data work (Beginner)');
    expect(lastAssistant?.content).toContain('2. "Data Analysis with Pandas"');
  });
});
