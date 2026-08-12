import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import * as contactController from "../controller/contact.controller.js";
import { optionalAuth } from "../middleware/auth.middleware.js";
import { validateBody } from "../middleware/validate.middleware.js";

/**
 * The contact forms.
 *
 * Public: the landing page's form is the main caller and there is no session
 * there. `optionalAuth` means a signed-in sender is still identified from their
 * token rather than from what the form posted — see the controller.
 *
 * Note what the schema does NOT accept: any kind of recipient. The destination
 * is `CONTACT_INBOX`, resolved server-side, so there is no field here that could
 * redirect where the mail goes.
 */
export const contactRouter = Router();

const contactSchema = z.object({
  name: z.string().trim().min(1, "Please tell us your name").max(100),
  email: z.string().trim().email("That does not look like an email address").max(200),
  subject: z.string().trim().min(1, "Please add a subject").max(150),
  message: z.string().trim().min(10, "Please write a little more").max(2000),
  category: z.enum(["general", "technical", "billing", "account", "other"]).optional(),
});

/**
 * Sending mail costs money and reputation, and this route needs no account, so
 * it is the most abusable surface in the API. Capped hard per IP — a real
 * person does not send five support requests an hour.
 */
const contactLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many messages sent. Please try again later, or email us directly.",
  },
  skip: () => process.env.NODE_ENV === "test",
});

contactRouter.post(
  "/",
  contactLimiter,
  optionalAuth,
  validateBody(contactSchema),
  contactController.submit,
);
