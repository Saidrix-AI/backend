import { Router } from "express";
import { z } from "zod";
import * as boardController from "../controller/board.controller.js";
import { requireAuthOrVoiceAgent } from "../middleware/auth.middleware.js";
import { validateBody } from "../middleware/validate.middleware.js";
import { MAX_BOARD_ELEMENTS } from "../services/board.service.js";

/**
 * The classroom whiteboard's durable snapshot. On the voice-agent allowlist
 * (routes/index.ts): the agent writes it, the student's browser reads it, both
 * as the same student. The element shape is the board protocol and is kept
 * as-is (`passthrough`) — only id/kind are required here.
 */
export const boardRouter = Router();

const boardSchema = z.object({
  rev: z.number().int().min(0),
  elements: z
    .array(z.object({ id: z.string().min(1).max(40), kind: z.string().min(1).max(20) }).passthrough())
    .max(MAX_BOARD_ELEMENTS),
});

boardRouter.use(requireAuthOrVoiceAgent);
boardRouter.get("/:lessonId/board", boardController.getBoard);
boardRouter.put("/:lessonId/board", validateBody(boardSchema), boardController.saveBoard);
