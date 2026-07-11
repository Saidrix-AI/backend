import type { NextFunction, Request, Response } from "express";
import { ApiError } from "../utils/apiError.js";
import { logger } from "../utils/logger.js";

export function notFoundHandler(_req: Request, res: Response): void {
  res.status(404).json({ success: false, message: "Route not found" });
}

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof ApiError) {
    logger.warn({ statusCode: err.statusCode, message: err.message }, "API error");
    res.status(err.statusCode).json({ success: false, message: err.message });
    return;
  }

  logger.error(err, "Unhandled error");
  res.status(500).json({ success: false, message: "Internal server error" });
}
