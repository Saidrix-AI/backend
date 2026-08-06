import type { Request, Response } from "express";
import * as chatService from "../services/chat.service.js";
import * as turnRegistry from "../realtime/turnRegistry.js";
import type { InputAttachment } from "../agents/chat-agent/index.js";

export async function sendMessage(req: Request, res: Response): Promise<void> {
  const { message, conversationId } = req.body as {
    message: string;
    conversationId?: string;
  };
  const result = await chatService.sendMessage(req.user!.id, message, conversationId);
  res.json({ success: true, data: result });
}

export async function streamMessage(req: Request, res: Response): Promise<void> {
  const { message, conversationId, webSearch, attachments } = req.body as {
    message: string;
    conversationId?: string;
    webSearch?: boolean;
    attachments?: InputAttachment[];
  };

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  const send = (event: unknown) => res.write(`data: ${JSON.stringify(event)}\n\n`);

  // The fallback transport for networks that block WebSockets. It runs the turn
  // through the same registry as the socket does, so both paths produce
  // identical events — but SSE cannot resume, so a disconnect still cancels the
  // turn here (there would be no way to deliver the rest of it).
  const userId = req.user!.id;
  let turnId: string;
  try {
    turnId = turnRegistry.startTurn(userId, { message, conversationId, webSearch, attachments });
  } catch (err) {
    send({ type: "error", message: err instanceof Error ? err.message : "Stream failed" });
    res.end();
    return;
  }

  await new Promise<void>((resolve) => {
    const stop = turnRegistry.subscribe(userId, turnId, 0, {
      onEvent: (event) => {
        if (!res.writableEnded) send(event);
      },
      onEnd: () => resolve(),
    });

    req.on("close", () => {
      stop();
      turnRegistry.cancelTurn(userId, turnId);
      resolve();
    });
  });

  res.end();
}

export async function listConversations(req: Request, res: Response): Promise<void> {
  const conversations = await chatService.listConversations(req.user!.id);
  res.json({ success: true, data: conversations });
}

export async function listTrash(req: Request, res: Response): Promise<void> {
  const conversations = await chatService.listTrash(req.user!.id);
  res.json({ success: true, data: conversations });
}

export async function trashConversation(req: Request, res: Response): Promise<void> {
  await chatService.moveToTrash(req.user!.id, req.params.conversationId as string);
  res.json({ success: true, data: { conversationId: req.params.conversationId } });
}

export async function restoreConversation(req: Request, res: Response): Promise<void> {
  await chatService.restoreConversation(req.user!.id, req.params.conversationId as string);
  res.json({ success: true, data: { conversationId: req.params.conversationId } });
}

export async function permanentlyDeleteConversation(req: Request, res: Response): Promise<void> {
  await chatService.permanentlyDeleteConversation(req.user!.id, req.params.conversationId as string);
  res.json({ success: true, data: { conversationId: req.params.conversationId } });
}

export async function getConversation(req: Request, res: Response): Promise<void> {
  const conversation = await chatService.getConversation(
    req.user!.id,
    req.params.conversationId as string,
  );
  res.json({ success: true, data: conversation });
}
