import type { Request, Response } from "express";
import * as progress from "../services/progress.service.js";
import * as projectProgress from "../services/projectProgress.service.js";

export async function enroll(req: Request, res: Response): Promise<void> {
  const { courseId } = req.body as { courseId: string };
  await progress.enroll(req.user!.id, courseId);
  res.json({ success: true, data: { message: "Enrolled" } });
}

export async function completeLesson(req: Request, res: Response): Promise<void> {
  const { courseId, lessonId } = req.body as { courseId: string; lessonId: string };
  await progress.completeLesson(req.user!.id, courseId, lessonId);
  res.json({ success: true, data: { message: "Lesson completed" } });
}

// `submitQuiz` intentionally has no controller: a quiz score is never accepted
// from the client. See routes/progress.routes.ts for the full note.

export async function logStudyTime(req: Request, res: Response): Promise<void> {
  const { seconds, courseId } = req.body as { seconds: number; courseId?: string };
  await progress.logStudyTime(req.user!.id, seconds, courseId ?? "");
  res.json({ success: true, data: { message: "Study time logged" } });
}

export async function listEnrollments(req: Request, res: Response): Promise<void> {
  const enrollments = await progress.listEnrollments(req.user!.id);
  res.json({ success: true, data: enrollments });
}

export async function listMyProjects(req: Request, res: Response): Promise<void> {
  const projects = await projectProgress.listMyProjects(req.user!.id);
  res.json({ success: true, data: projects });
}

export async function startProject(req: Request, res: Response): Promise<void> {
  await projectProgress.startProject(req.user!.id, req.params.projectId as string);
  res.json({ success: true, data: { message: "Project started" } });
}

export async function submitProject(req: Request, res: Response): Promise<void> {
  const { method, value } = req.body as { method: "github" | "file"; value: string };
  await projectProgress.submitProject(req.user!.id, req.params.projectId as string, method, value);
  res.json({ success: true, data: { message: "Project submitted" } });
}

export async function archiveProject(req: Request, res: Response): Promise<void> {
  await projectProgress.archiveProject(req.user!.id, req.params.projectId as string);
  res.json({ success: true, data: { message: "Project archived" } });
}

export async function unarchiveProject(req: Request, res: Response): Promise<void> {
  const status = await projectProgress.unarchiveProject(req.user!.id, req.params.projectId as string);
  res.json({ success: true, data: { message: "Project unarchived", status } });
}
