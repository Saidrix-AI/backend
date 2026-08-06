import { randomUUID } from "node:crypto";
import * as chatService from "../services/chat.service.js";
import type { ChatStreamEvent } from "../services/chat.service.js";
import type { InputAttachment } from "../agents/chat-agent/index.js";
import { ApiError } from "../utils/apiError.js";
import { logger } from "../utils/logger.js";

/**
 * Chat turns owned by the server rather than by whichever connection asked for
 * them. Streaming used to be the HTTP response consuming the generator, so a
 * closed tab killed the turn and a second tab could not see it at all. Here a
 * turn keeps running, buffers every event it produced, and lets any number of
 * subscribers join at any offset.
 *
 * That one buffer gives all three behaviours: reconnect = subscribe from the
 * last seq you saw; a second tab = subscribe from 0; cancel = an explicit call
 * instead of a dropped socket.
 *
 * Scope: one process. Several backend instances would need the buffer in Redis
 * (a reconnect could land elsewhere) — the API here is deliberately narrow
 * enough to put behind that later.
 */

/** How long a finished turn stays replayable, so a slow reconnect still gets its tail. */
export const TURN_TTL_MS = 5 * 60_000;
/** Nothing may generate forever — a detached turn has no client to abandon it. */
export const MAX_TURN_MS = 5 * 60_000;
/** Per user, to stop a loop of tabs from opening unbounded LLM calls. */
export const MAX_ACTIVE_TURNS_PER_USER = 3;

export interface TurnInput {
  message: string;
  conversationId?: string;
  webSearch?: boolean;
  attachments?: InputAttachment[];
}

export type TurnStatus = "running" | "done" | "error";

/** Called with each event and its 0-based sequence number. */
export type TurnListener = (event: ChatStreamEvent, seq: number) => void;
/** Called once when the turn stops producing events. */
export type TurnEndListener = (status: TurnStatus) => void;

interface Subscriber {
  onEvent: TurnListener;
  onEnd?: TurnEndListener;
}

/**
 * The student's own message, carried on the turn because it is not persisted
 * until the turn finishes — a tab that joins mid-answer would otherwise render
 * a reply with no question above it.
 */
export interface TurnPrompt {
  message: string;
  /** Names only, not the base64 payload — the real thumbnails load with the saved message. */
  attachments?: { name: string; mimeType: string; kind: "image" | "text" }[];
}

interface ActiveTurn {
  turnId: string;
  userId: string;
  conversationId?: string;
  prompt: TurnPrompt;
  events: ChatStreamEvent[];
  status: TurnStatus;
  abort: AbortController;
  subscribers: Set<Subscriber>;
  startedAt: number;
  endedAt?: number;
  timeout?: NodeJS.Timeout;
}

const turns = new Map<string, ActiveTurn>();

export interface StartedTurn {
  turnId: string;
  userId: string;
  conversationId?: string;
  prompt: TurnPrompt;
}

/** Notified whenever a turn starts, so a socket already watching a conversation can join it. */
const startListeners = new Set<(turn: StartedTurn) => void>();

export interface EndedTurn {
  turnId: string;
  userId: string;
  conversationId?: string;
  status: TurnStatus;
}

/**
 * Notified when a turn finishes. The conversation is only written to the
 * database at that point, so this is when the student's OTHER sessions can be
 * told their chat list changed — a new chat started on one device would
 * otherwise not appear on another until it was reloaded by hand.
 */
const endListeners = new Set<(turn: EndedTurn) => void>();

export function onTurnEnd(listener: (turn: EndedTurn) => void): () => void {
  endListeners.add(listener);
  return () => endListeners.delete(listener);
}

/**
 * Watching has to be a standing subscription, not a one-off lookup: a tab that
 * is already open when another tab starts a turn would otherwise never hear
 * about it (there was nothing running at the moment it asked).
 */
export function onTurnStart(listener: (turn: StartedTurn) => void): () => void {
  startListeners.add(listener);
  return () => startListeners.delete(listener);
}

/** Test seam: the generator the registry drives. */
export type StreamFactory = typeof chatService.streamMessage;
let streamFactory: StreamFactory = chatService.streamMessage;
export function setStreamFactory(factory: StreamFactory): void {
  streamFactory = factory;
}

function sweep(): void {
  const cutoff = Date.now() - TURN_TTL_MS;
  for (const [id, turn] of turns) {
    if (turn.status !== "running" && (turn.endedAt ?? 0) < cutoff) turns.delete(id);
  }
}

function activeCount(userId: string): number {
  let n = 0;
  for (const turn of turns.values()) {
    if (turn.userId === userId && turn.status === "running") n++;
  }
  return n;
}

/** A turn the caller owns, or an ApiError. Unknown and foreign ids are both 404. */
function ownedTurn(userId: string, turnId: string): ActiveTurn {
  const turn = turns.get(turnId);
  if (!turn || turn.userId !== userId) throw new ApiError(404, "Turn not found");
  return turn;
}

function emit(turn: ActiveTurn, event: ChatStreamEvent): void {
  const seq = turn.events.length;
  turn.events.push(event);
  // A subscriber that throws (a dead socket, say) must not stop the turn or
  // starve the other subscribers.
  for (const sub of turn.subscribers) {
    try {
      sub.onEvent(event, seq);
    } catch (err) {
      logger.warn({ err, turnId: turn.turnId }, "chat turn subscriber failed");
    }
  }
}

function finish(turn: ActiveTurn, status: TurnStatus): void {
  if (turn.status !== "running") return;
  turn.status = status;
  turn.endedAt = Date.now();
  if (turn.timeout) clearTimeout(turn.timeout);
  for (const sub of turn.subscribers) {
    try {
      sub.onEnd?.(status);
    } catch (err) {
      logger.warn({ err, turnId: turn.turnId }, "chat turn end listener failed");
    }
  }
  turn.subscribers.clear();

  const ended: EndedTurn = {
    turnId: turn.turnId,
    userId: turn.userId,
    conversationId: turn.conversationId,
    status,
  };
  for (const listener of endListeners) {
    try {
      listener(ended);
    } catch (err) {
      logger.warn({ err, turnId: turn.turnId }, "chat turn end broadcast failed");
    }
  }

  sweep();
}

/**
 * Starts a turn and returns its id immediately — the generator runs detached,
 * so the caller subscribes rather than awaits.
 */
export function startTurn(userId: string, input: TurnInput): string {
  sweep();
  if (activeCount(userId) >= MAX_ACTIVE_TURNS_PER_USER) {
    throw new ApiError(429, "Too many chats are generating at once. Wait for one to finish.");
  }

  const turn: ActiveTurn = {
    turnId: randomUUID(),
    userId,
    conversationId: input.conversationId,
    prompt: {
      message: input.message,
      ...(input.attachments?.length
        ? {
            attachments: input.attachments.map((a) => ({
              name: a.name,
              mimeType: a.mimeType,
              kind: a.kind,
            })),
          }
        : {}),
    },
    events: [],
    status: "running",
    abort: new AbortController(),
    subscribers: new Set(),
    startedAt: Date.now(),
  };
  turn.timeout = setTimeout(() => turn.abort.abort(), MAX_TURN_MS);
  turn.timeout.unref?.();
  turns.set(turn.turnId, turn);

  const started: StartedTurn = {
    turnId: turn.turnId,
    userId: turn.userId,
    conversationId: turn.conversationId,
    prompt: turn.prompt,
  };
  for (const listener of startListeners) {
    try {
      listener(started);
    } catch (err) {
      logger.warn({ err, turnId: turn.turnId }, "chat turn start listener failed");
    }
  }

  void run(turn, input);
  return turn.turnId;
}

async function run(turn: ActiveTurn, input: TurnInput): Promise<void> {
  try {
    for await (const event of streamFactory(turn.userId, input.message, input.conversationId, {
      webSearch: input.webSearch,
      attachments: input.attachments,
      signal: turn.abort.signal,
    })) {
      // `done` carries the id a brand-new conversation was saved under — later
      // subscribers (another tab) need it to know which conversation this is.
      if (event.type === "done") turn.conversationId = event.conversationId;
      emit(turn, event);
    }
    finish(turn, "done");
  } catch (err) {
    if (turn.abort.signal.aborted) {
      finish(turn, "done");
      return;
    }
    logger.error({ err, turnId: turn.turnId }, "chat turn failed");
    emit(turn, {
      type: "error",
      message: err instanceof Error ? err.message : "Stream failed",
    });
    finish(turn, "error");
  }
}

export interface TurnSnapshot {
  turnId: string;
  conversationId?: string;
  status: TurnStatus;
  prompt: TurnPrompt;
  /** Events already produced — the count doubles as the next seq. */
  eventCount: number;
}

export function getTurn(userId: string, turnId: string): TurnSnapshot {
  const turn = ownedTurn(userId, turnId);
  return {
    turnId: turn.turnId,
    conversationId: turn.conversationId,
    status: turn.status,
    prompt: turn.prompt,
    eventCount: turn.events.length,
  };
}

/** The running turn for a conversation, if any — how a second tab finds one to watch. */
export function findTurnByConversation(userId: string, conversationId: string): string | null {
  for (const turn of turns.values()) {
    if (turn.userId === userId && turn.status === "running" && turn.conversationId === conversationId) {
      return turn.turnId;
    }
  }
  return null;
}

/**
 * Replays everything from `fromSeq` and then streams live. A reconnect passes
 * the seq after the last one it saw (so nothing repeats and nothing is skipped);
 * a fresh tab passes 0 to get the whole turn from the start.
 *
 * Returns an unsubscribe function. If the turn has already finished, the replay
 * still happens and `onEnd` fires synchronously after it.
 */
export function subscribe(
  userId: string,
  turnId: string,
  fromSeq: number,
  listener: Subscriber,
): () => void {
  const turn = ownedTurn(userId, turnId);
  const start = Math.max(0, Math.min(fromSeq, turn.events.length));

  // A listener that throws mid-replay (a socket that just died, say) is dropped
  // rather than allowed to fail the caller — same rule as emit() applies to live
  // events, and a half-replayed subscriber is not worth keeping.
  for (let seq = start; seq < turn.events.length; seq++) {
    try {
      listener.onEvent(turn.events[seq]!, seq);
    } catch (err) {
      logger.warn({ err, turnId }, "chat turn replay failed");
      return () => {};
    }
  }

  if (turn.status !== "running") {
    listener.onEnd?.(turn.status);
    return () => {};
  }

  turn.subscribers.add(listener);
  return () => turn.subscribers.delete(listener);
}

/** Explicit stop — aborts the LLM call. Idempotent. */
export function cancelTurn(userId: string, turnId: string): void {
  const turn = ownedTurn(userId, turnId);
  if (turn.status === "running") turn.abort.abort();
}

/** Test helper: drop all state between cases. */
export function resetTurns(): void {
  for (const turn of turns.values()) {
    if (turn.timeout) clearTimeout(turn.timeout);
  }
  turns.clear();
  startListeners.clear();
  endListeners.clear();
}
