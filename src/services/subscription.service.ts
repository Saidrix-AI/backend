import { Types } from "mongoose";
import { env, isBillingEnabled } from "../config/env.js";
import {
  entitlementsFor,
  isTrialConfigured,
  planForVariant,
  type Entitlements,
} from "../config/entitlements.js";
import type { PlanId } from "../config/plans.js";
import { InvoiceModel } from "../database/models/invoice.model.js";
import {
  SubscriptionModel,
  type LsSubscriptionStatus,
} from "../database/models/subscription.model.js";
import { UserModel } from "../database/models/user.model.js";
import { ApiError } from "../utils/apiError.js";
import { logger } from "../utils/logger.js";
import * as ls from "./lemonSqueezy.client.js";

/**
 * Everything the app knows about who has paid.
 *
 * This module is the ONLY writer of `Subscription`, of the `plan` /
 * `planStatus` / `planExpiresAt` mirror on the user, and of `Invoice`. Every
 * path into it starts from data LemonSqueezy signed (a verified webhook) or
 * data read straight back from their API — never from anything a browser sent.
 */

export type PlanStatus = "none" | "active" | "grace" | "payment_required" | "lapsed";

/**
 * Does this status still open the app?
 *
 *   on_trial / active      paying, obviously open
 *   past_due               a renewal failed and is being retried for ~2 weeks.
 *                          Open IF they have paid before: locking someone out
 *                          mid-retry punishes an expired card, and LemonSqueezy
 *                          moves them to `unpaid` when the retries run out.
 *   cancelled              future payments stopped, but the period they already
 *                          paid for is still running — open until `ends_at`.
 *   paused (mode "free")   we chose to keep serving them without charging.
 *   paused (mode "void")   collection stopped and invoices voided — closed.
 *   unpaid / expired       closed.
 *
 * `everPaid` is what the 1-day trial made necessary. The retry grace above is
 * generous on purpose, and it was safe to be that generous while every
 * subscription began with a real payment. A trial breaks that: a student whose
 * very first charge fails would otherwise be handed the full retry window, so
 * a 1-day free trial becomes a fortnight of free access for anyone willing to
 * let the charge fail on purpose.
 *
 * So retry grace is for customers who have actually paid us. A subscription
 * that has never collected a penny and cannot collect one now is
 * `payment_required` — closed, and pointed at a page that says why.
 */
export function accessFor(
  status: LsSubscriptionStatus | null | undefined,
  endsAt: Date | null | undefined,
  pauseMode = "",
  everPaid = false,
): PlanStatus {
  switch (status) {
    case "on_trial":
    case "active":
      return "active";
    case "past_due":
      return everPaid ? "active" : "payment_required";
    case "unpaid":
      // Retries exhausted. A proven payer is simply lapsed and belongs on the
      // billing page; a trial that never paid is held on /complete-payment.
      return everPaid ? "lapsed" : "payment_required";
    case "paused":
      return pauseMode === "free" ? "active" : "lapsed";
    case "cancelled":
      // The status alone is not trusted: `subscription_expired` can be missed,
      // and without this check a cancelled account would stay open forever.
      return endsAt && endsAt.getTime() > Date.now() ? "grace" : "lapsed";
    default:
      return "lapsed";
  }
}

/**
 * Whether this deployment can offer a free trial to this account.
 *
 * A display hint and a checkout decision, never an access decision. Both halves
 * matter: `trialConsumedAt` is one-way, so nobody gets a second trial, and with
 * `TRIAL_DAYS` at zero there is no trial to sell in the first place.
 */
export function isTrialAvailableFor(user: { trialConsumedAt?: Date | null }): boolean {
  return isBillingEnabled() && isTrialConfigured() && !user.trialConsumedAt;
}

/** Whether a mirrored plan state opens the app. The paywall's whole question. */
export function hasAccess(user: {
  planStatus?: PlanStatus | null;
  planExpiresAt?: Date | null;
}): boolean {
  if (user.planStatus === "active") return true;
  if (user.planStatus === "grace") {
    // Re-checked at read time so a grace period ends on schedule even if the
    // expiry webhook never arrives.
    return Boolean(user.planExpiresAt && user.planExpiresAt.getTime() > Date.now());
  }
  return false;
}

/**
 * Is the app open to this account RIGHT NOW, on this deployment?
 *
 * The single answer the paywall, the session payload and the billing page all
 * read, so the client's route guard can never disagree with what the server
 * would allow. It differs from `hasAccess` in one way that matters: with no
 * LemonSqueezy keys there is no way to buy a plan, so charging for one would
 * lock every account out of an app nobody can pay for. Local development and CI
 * both run in that state — and the client has to see it too, or it would bounce
 * everyone to a pricing page whose buttons cannot work.
 */
export function appOpenFor(user: {
  planStatus?: PlanStatus | null;
  planExpiresAt?: Date | null;
}): boolean {
  return isBillingEnabled() ? hasAccess(user) : true;
}

/**
 * The stored status corrected for the passage of time.
 *
 * `grace` is stored with an end date; once that date passes the account is
 * lapsed whether or not the `subscription_expired` webhook ever arrived.
 *
 * `none` and `payment_required` are both preserved rather than collapsed into
 * `lapsed`, because all three lead to different pages — "choose a plan",
 * "your payment did not go through", "your plan ended". Collapsing
 * `payment_required` would defeat the entire reason it exists as a separate
 * status, since access-wise it is identical to `lapsed`.
 */
export function effectiveStatus(user: {
  planStatus?: PlanStatus | null;
  planExpiresAt?: Date | null;
}): PlanStatus {
  const stored = (user.planStatus ?? "none") as PlanStatus;
  if (stored === "none") return "none";
  if (stored === "payment_required") return "payment_required";
  return hasAccess(user) ? stored : "lapsed";
}

/**
 * The status to put on the session payload, which the client's route guard
 * reads to decide between the app and the pricing page.
 *
 * Reported as "active" on a deployment with billing switched off, because that
 * is what the server will actually enforce — anything else would have the
 * client blocking pages the API is happily serving.
 */
export function sessionStatus(user: {
  planStatus?: PlanStatus | null;
  planExpiresAt?: Date | null;
}): PlanStatus {
  if (!isBillingEnabled()) return "active";
  return effectiveStatus(user);
}

function toDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function str(value: string | number | null | undefined): string {
  return value === null || value === undefined ? "" : String(value);
}

export interface ApplyResult {
  applied: boolean;
  /** Why it was not applied — logged and, for `sync`, surfaced to the caller. */
  reason?: string;
  userId?: string;
  plan?: PlanId;
  planStatus?: PlanStatus;
}

/**
 * Resolves which account a LemonSqueezy subscription belongs to.
 *
 * `custom_data.user_id` is the reliable link — we set it when creating the
 * checkout, so it comes back inside the signed payload. The email fallback
 * exists for a purchase made directly on the LemonSqueezy storefront, which
 * carries no custom data at all; it is looked up case-insensitively because
 * emails are stored lowercased.
 */
async function resolveUserId(
  customUserId: string | undefined,
  email: string | undefined,
): Promise<string | null> {
  if (customUserId && Types.ObjectId.isValid(customUserId)) {
    const byId = await UserModel.findById(customUserId).select("_id").lean();
    if (byId) return String(byId._id);
    logger.warn({ customUserId }, "[billing] custom_data.user_id matched no account");
  }
  if (email) {
    const byEmail = await UserModel.findOne({ email: email.trim().toLowerCase() })
      .select("_id")
      .lean();
    if (byEmail) return String(byEmail._id);
  }
  return null;
}

/**
 * Writes one LemonSqueezy subscription into our database and updates the user's
 * mirrored plan fields.
 *
 * Idempotent and order-insensitive: applying the same event twice changes
 * nothing, and an event that is older than what is already stored is dropped.
 * That matters because retries use exponential backoff, so a delayed
 * `subscription_updated` carrying the pre-cancellation state can genuinely
 * arrive after the cancellation.
 */
export async function applySubscriptionState(
  subscription: ls.LsSubscription,
  customUserId?: string,
): Promise<ApplyResult> {
  const a = subscription.attributes ?? {};

  // A test-mode purchase costs nothing. Granting a real plan from one would
  // make every tier free to anyone who found a test checkout link.
  if (a.test_mode === true && !env.LEMONSQUEEZY_TEST_MODE) {
    logger.error(
      { subscriptionId: subscription.id },
      "[billing] refused a test-mode subscription on a live server",
    );
    return { applied: false, reason: "test_mode_on_live_server" };
  }

  const variant = planForVariant(a.variant_id);
  if (!variant) {
    // Never guess a tier. An unknown variant means a product we do not know
    // about, and picking one would grant a subscription nobody paid for.
    logger.error(
      { subscriptionId: subscription.id, variantId: str(a.variant_id) },
      "[billing] subscription for an unrecognised variant — no plan granted",
    );
    return { applied: false, reason: "unknown_variant" };
  }

  const userId = await resolveUserId(customUserId, a.user_email);
  if (!userId) {
    logger.error(
      { subscriptionId: subscription.id },
      "[billing] could not match a subscription to an account",
    );
    return { applied: false, reason: "no_matching_user" };
  }

  const lemonSqueezyId = str(subscription.id);
  const lsUpdatedAt = toDate(a.updated_at);

  const status = (a.status ?? "expired") as LsSubscriptionStatus;
  const endsAt = toDate(a.ends_at);
  const pauseMode = a.pause?.mode ?? "";

  const setFields = {
    lemonSqueezyId,
    customerId: str(a.customer_id),
    orderId: str(a.order_id),
    storeId: str(a.store_id),
    productId: str(a.product_id),
    variantId: str(a.variant_id),
    plan: variant.plan,
    billing: variant.billing,
    status,
    statusFormatted: a.status_formatted ?? "",
    cardBrand: a.card_brand ?? "",
    cardLastFour: a.card_last_four ?? "",
    renewsAt: toDate(a.renews_at),
    endsAt,
    trialEndsAt: toDate(a.trial_ends_at),
    pauseMode,
    pauseResumesAt: toDate(a.pause?.resumes_at),
    testMode: Boolean(a.test_mode),
    lsUpdatedAt,
    customerPortalUrl: a.urls?.customer_portal ?? "",
    updatePaymentMethodUrl: a.urls?.update_payment_method ?? "",
  };

  // The staleness check and the write used to be a separate read-then-write:
  // two webhooks for the same subscription landing close together (routine
  // with retries) could both read the same "not stale yet" snapshot and then
  // write in reverse order, letting an older event's state win. Folding the
  // condition into the update's own filter makes accept-or-reject atomic —
  // whichever request's write actually lands is guaranteed to have passed the
  // check against the row as it stood at that instant, not a stale read of it.
  //
  // Only meaningful against the SAME subscription: after cancelling and
  // re-subscribing, the new subscription legitimately has an older timestamp
  // than the row it replaces, so a different lemonSqueezyId always passes.
  const notStaleFilter = lsUpdatedAt
    ? {
        $or: [
          { lemonSqueezyId: { $ne: lemonSqueezyId } },
          { lsUpdatedAt: null },
          { lsUpdatedAt: { $lt: lsUpdatedAt } },
        ],
      }
    : {};
  const filter = { userId: new Types.ObjectId(userId), ...notStaleFilter };

  // Upsert, and retry once on a duplicate key.
  //
  // A duplicate key is ambiguous here, which is the whole reason for the loop.
  // The unique index on userId means the upsert's insert branch fails both when
  // this event is genuinely stale (a fresher row exists, so the filter misses
  // and Mongo tries to insert a second row for the user) AND when this is the
  // first event but a concurrent delivery inserted the row a moment earlier.
  // Retrying tells them apart without a read: the second time round the row
  // definitely exists, so the staleness filter alone decides, and a second
  // duplicate key can only mean "stale".
  //
  // That also gives the property this has to have — the newest event wins
  // whatever order the deliveries interleave in. Every write is conditional on
  // `stored < mine`, so the stored timestamp only ever moves forward; the
  // newest event can therefore never be the one that loses.
  let written = false;
  // The row as it stands after the write. Read back rather than re-queried
  // because `everPaid` is owned by recordInvoice, not by anything in this
  // payload — LemonSqueezy does not tell us in a subscription event whether it
  // has ever collected money.
  let stored: { everPaid?: boolean } | null = null;
  for (let attempt = 0; attempt < 2 && !written; attempt++) {
    try {
      stored = await SubscriptionModel.findOneAndUpdate(
        filter,
        { $set: setFields },
        { upsert: true, new: true },
      );
      written = true;
    } catch (err) {
      if ((err as { code?: number })?.code !== 11000) throw err;
    }
  }

  if (!written) {
    return { applied: false, reason: "stale_event", userId, plan: variant.plan };
  }

  const planStatus = accessFor(status, endsAt, pauseMode, Boolean(stored?.everPaid));

  // The mirror. `planSince` only moves when the tier actually changes, so a
  // renewal or a card update does not restart "member since".
  const user = await UserModel.findById(userId)
    .select("plan planSince trialConsumedAt")
    .lean();
  const update: Record<string, unknown> = {
    plan: variant.plan,
    planStatus,
    planExpiresAt: planStatus === "grace" ? endsAt : null,
    trialEndsAt: status === "on_trial" ? toDate(a.trial_ends_at) : null,
  };
  if (user?.plan !== variant.plan || !user?.planSince) update.planSince = new Date();
  // One-way. The first trial this account ever starts stamps it and nothing
  // clears it, which is what stops the same account taking the 1-day trial
  // again and again — checkout reads it to choose which Basic-monthly variant
  // to mint. Guarded on the stored value so a later `subscription_updated` for
  // the same trial does not keep pushing the date forward.
  if (a.trial_ends_at && !user?.trialConsumedAt) update.trialConsumedAt = new Date();
  await UserModel.updateOne({ _id: userId }, { $set: update });

  logger.info(
    { userId, plan: variant.plan, status, planStatus },
    "[billing] subscription state applied",
  );
  return { applied: true, userId, plan: variant.plan, planStatus };
}

/**
 * Closes an account whose subscription is gone from LemonSqueezy entirely.
 *
 * Not reachable from a webhook — LemonSqueezy sends `subscription_expired`
 * rather than deleting. It is what `reconcile` falls back to when a manual
 * cleanup in their dashboard left us holding a row for a subscription that no
 * longer exists.
 */
async function markLapsed(userId: string): Promise<void> {
  await UserModel.updateOne(
    { _id: userId },
    { $set: { planStatus: "lapsed", planExpiresAt: null } },
  );
}

export interface InvoicePayload {
  id: string;
  attributes: {
    subscription_id?: number | string;
    billing_reason?: string;
    card_brand?: string;
    card_last_four?: string;
    currency?: string;
    subtotal?: number;
    discount_total?: number;
    tax?: number;
    total?: number;
    refunded_amount?: number;
    total_formatted?: string;
    status?: string;
    refunded?: boolean;
    urls?: { invoice_url?: string } | null;
    created_at?: string;
    test_mode?: boolean;
    user_email?: string;
  };
}

/**
 * Records one subscription payment.
 *
 * The plan is snapshotted from the subscription as it stands right now, so a
 * later upgrade does not rewrite history. When the subscription row is not
 * there yet — `subscription_payment_success` and `subscription_created` fire
 * together and their order is not guaranteed — this reports failure so the
 * webhook can answer non-2xx and let LemonSqueezy retry, by which time the
 * subscription will have landed.
 */
export async function recordInvoice(
  payload: InvoicePayload,
  customUserId?: string,
): Promise<ApplyResult> {
  const a = payload.attributes ?? {};

  if (a.test_mode === true && !env.LEMONSQUEEZY_TEST_MODE) {
    return { applied: false, reason: "test_mode_on_live_server" };
  }

  const userId = await resolveUserId(customUserId, a.user_email);
  if (!userId) return { applied: false, reason: "no_matching_user" };

  const sub = await SubscriptionModel.findOne({ userId: new Types.ObjectId(userId) })
    .select("plan billing lemonSqueezyId")
    .lean();
  if (!sub) return { applied: false, reason: "subscription_not_yet_known" };

  const refunded = a.refunded === true || (a.refunded_amount ?? 0) > 0;
  const status = refunded
    ? (a.refunded_amount ?? 0) > 0 && (a.refunded_amount ?? 0) < (a.total ?? 0)
      ? "partial_refund"
      : "refunded"
    : ((a.status as string) ?? "paid");

  await InvoiceModel.updateOne(
    { lemonSqueezyInvoiceId: str(payload.id) },
    {
      $set: {
        userId: new Types.ObjectId(userId),
        subscriptionId: str(a.subscription_id) || sub.lemonSqueezyId,
        billingReason: a.billing_reason ?? "",
        status,
        currency: a.currency ?? "USD",
        subtotal: a.subtotal ?? 0,
        discountTotal: a.discount_total ?? 0,
        tax: a.tax ?? 0,
        total: a.total ?? 0,
        refundedAmount: a.refunded_amount ?? 0,
        totalFormatted: a.total_formatted ?? "",
        cardBrand: a.card_brand ?? "",
        cardLastFour: a.card_last_four ?? "",
        receiptUrl: a.urls?.invoice_url ?? "",
        plan: sub.plan,
        billing: sub.billing,
        testMode: Boolean(a.test_mode),
        createdAtLS: toDate(a.created_at) ?? new Date(),
      },
    },
    { upsert: true },
  );

  // Money actually changed hands. This is the only place `everPaid` is ever
  // set, and it is what buys the account its retry grace from here on — see
  // accessFor.
  if (status === "paid" && (a.total ?? 0) > 0) {
    await SubscriptionModel.updateOne(
      { userId: new Types.ObjectId(userId), everPaid: { $ne: true } },
      { $set: { everPaid: true } },
    );
    await reopenIfPaymentRequired(userId);
  }

  return { applied: true, userId, plan: sub.plan as PlanId };
}

/**
 * Re-derives the plan mirror for an account being held on /complete-payment.
 *
 * `subscription_updated` normally reopens the account moments after a payment
 * succeeds, and this does nothing. It exists for when that event is dropped:
 * the student would otherwise stay locked out having just paid us, which is the
 * worst failure this system has — no retry, no self-service way back, and no
 * reason for them to suspect anything but that they were charged for nothing.
 *
 * Scoped to locked accounts only. Every other state is already correct, and
 * this must not compete with applySubscriptionState for ownership of the mirror.
 */
async function reopenIfPaymentRequired(userId: string): Promise<void> {
  const locked = await UserModel.findOne({ _id: userId, planStatus: "payment_required" })
    .select("_id")
    .lean();
  if (!locked) return;

  const sub = await SubscriptionModel.findOne({ userId: new Types.ObjectId(userId) })
    .select("status endsAt pauseMode everPaid")
    .lean();
  if (!sub) return;

  const planStatus = accessFor(
    sub.status as LsSubscriptionStatus,
    sub.endsAt,
    sub.pauseMode,
    sub.everPaid,
  );
  if (planStatus === "payment_required") return;

  await UserModel.updateOne(
    { _id: userId },
    { $set: { planStatus, planExpiresAt: planStatus === "grace" ? sub.endsAt : null } },
  );
  logger.info({ userId, planStatus }, "[billing] payment cleared a locked account");
}

/**
 * Pulls a subscription's invoice history from LemonSqueezy and records whatever
 * is missing.
 *
 * `recordInvoice` is otherwise reachable only from the payment webhooks, so a
 * dropped `subscription_payment_success` left a paid month with no invoice row
 * and no way to ever get one: `reconcile` restored the subscription but not the
 * receipt, and nothing else would try again. That is precisely the situation
 * reconcile exists for, so it has to cover both halves.
 *
 * Idempotent — `recordInvoice` upserts on the LemonSqueezy invoice id, so
 * running this on every sync re-records nothing.
 *
 * Never fatal. A missing receipt must not stop the plan from being restored,
 * which is what the caller actually came for.
 *
 * Also called from `GET /billing/invoices`, which is what stops a single failed
 * attempt here being permanent: this swallows its own errors, and for a long
 * time nothing ever tried a second time. See the note on that controller.
 */
export async function backfillInvoices(subscriptionId: string, userId: string): Promise<number> {
  try {
    const invoices = await ls.listSubscriptionInvoices(subscriptionId);
    let recorded = 0;
    for (const invoice of invoices) {
      const result = await recordInvoice(
        { id: String(invoice.id), attributes: invoice.attributes as never },
        userId,
      );
      if (result.applied) recorded += 1;
    }
    if (recorded > 0) {
      logger.info({ userId, subscriptionId, recorded }, "[billing] backfilled invoices");
    }
    return recorded;
  } catch (err) {
    logger.warn({ err, userId, subscriptionId }, "[billing] invoice backfill failed");
    return 0;
  }
}

/**
 * Re-reads the truth from LemonSqueezy and applies it.
 *
 * Two jobs. It is the recovery path when a webhook was dropped (a tunnel that
 * was down, a deploy mid-flight), and it is what the page the buyer lands on
 * after checkout calls, because the webhook is asynchronous and can easily lose
 * the race against the redirect.
 */
/**
 * Cancels this account's subscription and applies the result immediately.
 *
 * The subscription id is looked up from the user id and never taken from the
 * request, so a caller can only ever cancel their own — there is no id to
 * tamper with.
 *
 * Feeding LemonSqueezy's response straight back through
 * `applySubscriptionState` is what makes this synchronous rather than
 * eventually-consistent. The response carries a fresher `updated_at` than the
 * stored row, so it passes the staleness filter and the mirror flips to `grace`
 * before we answer. Waiting for `subscription_cancelled` instead would leave the
 * page saying "Active" straight after the customer cancelled — which is exactly
 * what going through the LemonSqueezy portal does today.
 *
 * Nothing is deleted and access does not stop: `accessFor` keeps a cancelled
 * subscription open until the period already paid for runs out.
 */
export async function cancelForUser(userId: string): Promise<ApplyResult> {
  const existing = await SubscriptionModel.findOne({ userId: new Types.ObjectId(userId) })
    .select("lemonSqueezyId status")
    .lean();
  if (!existing?.lemonSqueezyId) {
    throw new ApiError(404, "You do not have a subscription to cancel.");
  }
  if (existing.status === "cancelled" || existing.status === "expired") {
    throw new ApiError(409, "That subscription is already cancelled.");
  }

  const live = await ls.cancelSubscription(existing.lemonSqueezyId);
  const result = await applySubscriptionState(live, userId);
  logger.info({ userId, applied: result.applied }, "[billing] subscription cancelled by the user");
  return result;
}

export async function reconcile(userId: string): Promise<ApplyResult> {
  const user = await UserModel.findById(userId).select("email").lean();
  if (!user) throw new ApiError(404, "Account not found");

  const existing = await SubscriptionModel.findOne({ userId: new Types.ObjectId(userId) })
    .select("lemonSqueezyId")
    .lean();

  if (existing?.lemonSqueezyId) {
    try {
      const live = await ls.getSubscription(existing.lemonSqueezyId);
      const result = await applySubscriptionState(live, userId);
      // After the subscription row is in place: recordInvoice needs it to
      // resolve the plan each invoice is snapshotted against.
      await backfillInvoices(existing.lemonSqueezyId, userId);
      return result;
    } catch (err) {
      if (err instanceof ApiError && err.statusCode === 404) {
        // Deleted at their end. Close the account rather than leave it open on
        // the strength of a row that no longer has anything behind it.
        await markLapsed(userId);
        return { applied: true, userId, planStatus: "lapsed" };
      }
      throw err;
    }
  }

  // No local row: the first webhook after checkout has not arrived (or was
  // lost), so email is the only handle we have.
  const found = await ls.listSubscriptionsByEmail(user.email);
  if (found.length === 0) return { applied: false, reason: "no_subscription_found" };

  // Prefer one that is actually live, then the most recently updated — an
  // account that re-subscribed after cancelling has both.
  //
  // `everPaid: true` is passed deliberately. This is ranking candidates by
  // liveness, not deciding access: a `past_due` subscription is very much the
  // live one even when it has never collected money, and treating it as
  // `payment_required` here would make us prefer an older dead subscription
  // over it. The real access decision is made by applySubscriptionState just
  // below, against the stored `everPaid`.
  const best =
    found.find(
      (s) => accessFor(s.attributes?.status as LsSubscriptionStatus, null, "", true) === "active",
    ) ??
    [...found].sort(
      (x, y) =>
        (toDate(y.attributes?.updated_at)?.getTime() ?? 0) -
        (toDate(x.attributes?.updated_at)?.getTime() ?? 0),
    )[0];

  const result = await applySubscriptionState(best, userId);
  // Only once the subscription actually landed — recordInvoice reports
  // `subscription_not_yet_known` without it and would record nothing.
  if (result.applied) await backfillInvoices(str(best.id), userId);
  return result;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export interface BillingState {
  plan: PlanId | null;
  planStatus: PlanStatus;
  /** Whether the app is open right now. The single question the UI asks. */
  active: boolean;
  /** Inside the free trial: nothing has been charged yet. */
  trialing: boolean;
  /** Whether a trial can still be offered. Display only — checkout re-decides. */
  trialEligible: boolean;
  entitlements: Entitlements;
  subscription: {
    id: string;
    status: LsSubscriptionStatus;
    statusFormatted: string;
    billing: string;
    renewsAt: string | null;
    endsAt: string | null;
    trialEndsAt: string | null;
    cardBrand: string;
    cardLastFour: string;
    testMode: boolean;
    /** True while cancelled-but-still-running: the UI offers "resume". */
    cancelled: boolean;
  } | null;
}

export async function getBillingState(userId: string): Promise<BillingState> {
  const user = await UserModel.findById(userId)
    .select("plan planStatus planExpiresAt trialConsumedAt")
    .lean();
  if (!user) throw new ApiError(404, "Account not found");

  const sub = await SubscriptionModel.findOne({ userId: new Types.ObjectId(userId) }).lean();
  const planStatus = (user.planStatus ?? "none") as PlanStatus;

  return {
    plan: (user.plan ?? null) as PlanId | null,
    planStatus,
    active: appOpenFor(user as { planStatus?: PlanStatus; planExpiresAt?: Date | null }),
    trialing: sub?.status === "on_trial",
    trialEligible: isTrialAvailableFor(user),
    entitlements: entitlementsFor(user.plan as PlanId | null),
    subscription: sub
      ? {
          id: sub.lemonSqueezyId,
          status: sub.status as LsSubscriptionStatus,
          statusFormatted: sub.statusFormatted || sub.status,
          billing: sub.billing,
          renewsAt: sub.renewsAt?.toISOString() ?? null,
          endsAt: sub.endsAt?.toISOString() ?? null,
          trialEndsAt: sub.trialEndsAt?.toISOString() ?? null,
          cardBrand: sub.cardBrand,
          cardLastFour: sub.cardLastFour,
          testMode: sub.testMode,
          cancelled: sub.status === "cancelled",
        }
      : null,
  };
}

/**
 * The start of the current monthly quota window.
 *
 * Anchored on the day of the month the subscription began, so a yearly
 * subscriber gets their course allowance every month rather than once a year.
 * Anchoring on the calendar month instead would hand someone who subscribed on
 * the 30th a fresh allowance the next day.
 *
 * Without a subscription (billing disabled, or a legacy account) it falls back
 * to a rolling 30-day window, which needs no anchor to compute.
 */
export function periodStartFrom(anchor: Date | null | undefined, now = new Date()): Date {
  if (!anchor) return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const start = new Date(now);
  start.setUTCHours(
    anchor.getUTCHours(),
    anchor.getUTCMinutes(),
    anchor.getUTCSeconds(),
    anchor.getUTCMilliseconds(),
  );
  const day = anchor.getUTCDate();
  // A 31st anchor has no equivalent in February: clamp to the last day of the
  // month rather than letting Date roll the overflow into the next one.
  const lastOfThisMonth = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0),
  ).getUTCDate();
  start.setUTCDate(Math.min(day, lastOfThisMonth));

  if (start.getTime() > now.getTime()) {
    // The anniversary this month has not happened yet, so the window that is
    // running started last month.
    const lastOfPrevMonth = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0),
    ).getUTCDate();
    start.setUTCMonth(start.getUTCMonth() - 1, Math.min(day, lastOfPrevMonth));
  }
  return start;
}

/** The quota window for one user, and when it resets. */
export async function currentPeriod(userId: string): Promise<{ start: Date; end: Date }> {
  const sub = await SubscriptionModel.findOne({ userId: new Types.ObjectId(userId) })
    .select("createdAt")
    .lean();
  const start = periodStartFrom(sub?.createdAt ?? null);
  const end = new Date(start);
  end.setUTCMonth(end.getUTCMonth() + 1);
  return { start, end };
}
