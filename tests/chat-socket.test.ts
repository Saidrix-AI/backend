import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import request from "supertest";
import WebSocket from "ws";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { app } from "../src/app.js";
import { attachChatSocket, CHAT_WS_PATH, WS_CLOSE } from "../src/realtime/socket.js";
import { resetTurns, setStreamFactory, type StreamFactory } from "../src/realtime/turnRegistry.js";
import type { ChatStreamEvent } from "../src/services/chat.service.js";

// End-to-end over a real WebSocket against a real http server. Only the agent
// itself is scripted — the socket, the turn registry and the auth handshake are
// the real ones.

let mongo: MongoMemoryServer;
let server: Server;
let url: string;
let token: string;

/** Emits events one at a time, waiting for `step()` between each. */
function steppedStream() {
  let resolveStep: (() => void) | null = null;
  const waitForStep = () =>
    new Promise<void>((resolve) => {
      resolveStep = resolve;
    });

  const factory: StreamFactory = async function* (_userId, _message, conversationId, options) {
    const events: ChatStreamEvent[] = [
      { type: "content", delta: "one " },
      { type: "content", delta: "two " },
      { type: "content", delta: "three" },
      { type: "done", conversationId: conversationId ?? "conv-new" },
    ];
    for (const event of events) {
      await waitForStep();
      if (options?.signal?.aborted) return;
      yield event;
    }
  };

  return {
    factory,
    /** Lets exactly one more event through. */
    step: async () => {
      // Give the generator a moment to park on waitForStep().
      for (let i = 0; i < 50 && !resolveStep; i++) await new Promise((r) => setTimeout(r, 2));
      const fn = resolveStep;
      resolveStep = null;
      fn?.();
      await new Promise((r) => setTimeout(r, 10));
    },
  };
}

interface Frame {
  type: string;
  turnId?: string;
  seq?: number;
  event?: ChatStreamEvent;
  status?: string;
  message?: string;
  conversationId?: string;
  watching?: boolean;
  prompt?: { message: string; attachments?: { name: string }[] };
}

/** A connected client that records every frame it receives. */
async function connect(authToken = token) {
  const ws = new WebSocket(`${url}${CHAT_WS_PATH}`);
  const frames: Frame[] = [];
  const closes: number[] = [];

  ws.on("message", (raw) => frames.push(JSON.parse(String(raw)) as Frame));
  ws.on("close", (code) => closes.push(code));
  await new Promise((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("error", reject);
  });

  const send = (payload: unknown) => ws.send(JSON.stringify(payload));
  /** Polls rather than sleeping a fixed amount — a loaded full-suite run is slower. */
  const waitForClose = async (timeoutMs = 2000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (closes.length > 0) return closes[0];
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error("socket did not close");
  };
  const waitFor = async (type: string, timeoutMs = 2000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = frames.find((f) => f.type === type);
      if (found) return found;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error(`timed out waiting for "${type}" (saw: ${frames.map((f) => f.type).join(", ")})`);
  };

  if (authToken) {
    send({ type: "auth", token: authToken });
    await waitFor("ready");
  }

  return {
    ws,
    frames,
    closes,
    send,
    waitFor,
    waitForClose,
    /** Content deltas in arrival order — what the user would have seen. */
    text: () =>
      frames
        .filter((f) => f.type === "event" && f.event?.type === "content")
        .map((f) => (f.event as { delta: string }).delta)
        .join(""),
    seqs: () => frames.filter((f) => f.type === "event").map((f) => f.seq),
    close: () => ws.close(),
  };
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());

  const reg = await request(app).post("/api/auth/register").send({
    name: "Socket User",
    username: "socketuser",
    email: "socket@example.com",
    password: "supersecret123",
  });
  token = reg.body.data.accessToken;

  server = createServer(app);
  attachChatSocket(server);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await mongoose.disconnect();
  await mongo.stop();
});

beforeEach(() => {
  resetTurns();
});

describe("chat socket handshake", () => {
  it("refuses a bad token and accepts a good one", async () => {
    const bad = await connect("");
    bad.send({ type: "auth", token: "not-a-jwt" });
    expect(await bad.waitForClose()).toBe(WS_CLOSE.authFailed);

    const good = await connect();
    expect(good.frames[0]).toMatchObject({ type: "ready" });
    good.close();
  });

  it("closes an unauthenticated socket that tries to send", async () => {
    const client = await connect("");
    client.send({ type: "send", message: "hello" });
    expect(await client.waitForClose()).toBe(WS_CLOSE.authFailed);
  });
});

describe("chat socket streaming", () => {
  it("streams a turn from start to finish", async () => {
    const scripted = steppedStream();
    setStreamFactory(scripted.factory);

    const client = await connect();
    client.send({ type: "send", clientMsgId: "c1", message: "hi" });
    const started = await client.waitFor("turn_started");
    expect(started.turnId).toBeTruthy();

    for (let i = 0; i < 4; i++) await scripted.step();
    await client.waitFor("turn_end");

    expect(client.text()).toBe("one two three");
    expect(client.seqs()).toEqual([0, 1, 2, 3]);
    expect(client.frames.at(-1)).toMatchObject({ type: "turn_end", status: "done" });
    client.close();
  });

  // The whole point of the socket: the turn belongs to the server, so losing the
  // connection loses nothing.
  it("resumes a turn on a new socket with no gap and no duplicate", async () => {
    const scripted = steppedStream();
    setStreamFactory(scripted.factory);

    const first = await connect();
    first.send({ type: "send", clientMsgId: "c1", message: "hi" });
    const started = await first.waitFor("turn_started");
    const turnId = started.turnId!;

    await scripted.step();
    await scripted.step();
    expect(first.text()).toBe("one two ");
    const lastSeq = Math.max(...(first.seqs() as number[]));
    first.close();
    await new Promise((r) => setTimeout(r, 20));

    // Generation carried on while nobody was listening.
    await scripted.step();

    const second = await connect();
    second.send({ type: "resume", turnId, fromSeq: lastSeq + 1 });
    await second.waitFor("turn_started");
    await scripted.step();
    await second.waitFor("turn_end");

    // Only the part the first socket missed, and no repeat of what it saw.
    expect(second.text()).toBe("three");
    expect(second.seqs()).toEqual([2, 3]);
    second.close();
  });

  it("lets a second socket watch a turn started elsewhere, from the beginning", async () => {
    const scripted = steppedStream();
    setStreamFactory(scripted.factory);

    const sender = await connect();
    sender.send({ type: "send", clientMsgId: "c1", message: "hi", conversationId: "conv-42" });
    await sender.waitFor("turn_started");
    await scripted.step();

    const watcher = await connect();
    watcher.send({ type: "watch", conversationId: "conv-42" });
    const watched = await watcher.waitFor("turn_started");
    expect(watched.watching).toBe(true);
    expect(watched.prompt).toMatchObject({ message: "hi" });

    await scripted.step();
    await scripted.step();
    await scripted.step();
    await watcher.waitFor("turn_end");

    // The watcher gets the whole answer, including what streamed before it joined.
    expect(watcher.text()).toBe("one two three");
    expect(sender.text()).toBe("one two three");
    sender.close();
    watcher.close();
  });

  // Found live: `watch` used to be a one-off lookup, so a tab that was already
  // open when another tab started a turn never heard about it.
  it("delivers a turn that starts AFTER the watch was registered", async () => {
    const scripted = steppedStream();
    setStreamFactory(scripted.factory);

    const watcher = await connect();
    watcher.send({ type: "watch", conversationId: "conv-later" });
    await watcher.waitFor("no_active_turn");

    const sender = await connect();
    sender.send({ type: "send", clientMsgId: "c1", message: "hi", conversationId: "conv-later" });
    await sender.waitFor("turn_started");

    const joined = await watcher.waitFor("turn_started");
    expect(joined.watching).toBe(true);
    // Neither message is saved until the turn ends, so the watching tab can only
    // learn the question from this frame — without it the answer renders alone.
    expect(joined.prompt).toMatchObject({ message: "hi" });

    for (let i = 0; i < 4; i++) await scripted.step();
    await watcher.waitFor("turn_end");
    expect(watcher.text()).toBe("one two three");

    sender.close();
    watcher.close();
  });

  it("stops delivering after unwatch", async () => {
    const scripted = steppedStream();
    setStreamFactory(scripted.factory);

    const watcher = await connect();
    watcher.send({ type: "watch", conversationId: "conv-off" });
    await watcher.waitFor("no_active_turn");
    watcher.send({ type: "unwatch", conversationId: "conv-off" });
    await new Promise((r) => setTimeout(r, 30));

    const sender = await connect();
    sender.send({ type: "send", clientMsgId: "c1", message: "hi", conversationId: "conv-off" });
    await sender.waitFor("turn_started");
    await scripted.step();
    await new Promise((r) => setTimeout(r, 50));

    expect(watcher.frames.some((f) => f.type === "event")).toBe(false);
    sender.close();
    watcher.close();
  });

  // A chat started in another window is only saved when its turn ends, so the
  // other session's sidebar needs a nudge or the conversation never appears.
  it("tells other sessions to refetch their chat list when a turn ends", async () => {
    const scripted = steppedStream();
    setStreamFactory(scripted.factory);

    const other = await connect(); // an idle session, watching nothing
    const sender = await connect();
    sender.send({ type: "send", clientMsgId: "c1", message: "hi" });
    await sender.waitFor("turn_started");
    for (let i = 0; i < 4; i++) await scripted.step();
    await sender.waitFor("turn_end");

    const nudge = await other.waitFor("conversations_changed");
    expect(nudge.conversationId).toBe("conv-new");
    // The session that ran the turn refreshes itself; it must not be nudged twice.
    expect(sender.frames.some((f) => f.type === "conversations_changed")).toBe(false);

    sender.close();
    other.close();
  });

  it("reports no active turn for a quiet conversation", async () => {
    const client = await connect();
    client.send({ type: "watch", conversationId: "conv-quiet" });
    const frame = await client.waitFor("no_active_turn");
    expect(frame.conversationId).toBe("conv-quiet");
    client.close();
  });

  it("cancel stops generation for every subscriber", async () => {
    const scripted = steppedStream();
    setStreamFactory(scripted.factory);

    const client = await connect();
    client.send({ type: "send", clientMsgId: "c1", message: "hi" });
    const started = await client.waitFor("turn_started");

    await scripted.step();
    client.send({ type: "cancel", turnId: started.turnId });
    // Let the cancel frame reach the server before the generator is allowed to
    // continue — otherwise the race decides whether one more event slips out.
    await new Promise((r) => setTimeout(r, 50));
    await scripted.step();
    await client.waitFor("turn_end");

    expect(client.text()).toBe("one ");
    client.close();
  });

  it("answers an unknown turn with an error instead of closing the socket", async () => {
    const client = await connect();
    client.send({ type: "resume", turnId: "nope", fromSeq: 0 });
    const err = await client.waitFor("error");
    expect(err.message).toMatch(/not found/i);
    expect(client.ws.readyState).toBe(WebSocket.OPEN);
    client.close();
  });
});
