import { afterEach, describe, expect, it } from "vitest";
import * as chatService from "../src/services/chat.service.js";
import {
  cancelTurn,
  findTurnByConversation,
  getTurn,
  MAX_ACTIVE_TURNS_PER_USER,
  resetTurns,
  setStreamFactory,
  startTurn,
  subscribe,
  type StreamFactory,
} from "../src/realtime/turnRegistry.js";
import type { ChatStreamEvent } from "../src/services/chat.service.js";

// The registry is what makes a chat turn survive its connection: it buffers
// every event so a reconnect can replay the tail and a second tab can replay
// the whole thing. These tests drive it with a scripted generator instead of a
// real LLM.

const userA = "user-a";
const userB = "user-b";

/** A generator that emits the given events, pausing until `release()` is called. */
function scriptedStream(events: ChatStreamEvent[], opts: { holdAfter?: number } = {}) {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const factory: StreamFactory = async function* (_userId, _message, _conversationId, options) {
    for (const [i, event] of events.entries()) {
      if (opts.holdAfter !== undefined && i === opts.holdAfter) await gate;
      if (options?.signal?.aborted) return;
      yield event;
    }
  };
  return { factory, release: () => release() };
}

const collect = () => {
  const seen: { seq: number; event: ChatStreamEvent }[] = [];
  const ended: string[] = [];
  return {
    seen,
    ended,
    listener: {
      onEvent: (event: ChatStreamEvent, seq: number) => seen.push({ seq, event }),
      onEnd: (status: string) => ended.push(status),
    },
  };
};

const tick = () => new Promise((r) => setTimeout(r, 5));

const events: ChatStreamEvent[] = [
  { type: "content", delta: "Hel" },
  { type: "content", delta: "lo" },
  { type: "done", conversationId: "conv-1" },
];

afterEach(() => {
  resetTurns();
  setStreamFactory(chatService.streamMessage);
});

describe("turn registry", () => {
  it("buffers every event and replays it to a late subscriber", async () => {
    setStreamFactory(scriptedStream(events).factory);
    const turnId = startTurn(userA, { message: "hi" });
    await tick();

    const late = collect();
    subscribe(userA, turnId, 0, late.listener);

    expect(late.seen.map((s) => s.seq)).toEqual([0, 1, 2]);
    expect(late.seen[0]!.event).toMatchObject({ type: "content", delta: "Hel" });
    // A finished turn ends the new subscriber immediately rather than hanging.
    expect(late.ended).toEqual(["done"]);
    expect(getTurn(userA, turnId).status).toBe("done");
  });

  it("resumes from a sequence with no gap and no duplicate", async () => {
    const scripted = scriptedStream(events, { holdAfter: 2 });
    setStreamFactory(scripted.factory);
    const turnId = startTurn(userA, { message: "hi" });
    await tick();

    // First connection saw seq 0 and 1, then "dropped".
    const first = collect();
    const stop = subscribe(userA, turnId, 0, first.listener);
    expect(first.seen.map((s) => s.seq)).toEqual([0, 1]);
    stop();

    // Reconnect asks for everything after the last seq it rendered.
    const second = collect();
    subscribe(userA, turnId, 2, second.listener);
    scripted.release();
    await tick();

    expect(second.seen.map((s) => s.seq)).toEqual([2]);
    expect(second.seen[0]!.event).toMatchObject({ type: "done" });
    expect(second.ended).toEqual(["done"]);
  });

  it("fans one turn out to several subscribers", async () => {
    const scripted = scriptedStream(events, { holdAfter: 1 });
    setStreamFactory(scripted.factory);
    const turnId = startTurn(userA, { message: "hi" });
    await tick();

    const tab1 = collect();
    const tab2 = collect();
    subscribe(userA, turnId, 0, tab1.listener);
    subscribe(userA, turnId, 0, tab2.listener);
    scripted.release();
    await tick();

    expect(tab1.seen.map((s) => s.seq)).toEqual([0, 1, 2]);
    expect(tab2.seen.map((s) => s.seq)).toEqual([0, 1, 2]);
  });

  it("finds a running turn by conversation and forgets it once finished", async () => {
    const scripted = scriptedStream(events, { holdAfter: 1 });
    setStreamFactory(scripted.factory);
    const turnId = startTurn(userA, { message: "hi", conversationId: "conv-1" });
    await tick();

    expect(findTurnByConversation(userA, "conv-1")).toBe(turnId);
    // Another student never sees it.
    expect(findTurnByConversation(userB, "conv-1")).toBeNull();

    scripted.release();
    await tick();
    expect(findTurnByConversation(userA, "conv-1")).toBeNull();
  });

  it("hides another user's turn from reads, resume and cancel", async () => {
    const scripted = scriptedStream(events, { holdAfter: 1 });
    setStreamFactory(scripted.factory);
    const turnId = startTurn(userA, { message: "hi" });
    await tick();

    expect(() => getTurn(userB, turnId)).toThrowError(/not found/i);
    expect(() => subscribe(userB, turnId, 0, collect().listener)).toThrowError(/not found/i);
    expect(() => cancelTurn(userB, turnId)).toThrowError(/not found/i);
    scripted.release();
  });

  it("cancel stops the generator and ends the turn", async () => {
    const scripted = scriptedStream(events, { holdAfter: 1 });
    setStreamFactory(scripted.factory);
    const turnId = startTurn(userA, { message: "hi" });
    await tick();

    const sub = collect();
    subscribe(userA, turnId, 0, sub.listener);
    cancelTurn(userA, turnId);
    scripted.release();
    await tick();

    // The event after the cancel never arrives, and the turn is closed.
    expect(sub.seen.map((s) => s.event.type)).toEqual(["content"]);
    expect(getTurn(userA, turnId).status).toBe("done");
    // Cancelling twice is harmless.
    expect(() => cancelTurn(userA, turnId)).not.toThrow();
  });

  it("caps how many turns one user may run at once", async () => {
    const scripted = scriptedStream(events, { holdAfter: 1 });
    setStreamFactory(scripted.factory);
    for (let i = 0; i < MAX_ACTIVE_TURNS_PER_USER; i++) startTurn(userA, { message: `m${i}` });
    await tick();

    expect(() => startTurn(userA, { message: "one too many" })).toThrowError(/too many/i);
    // The cap is per user, not global.
    expect(() => startTurn(userB, { message: "fine" })).not.toThrow();
    scripted.release();
  });

  it("surfaces a generator failure as an error event, not a crash", async () => {
    setStreamFactory((async function* () {
      yield { type: "content", delta: "partial" } as ChatStreamEvent;
      throw new Error("upstream exploded");
    }) as unknown as StreamFactory);

    const turnId = startTurn(userA, { message: "hi" });
    await tick();

    const sub = collect();
    subscribe(userA, turnId, 0, sub.listener);
    expect(sub.seen.at(-1)!.event).toMatchObject({ type: "error", message: "upstream exploded" });
    expect(getTurn(userA, turnId).status).toBe("error");
  });

  it("keeps streaming to the remaining subscribers when one throws", async () => {
    const scripted = scriptedStream(events, { holdAfter: 1 });
    setStreamFactory(scripted.factory);
    const turnId = startTurn(userA, { message: "hi" });
    await tick();

    const good = collect();
    subscribe(userA, turnId, 0, { onEvent: () => { throw new Error("dead socket"); } });
    subscribe(userA, turnId, 0, good.listener);
    scripted.release();
    await tick();

    expect(good.seen.map((s) => s.seq)).toEqual([0, 1, 2]);
  });
});
