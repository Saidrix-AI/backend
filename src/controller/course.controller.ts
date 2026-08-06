import type { Request, Response } from "express";
import * as activeSelectionService from "../services/activeSelection.service.js";
import * as courseService from "../services/course.service.js";
import type { CourseInput } from "../services/course.service.js";
import { getCourseDetail } from "../services/courseDetail.service.js";
import { listPathsWithCourses } from "../services/learningPath.service.js";
import { stripCourseBriefs } from "../services/course.projection.js";

export async function createCourse(req: Request, res: Response): Promise<void> {
  const course = await courseService.createCourse(req.user!.id, req.body as CourseInput);
  res.status(201).json({ success: true, data: course });
}

export async function listCourses(req: Request, res: Response): Promise<void> {
  // Stripped in the controller, not the service: the Course-maker and the agent
  // tools call listCourses too and need full-fidelity documents.
  const courses = await courseService.listCourses(req.user!.id);
  res.json({ success: true, data: courses.map(stripCourseBriefs) });
}

export async function courseDetail(req: Request, res: Response): Promise<void> {
  const detail = await getCourseDetail(req.user!.id, req.params.id as string);
  res.json({ success: true, data: detail });
}

export async function deleteCourse(req: Request, res: Response): Promise<void> {
  await courseService.deleteCourse(req.user!.id, req.params.id as string);
  res.json({ success: true });
}

/** Every commitment at once, plus how much room the plan leaves for another. */
export async function getActive(req: Request, res: Response): Promise<void> {
  const active = await activeSelectionService.getActiveState(req.user!.id);
  res.json({ success: true, data: active });
}

/** Commit to a path, or to a standalone course. A course that belongs to a
 *  path activates the path instead — the service enforces that. */
export async function setActive(req: Request, res: Response): Promise<void> {
  const { pathId, courseId } = req.body as { pathId?: string; courseId?: string };
  const active = pathId
    ? await activeSelectionService.setActivePath(req.user!.id, pathId)
    : await activeSelectionService.setActiveCourse(req.user!.id, courseId as string);
  res.json({ success: true, data: active });
}

/**
 * Switch one commitment off. `?pathId=` or `?courseId=` names which; with
 * neither, the most recently activated one goes — what a bare "deactivate"
 * button on the resume hero means.
 */
export async function clearActive(req: Request, res: Response): Promise<void> {
  const pathId = typeof req.query.pathId === "string" ? req.query.pathId : undefined;
  const courseId = typeof req.query.courseId === "string" ? req.query.courseId : undefined;
  const active = await activeSelectionService.clearActiveCommitment(req.user!.id, {
    pathId,
    courseId,
  });
  res.json({ success: true, data: active });
}

export async function listPaths(req: Request, res: Response): Promise<void> {
  const paths = await listPathsWithCourses(req.user!.id);
  res.json({ success: true, data: paths });
}
