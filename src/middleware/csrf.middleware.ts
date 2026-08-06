import type { NextFunction, Request, Response } from "express";
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from "../services/token.service.js";
import { ApiError } from "../utils/apiError.js";
import { timingSafeEqualStr } from "../utils/crypto.js";

/**
 * Double-submit CSRF check for the cookie-authenticated endpoints.
 *
 * `/auth/refresh` and `/auth/logout` are the only routes that act on the
 * refresh cookie alone — everything else needs a Bearer token, which a
 * cross-origin page cannot obtain, so those are not forgeable to begin with.
 *
 * The check: the `X-CSRF-Token` header must equal the `csrf_token` cookie. An
 * attacker's page can make the browser SEND the victim's cookies, but the same
 * origin policy stops it READING them, so it cannot produce the header. (The
 * custom header alone also forces a CORS preflight, which the origin allowlist
 * in app.ts rejects.)
 *
 * This layers on top of `sameSite: "strict"`, which already prevents the
 * cookies from being attached cross-site at all. It is here for what that does
 * not cover: browsers that ignore SameSite, and any future need to relax it.
 */
export function requireCsrf(req: Request, _res: Response, next: NextFunction): void {
  const cookie = req.cookies?.[CSRF_COOKIE_NAME] as string | undefined;
  const header = req.get(CSRF_HEADER_NAME);

  // Neither present: a session issued before this check existed. Waved through
  // so the change does not log every signed-in user out, and self-closing —
  // the response re-issues both cookies (setRefreshCookie always writes the
  // pair), so a session can only take this path once. It cannot be abused to
  // skip the check either: a victim who HAS the cookie sends it, landing on the
  // mismatch branch below, and an attacker cannot delete it from another origin.
  //
  // Safe to delete once every refresh token predating the change has expired
  // (REFRESH_TOKEN_EXPIRES_IN_DAYS after deploy).
  if (!cookie && !header) {
    next();
    return;
  }

  if (!cookie || !header || !timingSafeEqualStr(cookie, header)) {
    throw new ApiError(403, "Invalid CSRF token");
  }

  next();
}
