import { Router } from "express";
import { z } from "zod";
import * as lectureController from "../controller/lecture.controller.js";
import { requireAuth, requireAuthOrVoiceAgent } from "../middleware/auth.middleware.js";
import { validateBody } from "../middleware/validate.middleware.js";

// The durable "where was I" checkpoint. Written by the voice agent, which
// authenticates as the student with its own signed token.
const positionSchema = z.object({
  blockIndex: z.number().int().min(0).max(5000),
  mode: z.enum(["lecture", "qa", "paused", "awaiting", "dormant", "done"]).optional(),
  courseId: z.string().max(80).optional(),
  // Where the TEACHING was, for a lecture with beats. Empty strings rather than
  // omitted when the agent has no beat — an absent field would leave the last
  // saved beat in place and resume a concept the student has already left.
  beatId: z.string().max(40).optional(),
  beatPhase: z.string().max(24).optional(),
  // The current topic's opening-question result: beat ids the student already
  // knew / half knew. Lets a class resumed mid-topic skip what they had.
  knownBeats: z.array(z.string().max(40)).max(12).optional(),
  partlyBeats: z.array(z.string().max(40)).max(12).optional(),
});

// One picked option index per question. Bounded so a hostile client can't post
// a huge array; out-of-range picks are graded as wrong rather than rejected.
const submitQuizSchema = z.object({
  answers: z.array(z.number().int().min(0).max(50)).min(1).max(50),
  courseId: z.string().min(1).max(80).optional(),
});

/**
 * The lecture routes the voice agent is allowed to call: read the lecture it
 * narrates, read/write the student's position in it, and what it needs for the
 * class's opening and goodbye.
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
// What comes after this lesson, read by the tutor for its goodbye. On this
// router because the agent is the only caller that needs it, and it needs it at
// the one moment the student is still in the room.
voiceAgentLectureRouter.get("/:lessonId/next", lectureController.getNextUp);
// Read by the tutor as a class starts, to decide whether to open topics by
// asking or by teaching. Numbers and enums only — nothing from the profile.
voiceAgentLectureRouter.get("/:lessonId/learner-signal", lectureController.getLearnerSignal);
// The tutor's memory and the web. Agent-only — the handlers refuse a student's
// own token, since a class's notes are the tutor's working record.
voiceAgentLectureRouter.get("/:lessonId/tutor-context", lectureController.getTutorContext);
voiceAgentLectureRouter.put(
  "/:lessonId/class-notes",
  validateBody(z.object({ notes: z.string().max(4000) })),
  lectureController.saveClassNotes,
);
voiceAgentLectureRouter.post(
  "/:lessonId/web-search",
  validateBody(z.object({ query: z.string().trim().min(2).max(300) })),
  lectureController.tutorWebSearch,
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
