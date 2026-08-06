import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

/** Cryptographically-random opaque token (hex). Used for refresh + reset tokens. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("hex");
}

/** sha256 hex digest — we store hashes of tokens/OTPs, never the raw value. */
export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Constant-time string comparison.
 *
 * `timingSafeEqual` THROWS on buffers of different lengths, so the length check
 * is not an optimisation — without it a short or absent value crashes the
 * caller instead of being rejected. Comparing lengths first leaks only the
 * length, which is fixed for every token this is used on.
 */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** 6-digit numeric OTP (zero-padded), using a CSPRNG. */
export function generateOtp(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}
