import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import { corsOrigins, env } from "./config/env.js";
import * as billingController from "./controller/billing.controller.js";
import { errorHandler, notFoundHandler } from "./middleware/error.middleware.js";
import { apiRouter } from "./routes/index.js";
import { logger } from "./utils/logger.js";

export const app = express();

// Trust exactly as many proxy hops as the deploy actually has (env-driven), so
// req.ip / secure cookies work without letting clients spoof X-Forwarded-For.
app.set("trust proxy", env.TRUST_PROXY);

app.use(
  helmet({
    // HSTS only meaningful over HTTPS; enable in production.
    hsts: env.NODE_ENV === "production" ? { maxAge: 15552000, includeSubDomains: true } : false,
    // This API serves JSON, not documents, so the policy is as close to "nothing
    // may load or execute" as a CSP goes. It matters because error pages and any
    // future HTML response inherit it, and because the header costs nothing.
    //
    // The frontend is a separate origin with its own policy; see
    // frontend/index.html, which has to allow the inline styles Shiki and KaTeX
    // emit while still blocking script from anywhere but itself.
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'none'"],
      },
    },
    // The API is called cross-origin by the frontend; the default `same-origin`
    // would have the browser refuse to hand back the response body.
    crossOriginResourcePolicy: { policy: "cross-origin" },
  }),
);
app.use(
  cors({
    origin: corsOrigins,
    credentials: true,
  }),
);
app.use(cookieParser());

// The LemonSqueezy webhook, mounted before everything below it for two reasons:
// its HMAC covers the exact bytes sent, so a JSON parser must never touch the
// body first, and a legitimate burst of billing events must not be turned away
// by the per-IP API rate limiter. It authenticates on the signature alone —
// there is no session behind it.
app.post(
  "/api/billing/webhook",
  express.raw({ type: "application/json", limit: "1mb" }),
  billingController.webhook,
);

// Body-size limits: only the chat routes accept large base64 attachments; every
// other route (auth, etc.) is capped tight to limit DoS amplification.
const jsonSmall = express.json({ limit: "1mb" });
const jsonLarge = express.json({ limit: "20mb" });
// The whiteboard snapshot the voice agent saves: up to 2000 elements, the
// student's ink strokes included (board.service.ts caps elements at ~3MB).
const jsonBoard = express.json({ limit: "4mb" });
const BOARD_SAVE = /^\/api\/lectures\/[^/]+\/board$/;
app.use((req, res, next) =>
  (req.path.startsWith("/api/chat") ? jsonLarge : BOARD_SAVE.test(req.path) ? jsonBoard : jsonSmall)(
    req,
    res,
    next,
  ),
);

if (process.env.NODE_ENV !== "test") {
  app.use(
    pinoHttp({
      logger,
      // Log a compact one-liner per request. Drop the full header/cookie dump —
      // it was noisy AND leaked refresh/access tokens into the logs.
      serializers: {
        req: (req) => ({ method: req.method, url: req.url }),
        res: (res) => ({ statusCode: res.statusCode }),
      },
      customSuccessMessage: (req, res, responseTime) =>
        `${req.method} ${req.url} ${res.statusCode} (${responseTime}ms)`,
      customErrorMessage: (req, res) => `${req.method} ${req.url} ${res.statusCode}`,
      // Skip health-check spam.
      autoLogging: { ignore: (req) => req.url === "/health" },
    }),
  );
}

app.get("/", (_req, res) => {
  res.json({
    success: true,
    name: "Saidrix AI Tutor API",
    endpoints: {
      health: "GET /health",
      register: "POST /api/auth/register",
      login: "POST /api/auth/login",
      refresh: "POST /api/auth/refresh",
      logout: "POST /api/auth/logout",
      verifyEmail: "POST /api/auth/verify-email (Bearer)",
      forgotPassword: "POST /api/auth/forgot-password",
      checkResetToken: "GET /api/auth/reset-password/check?token=",
      resetPassword: "POST /api/auth/reset-password",
      me: "GET /api/auth/me (Bearer)",
      chat: "POST /api/chat (Bearer token)",
    },
  });
});

app.get("/health", (_req, res) => {
  res.json({ success: true, status: "ok" });
});

/**
 * The blanket per-IP limit for the whole API.
 *
 * Sized against what one PAGE costs, not what one action costs: the dashboard
 * alone opens six requests on mount, and the other pages four to seven, so 60
 * a minute was about eight navigations — a rate ordinary browsing passes
 * without trying. Switching pages quickly spent the budget and the 429s that
 * followed surfaced as half-loaded screens. React's StrictMode double-invokes
 * effects in development, doubling the cost again while working on the app.
 *
 * It is also per IP, and an office, campus or mobile-CGNAT egress address is
 * shared by many students who would otherwise eat each other's allowance.
 *
 * 300 leaves the ceiling far above real use while still capping a runaway
 * client or a crude scraper. The endpoints worth protecting properly have
 * their own much tighter limiters (auth, checkout, sync, username lookup) —
 * this one is a backstop, not the control.
 */
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 300,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === "test",
  message: { success: false, message: "Too many requests. Please slow down." },
});

app.use("/api", apiLimiter, apiRouter);

app.use(notFoundHandler);
app.use(errorHandler);
