import type { Request, Response } from "express";
import * as voiceService from "../services/voice.service.js";
import type { VoiceSessionInput } from "../services/voice.service.js";

export async function createSession(req: Request, res: Response): Promise<void> {
  const session = await voiceService.createVoiceSession(
    req.user!.id,
    req.user!.email,
    req.body as VoiceSessionInput,
  );
  res.status(201).json({ success: true, data: session });
}
