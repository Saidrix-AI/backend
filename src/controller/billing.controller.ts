import crypto from "node:crypto";
import type { Request, Response } from "express";
import { env, isBillingEnabled } from "../config/env.js";
import {
  hasAllVariants,
  isBillingPeriod,
  variantFor,
  type BillingPeriod,
} from "../config/entitlements.js";
import { isPlanId, type PlanId } from "../config/plans.js";
import { InvoiceModel } from "../database/models/invoice.model.js";
import { SubscriptionModel } from "../database/models/subscription.model.js";
import { UserModel } from "../database/models/user.model.js";
import { WebhookEventModel } from "../database/models/webhookEvent.model.js";
import * as ls from "../services/lemonSqueezy.client.js";
import * as subscriptions from "../services/subscription.service.js";
import { courseUsage } from "../services/quota.service.js";
import { ApiError } from "../utils/apiError.js";
import { sha256 } from "../utils/crypto.js";
import { logger } from "../utils/logger.js";

// ---------------------------------------------------------------------------
// Webhook
// ---------------------------------------------------------------------------

/** The shape LemonSqueezy posts. Only the parts we read are named. */
interface WebhookBody {
  meta?: { event_name?: string; custom_data?: Record<string, unknown> };
  data?: { id?: string; type?: string; attributes?: Record<string, unknown> };
}

/**
 * Constant-time signature comparison.
 *
 * `timingSafeEqual` THROWS on buffers of different lengths, so the length check
 * is not an optimisation — without it a short or absent signature crashes the
 * handler instead of being rejected. (The snippet in LemonSqueezy's own docs
 * omits this.) Comparing lengths first leaks only the length, which is fixed
 * for a hex sha256 digest anyway.
 */
function signatureMatches(rawBody: Buffer, signature: string, secret: string): boolean {
  const digest = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  if (signature.length !== digest.length) return false;
  return crypto.timingSafeEqual(Buffer.from(digest, "utf8"), Buffer.from(signature, "utf8"));
}

/**
 * The subscription lifecycle events. All of them carry a full Subscription
 * object, so one handler covers the lot — LemonSqueezy's own guidance is that
 * `subscription_updated` fires alongside every other lifecycle event and can be
 * treated as the catch-all.
 */
const SUBSCRIPTION_EVENTS = new Set([
  "subscription_created",
  "subscription_updated",
  "subscription_cancelled",
  "subscription_resumed",
  "subscription_expired",
  "subscription_paused",
  "subscription_unpaused",
]);

const INVOICE_EVENTS = new Set([
  "subscription_payment_success",
  "subscription_payment_failed",
  "subscription_payment_recovered",
  "subscription_payment_refunded",
]);

/**
 * The billing webhook.
 *
 * Mounted on the app directly, ahead of the JSON body parser and the API rate
 * limiter (see app.ts): it needs the untouched request bytes to verify the
 * HMAC, and a burst of legitimate events must never be throttled.
 *
 * Answers 200 for anything it understood, including events it deliberately
 * ignores — LemonSqueezy retries three times with exponential backoff on any
 * other status, so a non-2xx is reserved for "try me again", never for "not
 * interested".
 */
export async function webhook(req: Request, res: Response): Promise<void> {
  const secret = env.LEMONSQUEEZY_WEBHOOK_SECRET;
  if (!secret) {
    logger.error("[billing] webhook received but LEMONSQUEEZY_WEBHOOK_SECRET is unset");
    res.status(503).json({ success: false, message: "Billing is not configured." });
    return;
  }

  // express.raw leaves a Buffer here. Anything else means the route was mounted
  // after a body parser, which would have already destroyed the bytes the
  // signature covers — fail loudly rather than verifying a re-serialised body.
  const rawBody = req.body;
  if (!Buffer.isBuffer(rawBody)) {
    logger.error("[billing] webhook body is not raw — check middleware order in app.ts");
    res.status(500).json({ success: false, message: "Webhook misconfigured." });
    return;
  }

  const signature = req.get("X-Signature") ?? "";
  if (!signature || !signatureMatches(rawBody, signature, secret)) {
    logger.warn({ ip: req.ip }, "[billing] webhook signature rejected");
    res.status(401).json({ success: false, message: "Invalid signature." });
    return;
  }

  let body: WebhookBody;
  try {
    body = JSON.parse(rawBody.toString("utf8")) as WebhookBody;
  } catch {
    res.status(400).json({ success: false, message: "Malformed JSON body." });
    return;
  }

  const eventName = body.meta?.event_name ?? req.get("X-Event-Name") ?? "";
  const objectId = String(body.data?.id ?? "");
  const updatedAt = String(body.data?.attributes?.updated_at ?? "");

  // LemonSqueezy sends no webhook id, so the key is composed from what does
  // identify one delivery: the event, the object, and the version of that
  // object. A retry of the same delivery repeats all three.
  //
  // Not every event type carries `updated_at` (order_refunded does not). Those
  // would all collapse to the same `event:object:` key, so a second, genuinely
  // different delivery for that object — a manual re-fire from the dashboard —
  // would be silently swallowed as a duplicate. Hashing the body instead is
  // exact for this purpose: a real retry resends identical bytes, a new
  // delivery does not.
  const eventKey = updatedAt
    ? `${eventName}:${objectId}:${updatedAt}`
    : `${eventName}:${objectId}:sha256=${sha256(rawBody.toString("utf8"))}`;

  try {
    await WebhookEventModel.create({ eventKey, eventName, objectId });
  } catch (err) {
    if ((err as { code?: number })?.code === 11000) {
      // Already applied. This is the normal outcome of a retry.
      res.json({ success: true, data: { duplicate: true } });
      return;
    }
    throw err;
  }

  const customUserId =
    typeof body.meta?.custom_data?.user_id === "string"
      ? body.meta.custom_data.user_id
      : body.meta?.custom_data?.user_id !== undefined
        ? String(body.meta.custom_data.user_id)
        : undefined;

  try {
    if (SUBSCRIPTION_EVENTS.has(eventName)) {
      const result = await subscriptions.applySubscriptionState(
        { type: "subscriptions", id: objectId, attributes: body.data?.attributes ?? {} },
        customUserId,
      );
      res.json({ success: true, data: { applied: result.applied, reason: result.reason } });
      return;
    }

    if (INVOICE_EVENTS.has(eventName)) {
      const result = await subscriptions.recordInvoice(
        { id: objectId, attributes: (body.data?.attributes ?? {}) as never },
        customUserId,
      );
      if (!result.applied && result.reason === "subscription_not_yet_known") {
        // The payment arrived before the subscription it belongs to. Drop the
        // idempotency row so the retry is allowed to do real work, and ask for
        // that retry — by then `subscription_created` will have landed.
        await WebhookEventModel.deleteOne({ eventKey });
        res.status(503).json({ success: false, message: "Subscription not yet known; retry." });
        return;
      }
      res.json({ success: true, data: { applied: result.applied, reason: result.reason } });
      return;
    }

    if (eventName === "order_refunded") {
      // The order object carries no invoice id, so the subscription's invoices
      // are matched by order instead.
      const orderId = String(body.data?.id ?? "");
      const sub = await SubscriptionModel.findOne({ orderId }).select("_id userId").lean();
      if (sub) {
        await InvoiceModel.updateMany(
          { userId: sub.userId, billingReason: "initial" },
          { $set: { status: "refunded" } },
        );
        // Access is revoked here rather than left to wait for LemonSqueezy's
        // separate cancellation/expiry event: a refund is unambiguous, and if
        // that later event is delayed or dropped, a refunded user would
        // otherwise keep full paid access with nothing prompting them to
        // notice (the manual /billing/sync escape hatch is not self-triggering).
        //
        // `lsUpdatedAt` is cleared along with it, and that part is load-bearing.
        // This writes a status LemonSqueezy never sent, so leaving the timestamp
        // at the last real event would make the row look current: every live
        // read of equal-or-older vintage would be dropped as stale and `sync`
        // could never correct it. A refund that does NOT cancel the subscription
        // — goodwill, or partial — would strand the customer with no way back.
        // Nulling it puts the row on the staleness filter's `lsUpdatedAt: null`
        // branch, so the next event or sync always wins.
        await SubscriptionModel.updateOne(
          { _id: sub._id },
          { $set: { status: "expired", lsUpdatedAt: null } },
        );
        await UserModel.updateOne(
          { _id: sub.userId },
          { $set: { planStatus: "lapsed", planExpiresAt: null } },
        );
      }
      res.json({ success: true, data: { applied: Boolean(sub) } });
      return;
    }

    // Understood, not acted on (order_created, customer_updated, license_*).
    res.json({ success: true, data: { ignored: eventName } });
  } catch (err) {
    // Let LemonSqueezy retry a transient failure, but do not leave the
    // idempotency row behind or the retry would be swallowed as a duplicate.
    await WebhookEventModel.deleteOne({ eventKey }).catch(() => undefined);
    logger.error({ eventName, err }, "[billing] webhook handler failed");
    res.status(500).json({ success: false, message: "Webhook processing failed." });
  }
}

// ---------------------------------------------------------------------------
// Authenticated billing API
// ---------------------------------------------------------------------------

/**
 * How long one checkout reserves the account for.
 *
 * Long enough to swallow a double-click, a two-tab submit or a replayed
 * request; short enough that someone who genuinely wants a different tier is
 * not left staring at an error.
 */
const CHECKOUT_LOCK_MS = 15_000;

export async function checkout(req: Request, res: Response): Promise<void> {
  if (!isBillingEnabled() || !hasAllVariants()) {
    throw new ApiError(503, "Payments are not available right now. Please try again later.");
  }

  const { plan, billing } = req.body as { plan: PlanId; billing: BillingPeriod };
  if (!isPlanId(plan) || !isBillingPeriod(billing)) {
    throw new ApiError(400, "Unknown plan or billing period.");
  }

  // A second checkout would create a second subscription and bill twice.
  // Existing subscribers change tier in the customer portal, where LemonSqueezy
  // handles the proration.
  const state = await subscriptions.getBillingState(req.user!.id);
  if (state.subscription && state.planStatus !== "lapsed" && state.planStatus !== "none") {
    res.status(409).json({
      success: false,
      message: "You already have a subscription. Manage or change it from the billing portal.",
      code: "subscription_exists",
    });
    return;
  }

  // Claim a short-lived reservation atomically: the read above and the checkout
  // creation below are not otherwise one operation, so two requests racing
  // between them would both pass the check and both mint a real charge. Only
  // the request that flips an unset/expired lock wins; the loser is told to
  // retry rather than being allowed to check out too.
  const now = new Date();
  const reserved = await UserModel.findOneAndUpdate(
    {
      _id: req.user!.id,
      $or: [{ checkoutLockedUntil: null }, { checkoutLockedUntil: { $lt: now } }],
    },
    { $set: { checkoutLockedUntil: new Date(now.getTime() + CHECKOUT_LOCK_MS) } },
    { new: true },
  );
  if (!reserved) {
    res.status(409).json({
      success: false,
      message: "A checkout is already in progress. Please wait a moment and try again.",
      code: "checkout_in_progress",
    });
    return;
  }

  let created = false;
  try {
    const variantId = variantFor(plan, billing);
    if (!variantId) throw new ApiError(503, "That plan is not available for purchase right now.");

    const user = await UserModel.findById(req.user!.id).select("name email").lean();
    if (!user) throw new ApiError(404, "Account not found");

    const url = await ls.createCheckout({
      variantId,
      userId: req.user!.id,
      email: user.email,
      name: user.name,
      redirectUrl: `${env.APP_URL.replace(/\/$/, "")}/account/plans?checkout=success`,
    });

    created = true;
    res.json({ success: true, data: { url } });
  } finally {
    // Released ONLY when nothing chargeable was created, so a failed attempt
    // does not force the user to wait out the window.
    //
    // After a success the reservation is deliberately left to expire. Clearing
    // it here reopens the exact gap it exists to close: the "do you already
    // have a subscription?" check above cannot see a checkout that has been
    // handed out but not yet paid, so a second request arriving just after the
    // first finished sails through it and mints another chargeable link. Only
    // holding the reservation past the response covers that — a window, not an
    // overlap, is what has to be guarded.
    if (!created) {
      await UserModel.updateOne({ _id: req.user!.id }, { $set: { checkoutLockedUntil: null } });
    }
  }
}

export async function subscription(req: Request, res: Response): Promise<void> {
  const state = await subscriptions.getBillingState(req.user!.id);
  const usage = await courseUsage(req.user!.id);
  res.json({ success: true, data: { ...state, usage } });
}

/** Re-reads the live state from LemonSqueezy. The dropped-webhook escape hatch. */
export async function sync(req: Request, res: Response): Promise<void> {
  if (!isBillingEnabled()) throw new ApiError(503, "Billing is not configured on this server.");
  const result = await subscriptions.reconcile(req.user!.id);
  const state = await subscriptions.getBillingState(req.user!.id);
  const usage = await courseUsage(req.user!.id);
  res.json({ success: true, data: { ...state, usage, synced: result.applied } });
}

/**
 * A freshly signed customer-portal link.
 *
 * Requested on click rather than served from the cached copy because the signed
 * URL only lives 24 hours — a stale one drops the customer on a login form.
 */
export async function portal(req: Request, res: Response): Promise<void> {
  const sub = await SubscriptionModel.findOne({ userId: req.user!.id })
    .select("lemonSqueezyId customerPortalUrl updatePaymentMethodUrl")
    .lean();
  if (!sub) throw new ApiError(404, "You do not have a subscription yet.");

  try {
    const live = await ls.getSubscription(sub.lemonSqueezyId);
    const urls = live.attributes?.urls ?? {};
    // Refresh the cache while we have them.
    await SubscriptionModel.updateOne(
      { _id: sub._id },
      {
        $set: {
          customerPortalUrl: urls.customer_portal ?? "",
          updatePaymentMethodUrl: urls.update_payment_method ?? "",
        },
      },
    );
    res.json({
      success: true,
      data: {
        portalUrl: urls.customer_portal ?? "",
        updatePaymentMethodUrl: urls.update_payment_method ?? "",
      },
    });
  } catch (err) {
    // Their API being down should not hide the billing page: the cached link
    // may still be inside its 24 hours.
    logger.warn({ err }, "[billing] portal refresh failed; serving the cached link");
    if (!sub.customerPortalUrl) throw err;
    res.json({
      success: true,
      data: {
        portalUrl: sub.customerPortalUrl,
        updatePaymentMethodUrl: sub.updatePaymentMethodUrl,
        stale: true,
      },
    });
  }
}

export async function invoices(req: Request, res: Response): Promise<void> {
  const limit = Math.min(Number(req.query.limit) || 25, 100);
  const rows = await InvoiceModel.find({ userId: req.user!.id })
    .sort({ createdAtLS: -1 })
    .limit(limit)
    .lean();

  res.json({
    success: true,
    data: {
      invoices: rows.map((inv) => ({
        id: String(inv._id),
        number: inv.lemonSqueezyInvoiceId,
        date: inv.createdAtLS.toISOString(),
        plan: inv.plan,
        billing: inv.billing,
        status: inv.status,
        currency: inv.currency,
        subtotal: inv.subtotal,
        tax: inv.tax,
        total: inv.total,
        totalFormatted: inv.totalFormatted,
        cardBrand: inv.cardBrand,
        cardLastFour: inv.cardLastFour,
        receiptUrl: inv.receiptUrl,
        billingReason: inv.billingReason,
      })),
    },
  });
}
