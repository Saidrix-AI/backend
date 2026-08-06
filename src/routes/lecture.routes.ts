import { Router } from "express";
import { z } from "zod";
import * as lectureController from "../controller/lecture.controller.js";
import { requireAuth, requireAuthOrVoiceAgent } from "../middleware/auth.middleware.js";
import { validateBody } from "../middleware/validate.middleware.js";

// The durable "where was I" checkpoint. Written by the voice agent, which
// authenticates as the student with its own signed token.
const positionSchema = z.object({
  blockIndex: z.number().int().min(0).max(5000),
  mode: z.enum(["lecture", "qa", "paused", "done"]).optional(),
  courseId: z.string().max(80).optional(),
});

// One picked option index per question. Bounded so a hostile client can't post
// a huge array; out-of-range picks are graded as wrong rather than rejected.
const submitQuizSchema = z.object({
  answers: z.array(z.number().int().min(0).max(50)).min(1).max(50),
  courseId: z.string().min(1).max(80).optional(),
});

/**
 * The three lecture routes the voice agent is allowed to call: read the lecture
 * it narrates, and read/write the student's position in it.
 *
 * Mounted ahead of `lectureRouter` (see routes/index.ts) so the allowlist is
 * structural rather than a rule someone has to remember. Anything not matched
 * here falls through to the user-only router below, whose `requireAuth` rejects
 * an agent token outright — so a new lecture route is closed to the agent by
 * default, which is the safe direction to be wrong in.
 */
export const voiceAgentLectureRouter = Router();

voiceAgentLectureRouter.use(requireAuthOrVoiceAgent);
voiceAgentLectureRouter.get("/:lessonId", lectureController.getLecture);
voiceAgentLectureRouter.get("/:lessonId/position", lectureController.getPosition);
voiceAgentLectureRouter.put(
  "/:lessonId/position",
  validateBody(positionSchema),
  lectureController.savePosition,
);

export const lectureRouter = Router();

lectureRouter.use(requireAuth);
lectureRouter.post("/:lessonId/generate", lectureController.generateLecture);
lectureRouter.post("/:lessonId/generate/stream", lectureController.generateLectureStream);
lectureRouter.post(
  "/:lessonId/quiz",
  validateBody(submitQuizSchema),
  lectureController.submitLectureQuiz,
);
