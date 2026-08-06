import type { Request, Response } from "express";
import * as assessmentService from "../services/assessment.service.js";
import type { SubmitRoundBody } from "../validation/assessment.schema.js";

export async function getAssessment(req: Request, res: Response): Promise<void> {
  const payload = await assessmentService.getAssessment(req.user!.id, req.params.id as string);
  res.json({ success: true, data: payload });
}

/** Answers one round; the response is either the next round or the finished profile. */
export async function submitRound(req: Request, res: Response): Promise<void> {
  const payload = await assessmentService.submitRound(
    req.user!.id,
    req.params.id as string,
    req.body as SubmitRoundBody,
  );
  res.json({ success: true, data: payload });
}
