import type { NextFunction, Request, Response } from "express";
import { ApiError } from "../utils/apiError.js";
import { verifyAccessToken, verifyVoiceAgentToken } from "../services/token.service.js";

export interface AuthUser {
  id: string;
  email: string;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
      /**
       * Which credential proved this request. "user" is a real login; the voice
       * agent signs its own tokens and is deliberately confined to the routes
       * that opt in via `requireAuthOrVoiceAgent`.
       */
      authKind?: "user" | "voice-agent";
    }
  }
}

function bearer(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length);
}

/** Requires a valid Bearer access token from a real login. Attaches `req.user`. */
export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const token = bearer(req);
  if (!token) {
    next(new ApiError(401, "Authentication required"));
    return;
  }

  try {
    const payload = verifyAccessToken(token);
    req.user = { id: payload.sub, email: payload.email };
    req.authKind = "user";
    next();
  } catch {
    next(new ApiError(401, "Invalid or expired token"));
  }
}

/**
 * Attaches `req.user` when a valid login token is present, and does nothing at
 * all when one is not.
 *
 * For routes that are genuinely open but behave better when they know who is
 * calling — the contact form is the case it was written for: the landing page
 * posts to it with no session, while a signed-in sender should be identified
 * from their token rather than from form fields they could type anything into.
 *
 * Never rejects. A bad or expired token is treated exactly like no token, so a
 * stale session cannot lock someone out of a public route. That is only safe
 * because nothing behind this middleware is authorised by `req.user` — it is
 * used to enrich, not to permit. Anything that gates on identity must use
 * `requireAuth`.
 */
export function optionalAuth(req: Request, _res: Response, next: NextFunction): void {
  const token = bearer(req);
  if (!token) {
    next();
    return;
  }

  try {
    const payload = verifyAccessToken(token);
    req.user = { id: payload.sub, email: payload.email };
    req.authKind = "user";
  } catch {
    // Deliberately ignored — see above.
  }
  next();
}

/**
 * Accepts a login token OR a voice-agent service token.
 *
 * The voice agent runs as a separate process and has to read the lecture it is
 * narrating and check the student's progress back in, so it needs to call the
 * API as that student. It holds a signing key to do that — which makes the key
 * an "act as any user" credential, and therefore something to contain rather
 * than to spread.
 *
 * Containment is this allowlist: only the routes that mount THIS middleware
 * accept an agent token. `requireAuth` — everything else, including billing,
 * profile, courses and chat — rejects one outright, because the issuer is
 * pinned. So a compromised voice host can read and checkpoint lectures, and
 * nothing more.
 */
export function requireAuthOrVoiceAgent(req: Request, _res: Response, next: NextFunction): void {
  const token = bearer(req);
  if (!token) {
    next(new ApiError(401, "Authentication required"));
    return;
  }

  try {
    const payload = verifyAccessToken(token);
    req.user = { id: payload.sub, email: payload.email };
    req.authKind = "user";
    next();
    return;
  } catch {
    // Not a login token — fall through and try the service credential.
  }

  try {
    const payload = verifyVoiceAgentToken(token);
    req.user = { id: payload.sub, email: payload.email };
    req.authKind = "voice-agent";
    next();
  } catch {
    next(new ApiError(401, "Invalid or expired token"));
  }
}
