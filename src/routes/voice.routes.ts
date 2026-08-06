import { Router } from "express";
import { z } from "zod";
import * as voiceController from "../controller/voice.controller.js";
import { requireAuth } from "../middleware/auth.middleware.js";
import { validateBody } from "../middleware/validate.middleware.js";

const createSessionSchema = z.object({
  // Optional: the Classroom can be opened without a course context; lesson
  // completion is simply skipped when it's absent.
  courseId: z.string().max(80).optional().default(""),
  lessonId: z.string().min(1).max(80),
});

export const voiceRouter = Router();

voiceRouter.use(requireAuth);
voiceRouter.post("/session", validateBody(createSessionSchema), voiceController.createSession);
