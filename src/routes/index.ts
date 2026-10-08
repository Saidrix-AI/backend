import { Router } from "express";
import { assessmentRouter } from "./assessment.routes.js";
import { intakeRouter } from "./intake.routes.js";
import { authRouter } from "./auth.routes.js";
import { billingRouter } from "./billing.routes.js";
import { chatRouter } from "./chat.routes.js";
import { configRouter } from "./config.routes.js";
import { contactRouter } from "./contact.routes.js";
import { routineRouter } from "./routine.routes.js";
import { userRouter } from "./user.routes.js";
import { progressRouter, voiceAgentProgressRouter } from "./progress.routes.js";
import { courseRouter } from "./course.routes.js";
import { projectRouter } from "./project.routes.js";
import { lectureRouter, voiceAgentLectureRouter } from "./lecture.routes.js";
import { runnerRouter } from "./runner.routes.js";
import { voiceRouter } from "./voice.routes.js";
import { requireAuth, requireAuthOrVoiceAgent } from "../middleware/auth.middleware.js";
import { requireActivePlan } from "../middleware/subscription.middleware.js";

export const apiRouter = Router();

// --- Open to everyone, signed in or not ----------------------------------
// The landing page renders before anyone has an account, and it advertises the
// free trial. This is where it learns whether this deployment actually has one
// to sell. Nothing account-specific is served here.
apiRouter.use("/config", configRouter);
// The contact forms. The landing page's has no session, so this cannot require
// one — it identifies a signed-in sender when it can and treats the form fields
// as untrusted either way. See contact.routes.ts.
apiRouter.use("/contact", contactRouter);

// --- Open to any authenticated account, plan or no plan -------------------
// Signing in, reading your own profile, and paying must all keep working after
// a subscription lapses — otherwise the only way back in is unreachable.
// (`/billing/webhook` is not here; it is mounted in app.ts, ahead of the JSON
// parser, because it needs the raw bytes to verify its signature.)
apiRouter.use("/auth", authRouter);
apiRouter.use("/billing", billingRouter);
apiRouter.use("/user", userRouter);

// --- Behind the paywall ---------------------------------------------------
// `requireAuth` is repeated here because the plan check needs `req.user`, and
// it must answer 401 (not 402) for a request that was never signed in. Each of
// these routers still calls `requireAuth` itself — verifying the same JWT twice
// costs nothing and keeps every router safe to mount anywhere.
const paid = [requireAuth, requireActivePlan];

// --- The voice agent's allowlist ------------------------------------------
// Mounted BEFORE the routers below, because these are the only routes that may
// be reached with a voice-agent service token. They bring their own auth
// middleware (`requireAuthOrVoiceAgent`) rather than the `paid` stack, whose
// `requireAuth` rejects an agent token by design.
//
// A request that matches nothing here simply falls through to the user-only
// router for the same prefix — so forgetting to think about the agent leaves a
// new route closed to it, rather than open.
apiRouter.use("/lectures", requireAuthOrVoiceAgent, requireActivePlan, voiceAgentLectureRouter);
apiRouter.use("/progress", requireAuthOrVoiceAgent, requireActivePlan, voiceAgentProgressRouter);

apiRouter.use("/chat", paid, chatRouter);
apiRouter.use("/routine", paid, routineRouter);
apiRouter.use("/progress", paid, progressRouter);
apiRouter.use("/courses", paid, courseRouter);
apiRouter.use("/projects", paid, projectRouter);
apiRouter.use("/lectures", paid, lectureRouter);
apiRouter.use("/voice", paid, voiceRouter);
// Compiles and runs the classroom's non-browser languages. Behind the paywall
// like everything else it serves, and rate-limited per user inside the router.
apiRouter.use("/run", paid, runnerRouter);
apiRouter.use("/assessments", paid, assessmentRouter);
apiRouter.use("/intake", paid, intakeRouter);
