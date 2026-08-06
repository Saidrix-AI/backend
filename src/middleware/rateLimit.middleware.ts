import rateLimit from "express-rate-limit";

/**
 * Strict limiter for sensitive auth actions (login, register, password reset,
 * OTP). Tighter than the global API limiter to blunt brute-force / credential
 * stuffing. Disabled under NODE_ENV=test so the suite isn't throttled.
 */
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === "test",
  message: { success: false, message: "Too many attempts. Please try again later." },
});

/**
 * For read-only auth lookups that a form fires while the student types (the
 * username availability check). authLimiter's 10-per-15-minutes would run out
 * inside one signup, but the endpoint is still an enumeration surface, so it
 * gets its own generous-per-minute budget rather than no limit at all.
 */
export const lookupLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 40,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === "test",
  message: { success: false, message: "Too many requests. Please slow down." },
});

/**
 * The sustained companion to `lookupLimiter`.
 *
 * 40/minute is the right shape for someone typing into a signup field, but it
 * also permits 57,600 lookups a day from one IP — enough to walk a meaningful
 * slice of the username space. This second window caps the long-run total
 * without touching the burst allowance a real signup needs: a student fills in
 * one form, an enumerator runs for hours, and only the second notices.
 *
 * Both limiters are applied together (Express runs an array of middleware in
 * order), so a request has to satisfy the burst AND the sustained budget.
 */
export const lookupSustainedLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 300,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === "test",
  message: { success: false, message: "Too many requests. Please try again later." },
});

/**
 * For session-lifecycle endpoints (refresh, logout, verify-email) that a
 * legitimately-used app can call often — authLimiter's 10-per-15-minutes would
 * log out a normal multi-tab session. These aren't brute-forceable (a 32-byte
 * refresh token, an atomically-capped OTP attempt counter) so the limit here is
 * only guarding against unbounded DB load from a client stuck in a retry loop
 * or a deliberate flood, not credential stuffing.
 */
export const sessionLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === "test",
  message: { success: false, message: "Too many requests. Please slow down." },
});
