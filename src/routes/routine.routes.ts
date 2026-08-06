import { Router } from "express";
import { z } from "zod";
import * as routineController from "../controller/routine.controller.js";
import { requireAuth } from "../middleware/auth.middleware.js";
import { validateBody } from "../middleware/validate.middleware.js";

const createSchema = z.object({
  type: z.enum(["class", "task", "project"]),
  title: z.string().min(1).max(200),
  subtitle: z.string().max(500).optional(),
  date: z.string().min(1),
  time: z.string().max(20).optional(),
  durationMin: z.number().int().positive().max(1440).optional(),
  tag: z.string().max(40).optional(),
  deadline: z.string().optional(),
  completed: z.boolean().optional(),
});

// Every field optional on update (PATCH semantics), but at least one must be present.
const updateSchema = createSchema.partial().refine((v) => Object.keys(v).length > 0, {
  message: "No fields to update",
});

export const routineRouter = Router();

routineRouter.use(requireAuth);
routineRouter.get("/", routineController.listItems);
routineRouter.post("/", validateBody(createSchema), routineController.createItem);
routineRouter.patch("/:id", validateBody(updateSchema), routineController.updateItem);
routineRouter.delete("/:id", routineController.deleteItem);
