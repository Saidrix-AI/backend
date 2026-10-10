import type { Request, Response } from "express";
import * as boardService from "../services/board.service.js";
import { ApiError } from "../utils/apiError.js";

/** Read by the student's browser on entering a class and after a reconnect. */
export async function getBoard(req: Request, res: Response): Promise<void> {
  const board = await boardService.getBoard(req.user!.id, req.params.lessonId as string);
  res.json({ success: true, data: board });
}

/**
 * Written only by the voice agent: it owns the board during a class, and a
 * browser write could race it. The student's own marks reach the board through
 * the agent (topic `board`, `student_ops`), never through this route.
 */
export async function saveBoard(req: Request, res: Response): Promise<void> {
  if (req.authKind !== "voice-agent") {
    throw new ApiError(403, "The board is saved by the tutor");
  }
  const result = await boardService.saveBoard(
    req.user!.id,
    req.params.lessonId as string,
    req.body as boardService.BoardSnapshot,
  );
  res.json({ success: true, data: result });
}
