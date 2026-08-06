import { Router } from "express";
import { z } from "zod";
import * as authController from "../controller/auth.controller.js";
import { requireAuth } from "../middleware/auth.middleware.js";
import { requireCsrf } from "../middleware/csrf.middleware.js";
import {
  authLimiter,
  lookupLimiter,
  lookupSustainedLimiter,
  sessionLimiter,
} from "../middleware/rateLimit.middleware.js";
import { validateBody } from "../middleware/validate.middleware.js";
import {
  USERNAME_MAX_LENGTH,
  USERNAME_MIN_LENGTH,
  USERNAME_PATTERN,
  USERNAME_PATTERN_MESSAGE,
} from "../services/auth.service.js";

// Password policy: 8-72 chars, at least one letter and one number.
// Capped at 72 because bcrypt silently ignores bytes beyond that.
const passwordSchema = z
  .string()
  .min(8, "Password must be at least 8 characters")
  .max(72, "Password must be at most 72 characters")
  .refine((v) => /[A-Za-z]/.test(v) && /[0-9]/.test(v), {
    message: "Password must include at least one letter and one number",
  });

const registerSchema = z.object({
  name: z.string().min(1).max(100),
  // Same rules the live /check-username endpoint applies — both read from
  // auth.service so an "available ✓" can never be rejected on submit.
  username: z
    .string()
    .min(USERNAME_MIN_LENGTH)
    .max(USERNAME_MAX_LENGTH)
    .regex(USERNAME_PATTERN, USERNAME_PATTERN_MESSAGE),
  email: z.string().email(),
  password: passwordSchema,
});

const loginSchema = z.object({
  identifier: z.string().min(1),
  password: z.string().min(1),
});

const verifyEmailSchema = z.object({
  code: z.string().length(6),
});

const forgotPasswordSchema = z.object({
  email: z.string().email(),
});

const resetPasswordSchema = z.object({
  token: z.string().min(1),
  newPassword: passwordSchema,
});

export const authRouter = Router();

// Two windows: the burst budget a signup form needs while the student types,
// and an hourly cap that a real signup never reaches but enumeration does.
authRouter.get(
  "/check-username",
  lookupLimiter,
  lookupSustainedLimiter,
  authController.checkUsername,
);
authRouter.post("/register", authLimiter, validateBody(registerSchema), authController.register);
authRouter.post("/login", authLimiter, validateBody(loginSchema), authController.login);
// These two act on the refresh cookie alone — no Bearer token — so they are the
// only forgeable-by-a-cross-origin-page routes and the only ones needing CSRF.
authRouter.post("/refresh", sessionLimiter, requireCsrf, authController.refresh);
authRouter.post("/logout", sessionLimiter, requireCsrf, authController.logout);
authRouter.post(
  "/verify-email",
  requireAuth,
  sessionLimiter,
  validateBody(verifyEmailSchema),
  authController.verifyEmail,
);
authRouter.post("/resend-otp", requireAuth, authLimiter, authController.resendOtp);
authRouter.post("/forgot-password", authLimiter, validateBody(forgotPasswordSchema), authController.forgotPassword);
// Read-only and idempotent, so it gets lookupLimiter rather than authLimiter:
// the reset page calls it on every mount, and authLimiter's 10-per-15-minutes
// is a budget the student needs for the reset itself. The token is 32 random
// bytes, so guessing it is not the threat this limit is guarding against.
authRouter.get("/reset-password/check", lookupLimiter, authController.checkResetToken);
authRouter.post("/reset-password", authLimiter, validateBody(resetPasswordSchema), authController.resetPassword);
authRouter.get("/me", requireAuth, authController.me);
