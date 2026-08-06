import type { Request, Response } from "express";
import * as authService from "../services/auth.service.js";
import * as verificationService from "../services/verification.service.js";
import {
  REFRESH_COOKIE_NAME,
  clearRefreshCookie,
  rotateRefreshToken,
  revokeRefreshToken,
  setRefreshCookie,
  signAccessToken,
} from "../services/token.service.js";
import { ApiError } from "../utils/apiError.js";
import { logger } from "../utils/logger.js";

function reqMeta(req: Request): { userAgent?: string; ip?: string } {
  return { userAgent: req.headers["user-agent"], ip: req.ip };
}

export async function register(req: Request, res: Response): Promise<void> {
  const { name, username, email, password } = req.body as {
    name: string;
    username: string;
    email: string;
    password: string;
  };
  const { accessToken, refreshToken, user } = await authService.register(
    { name, username, email, password },
    reqMeta(req),
  );
  setRefreshCookie(res, refreshToken);

  // Non-fatal: registration succeeds even if the OTP email fails to send.
  verificationService
    .sendEmailOtp(user.id, user.email)
    .catch((err) => logger.error(err, "Failed to send verification OTP"));

  res.status(201).json({ success: true, data: { accessToken, user } });
}

/**
 * Live username availability for the signup form.
 *
 * Always 200, even for a malformed name: the form wants one shape it can render
 * inline ("taken", "too short", "bad characters"), not an exception per case.
 * This does make usernames enumerable — unavoidable for the feature, and the
 * reason it is rate-limited and never accepts an email.
 */
export async function checkUsername(req: Request, res: Response): Promise<void> {
  const raw = typeof req.query.username === "string" ? req.query.username : "";
  const result = await authService.checkUsernameAvailability(raw);
  res.json({ success: true, data: result });
}

export async function login(req: Request, res: Response): Promise<void> {
  const { identifier, password } = req.body as { identifier: string; password: string };
  const { accessToken, refreshToken, user } = await authService.login(
    identifier,
    password,
    reqMeta(req),
  );
  setRefreshCookie(res, refreshToken);
  res.json({ success: true, data: { accessToken, user } });
}

export async function refresh(req: Request, res: Response): Promise<void> {
  const raw = req.cookies?.[REFRESH_COOKIE_NAME] as string | undefined;
  if (!raw) {
    throw new ApiError(401, "Missing refresh token");
  }

  const rotated = await rotateRefreshToken(raw, reqMeta(req));
  if (!rotated) {
    clearRefreshCookie(res);
    throw new ApiError(401, "Invalid or expired session");
  }

  const user = await authService.getUserById(rotated.userId);
  setRefreshCookie(res, rotated.rawToken);
  const accessToken = signAccessToken(user.id, user.email);
  res.json({ success: true, data: { accessToken, user } });
}

export async function logout(req: Request, res: Response): Promise<void> {
  const raw = req.cookies?.[REFRESH_COOKIE_NAME] as string | undefined;
  if (raw) await revokeRefreshToken(raw);
  clearRefreshCookie(res);
  res.json({ success: true, data: { message: "Logged out" } });
}

export async function verifyEmail(req: Request, res: Response): Promise<void> {
  const { code } = req.body as { code: string };
  await verificationService.verifyEmailOtp(req.user!.id, code);
  res.json({ success: true, data: { message: "Email verified" } });
}

export async function resendOtp(req: Request, res: Response): Promise<void> {
  const user = await authService.getUserById(req.user!.id);
  if (user.emailVerified) {
    res.json({ success: true, data: { message: "Email already verified" } });
    return;
  }
  await verificationService.sendEmailOtp(user.id, user.email);
  res.json({ success: true, data: { message: "Verification code sent" } });
}

export async function forgotPassword(req: Request, res: Response): Promise<void> {
  const { email } = req.body as { email: string };
  await verificationService.requestPasswordReset(email);
  // Always 200 — never reveal whether the email exists.
  res.json({ success: true, data: { message: "If that email exists, a reset link has been sent." } });
}

/**
 * Cheap liveness check for a reset link, called when the reset page mounts.
 * Answers only "still redeemable?" — never who the token belongs to.
 */
export async function checkResetToken(req: Request, res: Response): Promise<void> {
  const token = typeof req.query.token === "string" ? req.query.token : "";
  const valid = token.length > 0 && (await verificationService.isPasswordResetTokenValid(token));
  res.json({ success: true, data: { valid } });
}

export async function resetPassword(req: Request, res: Response): Promise<void> {
  const { token, newPassword } = req.body as { token: string; newPassword: string };
  await verificationService.resetPassword(token, newPassword);
  res.json({ success: true, data: { message: "Password reset successful" } });
}

export async function me(req: Request, res: Response): Promise<void> {
  const user = await authService.getUserById(req.user!.id);
  res.json({ success: true, data: { user } });
}
