import type { Response } from "express";
import jwt, { type SignOptions } from "jsonwebtoken";
import { env, voiceServiceSecret } from "../config/env.js";
import { RefreshTokenModel } from "../database/models/refreshToken.model.js";
import { randomToken, sha256 } from "../utils/crypto.js";

const REFRESH_COOKIE = "refresh_token";
const REFRESH_PATH = "/api/auth";
const ACCESS_ALG = "HS256" as const;

/**
 * CSRF double-submit token.
 *
 * Deliberately NOT httpOnly — the browser-side code has to read it to echo it
 * back in the `X-CSRF-Token` header, and that echo is the whole mechanism: a
 * cross-origin page can send the victim's cookies but cannot read them, so it
 * cannot produce the matching header. Path `/` rather than the refresh cookie's
 * `/api/auth` for the same reason: script running on an app page must be able
 * to see it.
 *
 * This is defence in depth, not the primary control — `sameSite: "strict"` on
 * the refresh cookie already means a cross-site request carries no session at
 * all. It exists for the cases that weakens: a browser that ignores SameSite,
 * or a future integration that has to relax it.
 */
const CSRF_COOKIE = "csrf_token";
const CSRF_HEADER = "x-csrf-token";

/**
 * Issuer claims.
 *
 * The voice agent signs its own tokens on behalf of whichever student is in the
 * room, so its credential is, by construction, an "act as anyone" key. Keeping
 * it distinguishable from a real login — a different secret AND a different
 * issuer — is what stops a compromised voice host from being full account
 * takeover: an agent token is only accepted on the handful of routes the agent
 * actually needs (see middleware/auth.middleware.ts).
 */
export const ISSUER_APP = "saidrix" as const;
export const ISSUER_VOICE_AGENT = "saidrix-voice-agent" as const;

export interface AccessPayload {
  sub: string;
  email: string;
}

/** Signs a short-lived access JWT (algorithm pinned). */
export function signAccessToken(userId: string, email: string): string {
  return jwt.sign({ sub: userId, email }, env.JWT_ACCESS_SECRET, {
    algorithm: ACCESS_ALG,
    issuer: ISSUER_APP,
    expiresIn: env.JWT_ACCESS_EXPIRES_IN as SignOptions["expiresIn"],
  });
}

function decode(token: string, secret: string, issuer: string): AccessPayload {
  const payload = jwt.verify(token, secret, {
    algorithms: [ACCESS_ALG],
    issuer,
  }) as jwt.JwtPayload;
  if (typeof payload.sub !== "string" || typeof payload.email !== "string") {
    throw new Error("Malformed token payload");
  }
  return { sub: payload.sub, email: payload.email };
}

/**
 * Verifies a user's login JWT: algorithm AND issuer pinned; throws on failure.
 *
 * Pinning the issuer is what makes a voice-agent token fail here even in a
 * deployment that has not yet split the secrets — it is signed `saidrix-voice-agent`
 * and this only accepts `saidrix`.
 */
export function verifyAccessToken(token: string): AccessPayload {
  return decode(token, env.JWT_ACCESS_SECRET, ISSUER_APP);
}

/** Signs a token for the voice agent to act as a student on the allowed routes. */
export function signVoiceAgentToken(userId: string, ttlSeconds = 300): string {
  return jwt.sign({ sub: userId, email: "voice-agent@internal" }, voiceServiceSecret, {
    algorithm: ACCESS_ALG,
    issuer: ISSUER_VOICE_AGENT,
    expiresIn: ttlSeconds,
  });
}

/** Verifies a voice-agent service token. Never accepted by `verifyAccessToken`. */
export function verifyVoiceAgentToken(token: string): AccessPayload {
  return decode(token, voiceServiceSecret, ISSUER_VOICE_AGENT);
}

function refreshExpiry(): Date {
  return new Date(Date.now() + env.REFRESH_TOKEN_EXPIRES_IN_DAYS * 24 * 60 * 60 * 1000);
}

/**
 * Issues a new refresh token: stores its hash and returns the raw token to be
 * placed in the client cookie.
 */
export async function issueRefreshToken(
  userId: string,
  meta: { userAgent?: string; ip?: string } = {},
): Promise<string> {
  const raw = randomToken(32);
  await RefreshTokenModel.create({
    userId,
    tokenHash: sha256(raw),
    expiresAt: refreshExpiry(),
    userAgent: meta.userAgent,
    ip: meta.ip,
  });
  return raw;
}

/**
 * Rotates a refresh token. Returns the userId + a fresh raw token, or null if
 * the presented token is unknown/expired. Detects reuse of an already-rotated
 * token: since the old row is deleted on rotation, a second use finds nothing.
 */
export async function rotateRefreshToken(
  rawToken: string,
  meta: { userAgent?: string; ip?: string } = {},
): Promise<{ userId: string; rawToken: string } | null> {
  const existing = await RefreshTokenModel.findOneAndDelete({ tokenHash: sha256(rawToken) });
  if (!existing || existing.expiresAt.getTime() < Date.now()) return null;

  const userId = existing.userId.toString();
  const raw = await issueRefreshToken(userId, meta);
  return { userId, rawToken: raw };
}

/** Deletes a single refresh token (logout). */
export async function revokeRefreshToken(rawToken: string): Promise<void> {
  await RefreshTokenModel.deleteOne({ tokenHash: sha256(rawToken) });
}

/** Deletes every refresh token for a user (password reset / theft response). */
export async function revokeAllRefreshTokens(userId: string): Promise<void> {
  await RefreshTokenModel.deleteMany({ userId });
}

/**
 * Sets the httpOnly refresh cookie, and alongside it a fresh CSRF token.
 *
 * The two are issued together on purpose: a session holding a refresh cookie
 * but no CSRF cookie is exactly the state `requireCsrf` has to wave through,
 * so nothing may create one. Every caller that starts or rotates a session
 * (register, login, refresh) goes through here.
 */
export function setRefreshCookie(res: Response, rawToken: string): void {
  const maxAge = env.REFRESH_TOKEN_EXPIRES_IN_DAYS * 24 * 60 * 60 * 1000;
  res.cookie(REFRESH_COOKIE, rawToken, {
    httpOnly: true,
    secure: env.NODE_ENV === "production",
    sameSite: "strict",
    path: REFRESH_PATH,
    domain: env.COOKIE_DOMAIN,
    maxAge,
  });
  res.cookie(CSRF_COOKIE, randomToken(32), {
    httpOnly: false,
    secure: env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    domain: env.COOKIE_DOMAIN,
    maxAge,
  });
}

/** Clears the refresh cookie and its CSRF partner (logout). */
export function clearRefreshCookie(res: Response): void {
  res.clearCookie(REFRESH_COOKIE, {
    httpOnly: true,
    secure: env.NODE_ENV === "production",
    sameSite: "strict",
    path: REFRESH_PATH,
    domain: env.COOKIE_DOMAIN,
  });
  res.clearCookie(CSRF_COOKIE, {
    httpOnly: false,
    secure: env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    domain: env.COOKIE_DOMAIN,
  });
}

export const REFRESH_COOKIE_NAME = REFRESH_COOKIE;
export const CSRF_COOKIE_NAME = CSRF_COOKIE;
export const CSRF_HEADER_NAME = CSRF_HEADER;
