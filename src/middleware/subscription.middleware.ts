import type { NextFunction, Request, Response } from "express";
import { isBillingEnabled } from "../config/env.js";
import { UserModel } from "../database/models/user.model.js";
import { appOpenFor, effectiveStatus } from "../services/subscription.service.js";
import { ApiError } from "../utils/apiError.js";

/**
 * The paywall.
 *
 * There is no free tier, so every feature router behind this one is closed
 * until a subscription is paying for it. Nothing is deleted when a plan lapses
 * — the student's courses, progress and lectures all survive untouched, and
 * subscribing again reopens them exactly where they were.
 *
 * Deliberately NOT applied to `/api/auth`, `/api/user` or `/api/billing`: a
 * lapsed account still has to be able to sign in, see its profile, and pay.
 *
 * This is the real gate. `RequirePlan` on the client only decides which page to
 * render — it can be bypassed by anyone with a console, and the API cannot.
 *
 * Runs after `requireAuth`, which is what puts `req.user` in place.
 */
export async function requireActivePlan(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  // Without LemonSqueezy keys there is no way to buy a plan, so charging for
  // one would lock every account out of an app nobody can pay for. Local
  // development and CI both run in this state. Checked here as well as inside
  // `appOpenFor` so the request skips the user lookup entirely.
  if (!isBillingEnabled()) {
    next();
    return;
  }

  if (!req.user) {
    next(new ApiError(401, "Authentication required"));
    return;
  }

  const user = await UserModel.findById(req.user.id).select("planStatus planExpiresAt").lean();
  if (!user) {
    next(new ApiError(401, "Authentication required"));
    return;
  }

  if (appOpenFor(user)) {
    next();
    return;
  }

  // 402 rather than 403: the request is well-formed and the caller is who they
  // say they are — the only thing missing is payment. The client keys off this
  // status, and off the code below, to pick which page to send them to (see
  // lib/http.js).
  const status = effectiveStatus(user);

  // A trial whose charge failed is held apart from an ordinary lapse: it has a
  // plan and a subscription that has never worked, so "renew your subscription"
  // is the wrong instruction. It belongs on /complete-payment.
  if (status === "payment_required") {
    next(
      new ApiError(
        402,
        "Your payment did not go through. Complete it to get back into your account.",
        "payment_required",
      ),
    );
    return;
  }

  next(
    new ApiError(
      402,
      status === "none"
        ? "Choose a plan to start learning with Saidrix."
        : "Your subscription has ended. Renew it to pick up where you left off.",
      "subscription_required",
    ),
  );
}
