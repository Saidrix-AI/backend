import type { Request, Response } from "express";
import * as chatService from "../services/chat.service.js";

export async function sendMessage(req: Request, res: Response): Promise<void> {
  const { message, conversationId } = req.body as {
    message: string;
    conversationId?: string;
  };
  const result = await chatService.sendMessage(req.user!.id, message, conversationId);
  res.json({ success: true, data: result });
}

export async function getConversation(req: Request, res: Response): Promise<void> {
  const conversation = await chatService.getConversation(
    req.user!.id,
    req.params.conversationId as string,
  );
  res.json({ success: true, data: conversation });
}
