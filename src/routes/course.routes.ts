import { Router } from "express";
import { z } from "zod";
import * as courseController from "../controller/course.controller.js";
import { requireAuth } from "../middleware/auth.middleware.js";
import { validateBody } from "../middleware/validate.middleware.js";
import { createCourseSchema } from "../validation/course.schema.js";

// Either identifies the commitment. A courseId that belongs to a path is
// redirected to that path by the service, so both forms end up consistent.
const setActiveSchema = z
  .object({
    pathId: z.string().min(1).max(80).optional(),
    courseId: z.string().min(1).max(80).optional(),
  })
  .refine((b) => Boolean(b.pathId) !== Boolean(b.courseId), {
    message: "Provide exactly one of pathId or courseId",
  });

export const courseRouter = Router();

courseRouter.use(requireAuth);
courseRouter.get("/", courseController.listCourses);

// Declared before the ":id" routes below: Express matches in order, so a later
// "/:id/detail" would happily read "active" as a course id.
courseRouter.get("/active", courseController.getActive);
courseRouter.put("/active", validateBody(setActiveSchema), courseController.setActive);
courseRouter.delete("/active", courseController.clearActive);
courseRouter.get("/paths", courseController.listPaths);
courseRouter.post("/paths/:pathId/courses/:order", courseController.createPathCourse);

courseRouter.get("/:id/detail", courseController.courseDetail);
courseRouter.post("/", validateBody(createCourseSchema), courseController.createCourse);
courseRouter.delete("/:id", courseController.deleteCourse);
