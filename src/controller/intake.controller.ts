import type { Request, Response } from "express";
import * as intakeService from "../services/intake.service.js";
import type { SubmitStageBody } from "../validation/intake.schema.js";

export async function getIntake(req: Request, res: Response): Promise<void> {
  const payload = await intakeService.getIntake(req.user!.id, req.params.id as string);
  res.json({ success: true, data: payload });
}

/** Answers one stage; the response is the next stage, the next round, or the finished summary. */
export async function submitStage(req: Request, res: Response): Promise<void> {
  const payload = await intakeService.submitStage(
    req.user!.id,
    req.params.id as string,
    req.body as SubmitStageBody,
  );
  res.json({ success: true, data: payload });
}
