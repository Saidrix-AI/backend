import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import type { InputAttachment } from "../agents/chat-agent/index.js";
import { corsOrigins, isBillingEnabled } from "../config/env.js";
import { UserModel } from "../database/models/user.model.js";
import { appOpenFor } from "../services/subscription.service.js";
import { verifyAccessToken } from "../services/token.service.js";
import { ApiError } from "../utils/apiError.js";
import { logger } from "../utils/logger.js";
import {
  cancelTurn,
  findTurnByConversation,
  getTurn,
  onTurnEnd,
  onTurnStart,
  startTurn,
  subscribe,
  type TurnStatus,
} from "./turnRegistry.js";

/**
 * The chat WebSocket. It is a transport only — every turn lives in
 * ./turnRegistry.ts, so a dropped socket loses nothing and a second socket can
 * watch the same turn. The SSE route stays as the fallback for networks that
 * block WebSockets.
 *
 * Auth is a first-message handshake rather than a header or a query parameter:
 * browsers cannot set headers on a WebSocket, and a token in the URL ends up in
 * proxy and server logs.
 */

export const CHAT_WS_PATH = "/ws/chat";
/** Close the socket if the client never authenticates. */
const AUTH_TIMEOUT_MS = 5_000;
/** Ping interval — also stops idle proxies from dropping a quiet socket. */
const HEARTBEAT_MS = 30_000;
/** Attachments are capped at 4MB each client-side; leave room but not 100MB (the ws default). */
const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;

/** Application close codes (4000+ is the private range). */
export const WS_CLOSE = {
  authTimeout: 4401,
  authFailed: 4403,
  badMessage: 4400,
  /** Signed in, but no subscription is paying for this. Mirrors HTTP 402. */
  paymentRequired: 4402,
} as const;

interface ClientMessage {
  type?: string;
  token?: string;
  clientMsgId?: string;
  turnId?: string;
  fromSeq?: number;
  conversationId?: string;
  message?: string;
  webSearch?: boolean;
  attachments?: unknown;
}

interface SocketState {
  userId?: string;
  isAlive: boolean;
  authTimer?: NodeJS.Timeout;
  /** turnId → unsubscribe, so one socket can follow several turns and clean up on close. */
  subscriptions: Map<string, () => void>;
  /**
   * Every turn this socket ever followed. `subscriptions` is emptied as each
   * turn ends — before the end broadcast runs — so it cannot answer "was this
   * mine?" at the moment that matters.
   */
  attachedTurns: Set<string>;
  /** Conversations this socket wants every future turn of (the other-tab case). */
  watched: Set<string>;
  /** Removes this socket's turn-start listener on close. */
  stopWatching?: () => void;
  /** Removes this socket's turn-end (chat list) listener on close. */
  stopListChanges?: () => void;
}

const states = new WeakMap<WebSocket, SocketState>();

function send(ws: WebSocket, payload: unknown): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
}

function fail(ws: WebSocket, message: string, turnId?: string): void {
  send(ws, { type: "error", message, ...(turnId ? { turnId } : {}) });
}

/** Streams a turn to this socket from `fromSeq`, replacing any earlier subscription to it. */
function attach(ws: WebSocket, state: SocketState, turnId: string, fromSeq: number): void {
  state.attachedTurns.add(turnId);
  state.subscriptions.get(turnId)?.();
  const stop = subscribe(state.userId!, turnId, fromSeq, {
    onEvent: (event, seq) => send(ws, { type: "event", turnId, seq, event }),
    onEnd: (status: TurnStatus) => {
      state.subscriptions.delete(turnId);
      send(ws, { type: "turn_end", turnId, status });
    },
  });
  state.subscriptions.set(turnId, stop);
}

/**
 * The handshake, and the paywall for this transport.
 *
 * A valid token is not enough: this socket runs the same chat agent the HTTP
 * routes do, so without this check a lapsed account could keep using it simply
 * by not going through `/api/chat`. The plan is read once, at connect — a
 * subscription that lapses mid-conversation is caught on the next connection
 * rather than mid-sentence, which is the right trade for a live socket.
 */
async function authenticate(ws: WebSocket, state: SocketState, msg: ClientMessage): Promise<void> {
  let userId: string;
  try {
    userId = verifyAccessToken(String(msg.token ?? "")).sub;
  } catch {
    send(ws, { type: "error", message: "Invalid or expired token" });
    ws.close(WS_CLOSE.authFailed, "auth failed");
    return;
  }

  if (isBillingEnabled()) {
    const user = await UserModel.findById(userId).select("planStatus planExpiresAt").lean();
    if (!user || !appOpenFor(user)) {
      send(ws, { type: "error", message: "Your subscription has ended. Renew it to keep chatting." });
      ws.close(WS_CLOSE.paymentRequired, "subscription required");
      return;
    }
  }

  // Set last: until this is assigned, every other message type is refused.
  state.userId = userId;
  clearTimeout(state.authTimer);
  send(ws, { type: "ready" });
}

function handleMessage(ws: WebSocket, state: SocketState, msg: ClientMessage): void {
  if (msg.type === "auth") {
    if (state.userId) return; // already authenticated — ignore
    void authenticate(ws, state, msg).catch((err: unknown) => {
      logger.error({ err }, "[ws] auth check failed");
      ws.close(WS_CLOSE.authFailed, "auth failed");
    });
    return;
  }

  if (!state.userId) {
    ws.close(WS_CLOSE.authFailed, "not authenticated");
    return;
  }

  switch (msg.type) {
    case "send": {
      if (typeof msg.message !== "string" || !msg.message.trim()) {
        fail(ws, "A message is required");
        return;
      }
      const turnId = startTurn(state.userId, {
        message: msg.message,
        conversationId: msg.conversationId,
        webSearch: msg.webSearch === true,
        // Shape-checked downstream by the agent, exactly as the SSE route's body is.
        attachments: Array.isArray(msg.attachments)
          ? (msg.attachments as InputAttachment[])
          : undefined,
      });
      send(ws, {
        type: "turn_started",
        turnId,
        clientMsgId: msg.clientMsgId,
        conversationId: msg.conversationId,
      });
      attach(ws, state, turnId, 0);
      return;
    }

    case "resume": {
      const turnId = String(msg.turnId ?? "");
      const snapshot = getTurn(state.userId, turnId);
      send(ws, {
        type: "turn_started",
        turnId,
        conversationId: snapshot.conversationId,
        resumed: true,
      });
      attach(ws, state, turnId, Number(msg.fromSeq) || 0);
      return;
    }

    case "watch": {
      const conversationId = String(msg.conversationId ?? "");
      if (!conversationId) return;
      // Standing interest, so a turn started later (in another tab) is picked up
      // too — not just one that happens to be running right now.
      state.watched.add(conversationId);

      const turnId = findTurnByConversation(state.userId, conversationId);
      if (!turnId) {
        send(ws, { type: "no_active_turn", conversationId });
        return;
      }
      // A tab joining late has none of the turn, so replay all of it — including
      // the student's own message, which is not persisted until the turn ends.
      send(ws, {
        type: "turn_started",
        turnId,
        conversationId,
        prompt: getTurn(state.userId, turnId).prompt,
        watching: true,
      });
      attach(ws, state, turnId, 0);
      return;
    }

    case "cancel": {
      const turnId = String(msg.turnId ?? "");
      cancelTurn(state.userId, turnId);
      return;
    }

    case "unwatch": {
      const turnId = String(msg.turnId ?? "");
      if (msg.conversationId) state.watched.delete(String(msg.conversationId));
      state.subscriptions.get(turnId)?.();
      state.subscriptions.delete(turnId);
      return;
    }

    default:
      fail(ws, `Unknown message type "${String(msg.type)}"`);
  }
}

function onConnection(ws: WebSocket): void {
  const state: SocketState = {
    isAlive: true,
    subscriptions: new Map(),
    attachedTurns: new Set(),
    watched: new Set(),
  };
  states.set(ws, state);

  // Turns started anywhere (this user's other tabs) that belong to a conversation
  // this socket is watching.
  state.stopWatching = onTurnStart((turn) => {
    if (turn.userId !== state.userId) return;
    if (!turn.conversationId || !state.watched.has(turn.conversationId)) return;
    if (state.subscriptions.has(turn.turnId)) return; // this socket started it
    send(ws, {
      type: "turn_started",
      turnId: turn.turnId,
      conversationId: turn.conversationId,
      // The student's message is not saved until the turn ends, so a watching
      // tab has to be told it or it shows an answer with no question above it.
      prompt: turn.prompt,
      watching: true,
    });
    attach(ws, state, turn.turnId, 0);
  });

  // A chat started on another device only reaches the database when its turn
  // ends, so that is when this session's sidebar has to be told to refetch —
  // otherwise a new conversation simply never shows up here.
  state.stopListChanges = onTurnEnd((turn) => {
    if (turn.userId !== state.userId) return;
    if (state.attachedTurns.has(turn.turnId)) return; // this socket followed it and refreshes itself
    send(ws, { type: "conversations_changed", conversationId: turn.conversationId });
  });

  state.authTimer = setTimeout(() => {
    if (!state.userId) ws.close(WS_CLOSE.authTimeout, "auth timeout");
  }, AUTH_TIMEOUT_MS);
  state.authTimer.unref?.();

  ws.on("pong", () => {
    state.isAlive = true;
  });

  ws.on("message", (raw) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(String(raw)) as ClientMessage;
    } catch {
      ws.close(WS_CLOSE.badMessage, "malformed message");
      return;
    }
    try {
      handleMessage(ws, state, msg);
    } catch (err) {
      // Registry errors (404 unknown turn, 429 too many turns) are normal client
      // mistakes — report them and keep the socket open.
      const message =
        err instanceof ApiError ? err.message : err instanceof Error ? err.message : "Request failed";
      fail(ws, message, msg.turnId);
      if (!(err instanceof ApiError)) {
        logger.error({ err, type: msg.type }, "chat socket message failed");
      }
    }
  });

  ws.on("close", () => {
    clearTimeout(state.authTimer);
    state.stopWatching?.();
    state.stopListChanges?.();
    // Unsubscribe only — the turns themselves keep running, which is what makes
    // reconnect-and-resume possible.
    for (const stop of state.subscriptions.values()) stop();
    state.subscriptions.clear();
    state.attachedTurns.clear();
    state.watched.clear();
  });

  ws.on("error", (err) => logger.warn({ err }, "chat socket error"));
}

/** Same-origin or an allow-listed browser origin; non-browser clients send none. */
function originAllowed(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  return corsOrigins.includes(origin);
}

/**
 * Attaches the chat socket to an existing http server. `noServer` keeps Express
 * in charge of every normal request; only upgrades on CHAT_WS_PATH are taken.
 */
export function attachChatSocket(server: Server): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });
  wss.on("connection", onConnection);

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const { pathname } = new URL(req.url ?? "", `http://${req.headers.host ?? "localhost"}`);
    if (pathname !== CHAT_WS_PATH) return; // another handler may own it
    if (!originAllowed(req)) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      const state = states.get(ws);
      if (state && !state.isAlive) {
        ws.terminate();
        continue;
      }
      if (state) state.isAlive = false;
      ws.ping();
    }
  }, HEARTBEAT_MS);
  heartbeat.unref?.();
  wss.on("close", () => clearInterval(heartbeat));

  return wss;
}
