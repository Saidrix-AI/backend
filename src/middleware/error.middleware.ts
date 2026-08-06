import type { NextFunction, Request, Response } from "express";
import { MulterError } from "multer";
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
    res.status(err.statusCode).json({
      success: false,
      message: err.message,
      // Omitted rather than sent as null, so responses that carry no code look
      // exactly as they did before this field existed.
      ...(err.code ? { code: err.code } : {}),
    });
    return;
  }

  // Multer rejects an over-limit or unexpected upload with a MulterError, which
  // carries no HTTP status of its own — without this it would read as a 500.
  if (err instanceof MulterError) {
    const message =
      err.code === "LIMIT_FILE_SIZE"
        ? "That project is too large to upload (25MB max)."
        : `Upload rejected: ${err.message}`;
    logger.warn({ code: err.code }, "Upload error");
    res.status(err.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({ success: false, message });
    return;
  }

  // body-parser / express.json errors carry an HTTP status (e.g. 413 for an
  // over-limit body, 400 for malformed JSON). Surface those instead of a 500.
  const status = (err as { status?: number; statusCode?: number })?.status
    ?? (err as { statusCode?: number })?.statusCode;
  if (status === 413) {
    res.status(413).json({ success: false, message: "Request body too large" });
    return;
  }
  if (err instanceof SyntaxError && status === 400) {
    res.status(400).json({ success: false, message: "Malformed JSON body" });
    return;
  }

  logger.error(err, "Unhandled error");
  res.status(500).json({ success: false, message: "Internal server error" });
}
