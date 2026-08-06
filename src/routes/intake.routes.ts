import { Router } from "express";
import * as intakeController from "../controller/intake.controller.js";
import { requireAuth } from "../middleware/auth.middleware.js";
import { validateBody } from "../middleware/validate.middleware.js";
import { submitStageSchema } from "../validation/intake.schema.js";

// Intakes are started by the chat agent's start_learning_intake tool, so there
// is no create route here — only resuming and answering stages.
export const intakeRouter = Router();

intakeRouter.use(requireAuth);
intakeRouter.get("/:id", intakeController.getIntake);
intakeRouter.post("/:id/answers", validateBody(submitStageSchema), intakeController.submitStage);
