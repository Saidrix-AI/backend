import { Router } from "express";
import { z } from "zod";
import * as progressController from "../controller/progress.controller.js";
import { requireAuth, requireAuthOrVoiceAgent } from "../middleware/auth.middleware.js";
import { validateBody } from "../middleware/validate.middleware.js";

const enrollSchema = z.object({ courseId: z.string().min(1) });
const completeLessonSchema = z.object({
  courseId: z.string().min(1),
  lessonId: z.string().min(1),
});
// There is deliberately no `POST /quiz` route here.
//
// There used to be — it took a `score` straight from the request body and wrote
// it verbatim, so any account could award itself 100 on any quiz id, which fed
// course pass state, the profile stats, the quiz_master achievement and the
// blended knowledge level. Exams are now graded server-side against the stored
// answer key in exactly one place: POST /api/lectures/:lessonId/quiz
// (controller/lecture.controller.ts#submitLectureQuiz).

// Cap a single heartbeat so a bad/hostile client can't inflate study time.
const studyTimeSchema = z.object({
  seconds: z.number().int().min(0).max(3600),
  courseId: z.string().max(80).optional(),
});
const submitProjectSchema = z.object({
  method: z.enum(["github", "file"]),
  value: z.string().min(1).max(500),
});

/**
 * The one progress route the voice agent calls: it checks a lesson off when the
 * narration reaches the end. Mounted ahead of `progressRouter` so everything
 * else here stays login-only — see routes/lecture.routes.ts for the full note.
 */
export const voiceAgentProgressRouter = Router();

voiceAgentProgressRouter.post(
  "/complete-lesson",
  requireAuthOrVoiceAgent,
  validateBody(completeLessonSchema),
  progressController.completeLesson,
);

export const progressRouter = Router();

progressRouter.use(requireAuth);
progressRouter.post("/enroll", validateBody(enrollSchema), progressController.enroll);
progressRouter.post("/study-time", validateBody(studyTimeSchema), progressController.logStudyTime);

progressRouter.get("/enrollments", progressController.listEnrollments);
progressRouter.get("/projects", progressController.listMyProjects);
progressRouter.post("/project/:projectId/start", progressController.startProject);
progressRouter.post(
  "/project/:projectId/submit",
  validateBody(submitProjectSchema),
  progressController.submitProject,
);
progressRouter.post("/project/:projectId/archive", progressController.archiveProject);
progressRouter.post("/project/:projectId/unarchive", progressController.unarchiveProject);
