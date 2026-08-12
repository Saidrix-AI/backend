import { Router } from "express";
import { isTrialConfigured, trialDays } from "../config/entitlements.js";
import { isBillingEnabled } from "../config/env.js";

/**
 * Public deployment facts, for pages that render before anyone signs in.
 *
 * The landing page advertises the free trial, and it is the one surface with no
 * session to read it from. Hardcoding "1-day free trial" into that markup would
 * make the claim true only on deployments that happen to have the trial variant
 * configured — an advert for something the checkout would then refuse to sell.
 * This endpoint is how the public copy stays tied to what the server can
 * actually do.
 *
 * Deliberately unauthenticated, and deliberately tiny: it exposes only what we
 * are about to print on a public page anyway. No variant ids, no keys, nothing
 * about any account.
 */
export const configRouter = Router();

configRouter.get("/", (_req, res) => {
  res.json({
    success: true,
    data: {
      // Both halves matter. Without billing keys there is no checkout at all,
      // and with TRIAL_DAYS at zero there is no trial to sell.
      trialAvailable: isBillingEnabled() && isTrialConfigured(),
      trialDays: trialDays(),
      // Offered on Basic MONTHLY only. The Basic yearly variant carries the
      // same trial in the dashboard, but checkout skips it there — a trial on
      // yearly would attempt roughly twelve times the charge on day two. The
      // public copy has to name the plan it applies to, or it promises
      // something broader than what is actually sold.
      trialPlan: "basic",
    },
  });
});
