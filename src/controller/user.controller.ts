import type { Request, Response } from "express";
import * as userService from "../services/user.service.js";
import { getStats } from "../services/stats.service.js";

export async function getProfile(req: Request, res: Response): Promise<void> {
  const profile = await userService.getProfile(req.user!.id);
  res.json({ success: true, data: { profile } });
}

export async function updateProfile(req: Request, res: Response): Promise<void> {
  const profile = await userService.updateProfile(req.user!.id, req.body);
  res.json({ success: true, data: { profile } });
}

export async function updateAvatar(req: Request, res: Response): Promise<void> {
  const { avatar } = req.body as { avatar: string };
  const profile = await userService.updateAvatar(req.user!.id, avatar);
  res.json({ success: true, data: { profile } });
}

export async function updateProfileSetup(req: Request, res: Response): Promise<void> {
  const profile = await userService.updateProfileSetup(req.user!.id, req.body);
  res.json({ success: true, data: { profile } });
}

export async function stats(req: Request, res: Response): Promise<void> {
  const data = await getStats(req.user!.id);
  res.json({ success: true, data });
}

export async function toggleWishlist(req: Request, res: Response): Promise<void> {
  const profile = await userService.toggleWishlist(req.user!.id, req.params.courseId as string);
  res.json({ success: true, data: { profile } });
}
