import type { Request, Response } from "express";
import * as projectService from "../services/project.service.js";
import type { ProjectInput } from "../services/project.service.js";
import * as reviewService from "../services/projectReview.service.js";
import { lockForProject, projectLocks } from "../services/projectGate.js";
import { ApiError } from "../utils/apiError.js";

export async function createProject(req: Request, res: Response): Promise<void> {
  const project = await projectService.createProject(req.user!.id, req.body as ProjectInput);
  res.status(201).json({ success: true, data: project });
}

export async function listProjects(req: Request, res: Response): Promise<void> {
  const projects = await projectService.listProjects(req.user!.id);
  // One courses + one enrollments query for the whole list — see projectGate.
  const locks = await projectLocks(req.user!.id, projects);
  res.json({ success: true, data: projects.map((p) => ({ ...p, ...locks.get(p) })) });
}

export async function getProject(req: Request, res: Response): Promise<void> {
  const project = await projectService.getProjectWithRequirements(
    req.user!.id,
    req.params.id as string,
  );
  const lock = await lockForProject(req.user!.id, project);
  res.json({ success: true, data: { ...project, ...lock } });
}

export async function updateProject(req: Request, res: Response): Promise<void> {
  const project = await projectService.updateProject(
    req.user!.id,
    req.params.id as string,
    req.body as Partial<ProjectInput>,
  );
  res.json({ success: true, data: project });
}

export async function deleteProject(req: Request, res: Response): Promise<void> {
  await projectService.deleteProject(req.user!.id, req.params.id as string);
  res.json({ success: true });
}

/**
 * Two shapes on one route: a JSON body for a GitHub link, or multipart with a
 * zip for an uploaded folder (multer has already parsed the file by now).
 */
export async function startReview(req: Request, res: Response): Promise<void> {
  const projectId = req.params.id as string;
  const zip = req.file;

  if (zip) {
    const { reviewId, attempt } = await reviewService.startReview(
      req.user!.id,
      projectId,
      "file",
      zip.originalname || "project.zip",
      zip.buffer,
    );
    res.status(202).json({ success: true, data: { reviewId, attempt } });
    return;
  }

  const value = typeof req.body?.value === "string" ? req.body.value.trim() : "";
  if (!value) throw new ApiError(400, "Provide a GitHub repository link or upload your project folder.");

  const { reviewId, attempt } = await reviewService.startReview(req.user!.id, projectId, "github", value);
  res.status(202).json({ success: true, data: { reviewId, attempt } });
}

export async function getReview(req: Request, res: Response): Promise<void> {
  const review = await reviewService.getReview(req.user!.id, req.params.reviewId as string);
  res.json({ success: true, data: review });
}

export async function getReviewByAttempt(req: Request, res: Response): Promise<void> {
  const attempt = Number(req.params.attempt);
  if (!Number.isInteger(attempt) || attempt < 1) throw new ApiError(400, "Invalid attempt number");
  const review = await reviewService.getReviewByAttempt(req.user!.id, req.params.id as string, attempt);
  res.json({ success: true, data: review });
}

export async function listReviews(req: Request, res: Response): Promise<void> {
  const reviews = await reviewService.listReviews(req.user!.id, req.params.id as string);
  res.json({ success: true, data: reviews });
}
