import bcrypt from "bcryptjs";
import { corsOrigins, env } from "../config/env.js";
import { UserModel } from "../database/models/user.model.js";
import { VerificationTokenModel } from "../database/models/verificationToken.model.js";
import { ApiError } from "../utils/apiError.js";
import { generateOtp, randomToken, sha256 } from "../utils/crypto.js";
import { otpEmail, passwordResetEmail, sendMail } from "../utils/mailer.js";
import { revokeAllRefreshTokens } from "./token.service.js";

const OTP_TTL_MINUTES = 10;
const RESET_TTL_MINUTES = 30;
/** How many guesses one OTP is worth. Exported so the suite asserts the real cap. */
export const MAX_OTP_ATTEMPTS = 5;
const BCRYPT_ROUNDS = 12;

function minutesFromNow(minutes: number): Date {
  return new Date(Date.now() + minutes * 60 * 1000);
}

/** Generates a fresh email-verification OTP for a user and emails it. */
export async function sendEmailOtp(userId: string, email: string): Promise<void> {
  await VerificationTokenModel.deleteMany({ userId, type: "email_verify" });
  const code = generateOtp();
  await VerificationTokenModel.create({
    userId,
    type: "email_verify",
    codeHash: sha256(code),
    expiresAt: minutesFromNow(OTP_TTL_MINUTES),
  });
  await sendMail({ to: email, ...otpEmail(code) });
}

/** Verifies an email OTP; marks the account verified on success. */
export async function verifyEmailOtp(userId: string, code: string): Promise<void> {
  /**
   * One attempt is SPENT ATOMICALLY BEFORE the code is compared.
   *
   * Reading the row, comparing, then saving `attempts + 1` is a lost-update
   * race: guesses that overlap all read the same starting count and all write
   * the same incremented one, so N parallel guesses cost one attempt instead of
   * N. That turns MAX_OTP_ATTEMPTS from a brute-force cap into a formality —
   * a script firing 6-digit codes in parallel never exhausts it. `$inc` inside
   * findOneAndUpdate is atomic, so every guess pays for itself no matter how
   * many are in flight, and `new: true` returns the count this caller landed on.
   *
   * The cost is charged for CORRECT guesses too, which the old code exempted.
   * That is deliberate: the budget cannot be spent before the comparison and
   * also depend on it. The effective allowance is unchanged — attempts 1..5
   * pass, the 6th is refused.
   */
  const record = await VerificationTokenModel.findOneAndUpdate(
    { userId, type: "email_verify", expiresAt: { $gt: new Date() } },
    { $inc: { attempts: 1 } },
    { new: true },
  );
  if (!record) {
    throw new ApiError(400, "Verification code is invalid or has expired");
  }
  if (record.attempts > MAX_OTP_ATTEMPTS) {
    await record.deleteOne();
    throw new ApiError(429, "Too many attempts. Please request a new code.");
  }
  if (record.codeHash !== sha256(code)) {
    throw new ApiError(400, "Verification code is invalid or has expired");
  }

  await record.deleteOne();
  await UserModel.updateOne(
    { _id: userId },
    { emailVerified: true, emailVerifiedAt: new Date() },
  );
}

/**
 * Starts a password reset. Enumeration-safe: callers should always respond 200
 * regardless of whether the email exists. Only sends an email when it does.
 */
export async function requestPasswordReset(email: string): Promise<void> {
  const user = await UserModel.findOne({ email: email.toLowerCase() });
  if (!user) return;

  await VerificationTokenModel.deleteMany({ userId: user.id, type: "password_reset" });
  const token = randomToken(32);
  await VerificationTokenModel.create({
    userId: user.id,
    type: "password_reset",
    codeHash: sha256(token),
    expiresAt: minutesFromNow(RESET_TTL_MINUTES),
  });

  const appUrl = corsOrigins[0] ?? `http://localhost:${env.PORT}`;
  const link = `${appUrl}/reset-password?token=${token}`;
  await sendMail({ to: user.email, ...passwordResetEmail(link) });
}

/**
 * Read-only: is this reset token still redeemable?
 *
 * Lets the reset page say "this link is dead" on load instead of rendering a
 * working-looking form that only fails on submit. Deliberately does NOT consume
 * the token — checking a link must never be what burns it, or opening the page
 * twice would break the link the student is holding.
 */
export async function isPasswordResetTokenValid(token: string): Promise<boolean> {
  const record = await VerificationTokenModel.findOne(
    { type: "password_reset", codeHash: sha256(token), expiresAt: { $gt: new Date() } },
    { _id: 1 },
  );
  return record !== null;
}

/** Completes a password reset: updates the hash and revokes all sessions. */
export async function resetPassword(token: string, newPassword: string): Promise<void> {
  /**
   * The token is CLAIMED atomically, before the password is touched.
   *
   * Finding the record and deleting it separately is a check-then-act race: two
   * redemptions of the same link that overlap — a double-clicked submit button
   * is enough — both read the row before either deletes it, and both go on to
   * set a password. That makes a one-time link reusable in exactly the window
   * an attacker who has seen the link would use it. `findOneAndDelete` is a
   * single atomic MongoDB operation, so precisely one caller receives the
   * document and every other gets null.
   *
   * Expiry is part of the filter rather than a follow-up check for the same
   * reason. An already-expired row simply does not match, so it is left for the
   * TTL index to purge rather than being consumed here.
   */
  const record = await VerificationTokenModel.findOneAndDelete({
    type: "password_reset",
    codeHash: sha256(token),
    expiresAt: { $gt: new Date() },
  });
  if (!record) {
    throw new ApiError(400, "Reset link is invalid or has expired");
  }

  const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
  const userId = record.userId.toString();
  await UserModel.updateOne(
    { _id: userId },
    { passwordHash, failedLoginAttempts: 0, $unset: { lockedUntil: "" } },
  );

  // Force re-login everywhere after a password change.
  await revokeAllRefreshTokens(userId);
}
