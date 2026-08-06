import { Router } from "express";
import * as assessmentController from "../controller/assessment.controller.js";
import { requireAuth } from "../middleware/auth.middleware.js";
import { validateBody } from "../middleware/validate.middleware.js";
import { submitRoundSchema } from "../validation/assessment.schema.js";

// Assessments are started by the chat agent's start_knowledge_check tool, so
// there is no create route here — only reading and answering rounds.
export const assessmentRouter = Router();

assessmentRouter.use(requireAuth);
assessmentRouter.get("/:id", assessmentController.getAssessment);
assessmentRouter.post("/:id/answers", validateBody(submitRoundSchema), assessmentController.submitRound);
