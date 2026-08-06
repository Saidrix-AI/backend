import type { Request, Response } from "express";
import * as routineService from "../services/routine.service.js";
import type { RoutineItemInput } from "../services/routine.service.js";

export async function listItems(req: Request, res: Response): Promise<void> {
  const items = await routineService.listRoutineItems(req.user!.id);
  res.json({ success: true, data: items });
}

export async function createItem(req: Request, res: Response): Promise<void> {
  const item = await routineService.createRoutineItem(req.user!.id, req.body as RoutineItemInput);
  res.status(201).json({ success: true, data: item });
}

export async function updateItem(req: Request, res: Response): Promise<void> {
  const item = await routineService.updateRoutineItem(
    req.user!.id,
    req.params.id as string,
    req.body as Partial<RoutineItemInput>,
  );
  res.json({ success: true, data: item });
}

export async function deleteItem(req: Request, res: Response): Promise<void> {
  await routineService.deleteRoutineItem(req.user!.id, req.params.id as string);
  res.json({ success: true, data: { id: req.params.id } });
}
