import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import * as runnerController from "../controller/runner.controller.js";
import { requireAuth } from "../middleware/auth.middleware.js";
import { validateBody } from "../middleware/validate.middleware.js";
import { MAX_SOURCE_CHARS, SUPPORTED_LANGUAGES } from "../services/codeRunner.service.js";

const runSchema = z.object({
  language: z.enum(SUPPORTED_LANGUAGES as [string, ...string[]]),
  source: z.string().min(1).max(MAX_SOURCE_CHARS),
  stdin: z.string().max(4000).optional(),
});

/**
 * Executing code costs real compute on someone else's machine, so this is
 * limited far harder than an ordinary read — and **per user**, not per IP.
 *
 * Per IP would be wrong in both directions here: a classroom or household
 * behind one address would throttle each other, while one account driving the
 * classroom from several tabs would not be counted together at all. The whole
 * point is to bound what a single account can spend.
 *
 * 20 a minute is generous for a lesson: the tutor runs its demo once, and a
 * student iterating on a fix runs every few seconds. It is nowhere near enough
 * to mine anything with.
 */
const runLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.id ?? req.ip ?? "anonymous",
  skip: () => process.env.NODE_ENV === "test",
  message: {
    success: false,
    message: "You're running code very quickly — give it a moment.",
  },
});

export const runnerRouter = Router();

runnerRouter.use(requireAuth);
// Which languages this deployment can actually run. The classroom asks before
// deciding whether to send a run remotely or refuse it, so the answer is not
// hard-coded in two places.
runnerRouter.get("/languages", runnerController.getLanguages);
runnerRouter.post("/", runLimiter, validateBody(runSchema), runnerController.run);
