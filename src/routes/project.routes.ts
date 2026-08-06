import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import * as projectController from "../controller/project.controller.js";
import { requireAuth } from "../middleware/auth.middleware.js";
import { validateBody } from "../middleware/validate.middleware.js";

const createProjectSchema = z.object({
  title: z.string().min(1).max(120),
  desc: z.string().max(500).optional(),
  goal: z.string().max(400).optional(),
  requirements: z.array(z.string().min(1).max(200)).max(12).optional(),
  tags: z.array(z.string().max(40)).max(12).optional(),
  icon: z.string().max(40).optional(),
  thumb: z.string().max(20).optional(),
  featured: z.boolean().optional(),
  courseId: z.string().max(80).optional(),
});

// Every field optional for a patch, but at least one must be present.
const updateProjectSchema = createProjectSchema.partial().refine(
  (v) => Object.keys(v).length > 0,
  { message: "Provide at least one field to change" },
);

/**
 * Uploaded project archives are zipped in the browser and never touch disk —
 * the reviewer reads them from memory and keeps only the source it reports on.
 */
const uploadZip = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 1 },
}).single("zip");

export const projectRouter = Router();

projectRouter.use(requireAuth);
projectRouter.get("/", projectController.listProjects);
projectRouter.post("/", validateBody(createProjectSchema), projectController.createProject);

// Before "/:id" — otherwise "reviews" reads as a project id.
projectRouter.get("/reviews/:reviewId", projectController.getReview);

projectRouter.get("/:id", projectController.getProject);
projectRouter.patch("/:id", validateBody(updateProjectSchema), projectController.updateProject);
projectRouter.delete("/:id", projectController.deleteProject);
projectRouter.post("/:id/review", uploadZip, projectController.startReview);
projectRouter.get("/:id/reviews", projectController.listReviews);
projectRouter.get("/:id/reviews/:attempt", projectController.getReviewByAttempt);
