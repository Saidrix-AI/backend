import type { Request, Response } from "express";
import * as assessmentService from "../services/assessment.service.js";
import * as lectureService from "../services/lecture.service.js";
import * as progressService from "../services/progress.service.js";

export async function getLecture(req: Request, res: Response): Promise<void> {
  const lessonId = req.params.lessonId as string;
  // Gated here as well as on the generate paths: this is what a hand-typed
  // /classroom?lecture=… hits for an already-generated lecture, so without it
  // the active-course rule would only hold for the buttons in the UI.
  await lectureService.assertLessonEnterable(req.user!.id, lessonId);
  const lecture = await lectureService.getLectureByLessonId(req.user!.id, lessonId);
  res.json({ success: true, data: lecture });
}

/**
 * Grades the lecture's closing exam. The browser never receives the answer key
 * (lecture.service strips it), so this is the only place a score can be
 * decided — the picks come in, the result and the key go back once the attempt
 * is safely recorded.
 *
 * The key does go back, because seeing which questions you missed and why is
 * the point of sitting the exam. That is also why only the first attempt is
 * graded: a retake is taken with the answers already in hand, so it is recorded
 * as practice and does not move the score or the knowledge profile.
 */
export async function submitLectureQuiz(req: Request, res: Response): Promise<void> {
  const lessonId = req.params.lessonId as string;
  const { answers, courseId } = req.body as { answers: number[]; courseId?: string };

  const result = await lectureService.gradeLectureQuiz(req.user!.id, lessonId, answers);

  // Record first: a profile write that fails must not cost the student their
  // score, so the attempt is durable before the softer update is attempted.
  const { graded } = await progressService.submitQuiz(
    req.user!.id,
    lessonId,
    result.score,
    courseId,
  );

  // Mastery is only moved by an attempt sat without the answers. A practice
  // retake would otherwise let anyone mark every concept as mastered.
  if (graded) {
    await assessmentService
      .recordQuizOutcome(req.user!.id, { score: result.score, concepts: result.concepts })
      .catch(() => {});
  }

  res.json({ success: true, data: { ...result, graded } });
}

/** On-demand generation at classroom join: 200 when cached, 201 when freshly generated. */
export async function generateLecture(req: Request, res: Response): Promise<void> {
  const { lecture, created } = await lectureService.generateLectureForLesson(
    req.user!.id,
    req.params.lessonId as string,
  );
  res.status(created ? 201 : 200).json({ success: true, data: lecture });
}

/**
 * Same generation as above, but as an SSE stream of real pipeline stages
 * (planning → per-topic writing → per-diagram drawing → assembling → done)
 * instead of one silent multi-minute wait. Never aborts the underlying job on
 * disconnect — other tabs may still be watching it.
 */
export async function generateLectureStream(req: Request, res: Response): Promise<void> {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  const send = (event: unknown) => res.write(`data: ${JSON.stringify(event)}\n\n`);

  try {
    for await (const ev of lectureService.streamLectureGeneration(req.user!.id, req.params.lessonId as string)) {
      if (res.writableEnded) break;
      send(ev);
    }
  } catch (err) {
    if (!res.writableEnded) {
      send({ type: "error", message: err instanceof Error ? err.message : "Stream failed" });
    }
  } finally {
    res.end();
  }
}

/** Where the student had reached — read by the voice agent when its cache has expired. */
export async function getPosition(req: Request, res: Response): Promise<void> {
  const position = await lectureService.getLecturePosition(
    req.user!.id,
    req.params.lessonId as string,
  );
  res.json({ success: true, data: position ?? { blockIndex: 0, mode: "lecture" } });
}

/** Durable checkpoint, written by the agent as narration moves and on leave. */
export async function savePosition(req: Request, res: Response): Promise<void> {
  const { blockIndex, mode, courseId } = req.body as {
    blockIndex: number;
    mode?: string;
    courseId?: string;
  };
  await lectureService.saveLecturePosition(req.user!.id, req.params.lessonId as string, {
    blockIndex,
    mode,
    courseId,
  });
  res.json({ success: true, data: { message: "Position saved" } });
}
