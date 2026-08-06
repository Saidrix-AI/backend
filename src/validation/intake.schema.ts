import { z } from "zod";
import { INTAKE_STAGES } from "../database/models/learningIntake.model.js";

export const submitStageSchema = z.object({
  /** Which stage these answers belong to — a stale tab is rejected, not misapplied. */
  stage: z.enum(INTAKE_STAGES),
  /** Knowledge-check stage only. */
  round: z.number().int().min(1).max(10).optional(),
  answers: z
    .array(z.object({ answer: z.string().min(1).max(400) }))
    .min(1)
    .max(8),
});
export type SubmitStageBody = z.infer<typeof submitStageSchema>;
