import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import * as billingController from "../controller/billing.controller.js";
import { BILLING_PERIODS } from "../config/entitlements.js";
import { PLAN_IDS } from "../config/plans.js";
import { requireAuth } from "../middleware/auth.middleware.js";
import { validateBody } from "../middleware/validate.middleware.js";

/**
 * The billing API.
 *
 * Deliberately NOT behind `requireActivePlan`: someone whose subscription
 * lapsed has to be able to reach the page that lets them pay again.
 *
 * The webhook is not here — it is mounted straight onto the app in app.ts,
 * ahead of the body parser, because it needs the raw request bytes.
 */
export const billingRouter = Router();

const checkoutSchema = z.object({
  plan: z.enum(PLAN_IDS),
  billing: z.enum(BILLING_PERIODS),
});

// These two are the only routes that call LemonSqueezy on a user's behalf, and
// LemonSqueezy allows 300 calls a minute across the whole store. Capped per IP
// so one account cannot spend the store's budget.
const checkoutLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { success: false, message: "Too many checkout attempts. Please try again later." },
  skip: () => process.env.NODE_ENV === "test",
});

const syncLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 20,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { success: false, message: "Too many refresh attempts. Please try again later." },
  skip: () => process.env.NODE_ENV === "test",
});

billingRouter.use(requireAuth);

billingRouter.post(
  "/checkout",
  checkoutLimiter,
  validateBody(checkoutSchema),
  billingController.checkout,
);
billingRouter.get("/subscription", billingController.subscription);
billingRouter.post("/sync", syncLimiter, billingController.sync);
billingRouter.get("/portal", billingController.portal);
billingRouter.get("/invoices", billingController.invoices);
