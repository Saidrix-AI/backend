import { Schema, model, Types, type InferSchemaType } from "mongoose";
import { PLAN_IDS } from "../../config/plans.js";
import { BILLING_PERIODS } from "../../config/entitlements.js";

/**
 * The statuses LemonSqueezy can put a subscription in.
 *
 * Which of them still opens the app is decided in one place —
 * `subscription.service.ts#accessFor` — not here, because "cancelled" is
 * counter-intuitive: it means the customer stopped future payments but is
 * still inside the period they already paid for.
 */
export const LS_SUBSCRIPTION_STATUSES = [
  "on_trial",
  "active",
  "paused",
  "past_due",
  "unpaid",
  "cancelled",
  "expired",
] as const;

export type LsSubscriptionStatus = (typeof LS_SUBSCRIPTION_STATUSES)[number];

/**
 * Our mirror of one LemonSqueezy subscription. One row per user.
 *
 * LemonSqueezy owns this data; we never author it. Every field is written by a
 * single function (`subscription.service.ts#applySubscriptionState`) from a
 * signature-verified webhook or a direct API read, which is what keeps the
 * denormalised copy on the user document from drifting.
 */
const subscriptionSchema = new Schema(
  {
    // One subscription per account. The unique index is the guard against a
    // double checkout creating two rows and the second one winning at random.
    userId: { type: Types.ObjectId, ref: "User", required: true, unique: true },

    // --- LemonSqueezy identifiers (strings: webhooks send numbers, the API sends strings) ---
    lemonSqueezyId: { type: String, required: true, index: true },
    customerId: { type: String, default: "" },
    orderId: { type: String, default: "" },
    storeId: { type: String, default: "" },
    productId: { type: String, default: "" },
    variantId: { type: String, default: "" },

    // --- What it entitles them to, resolved from variantId at write time ---
    plan: { type: String, enum: PLAN_IDS, required: true },
    billing: { type: String, enum: BILLING_PERIODS, default: "monthly" },

    status: { type: String, enum: LS_SUBSCRIPTION_STATUSES, required: true },
    /** LemonSqueezy's own title-cased label ("Past due"), shown verbatim in the UI. */
    statusFormatted: { type: String, default: "" },

    // Display only. The card itself lives with LemonSqueezy, never here.
    cardBrand: { type: String, default: "" },
    cardLastFour: { type: String, default: "" },

    /** Next charge date while active. */
    renewsAt: { type: Date, default: null },
    /**
     * When access actually stops. Set while `cancelled` (the end of the paid
     * period) and once `expired`. Checked directly rather than trusted to the
     * status alone, so a missed `subscription_expired` webhook cannot leave an
     * account open forever.
     */
    endsAt: { type: Date, default: null },
    trialEndsAt: { type: Date, default: null },
    /** "void" or "free" while paused; empty otherwise. */
    pauseMode: { type: String, default: "" },
    pauseResumesAt: { type: Date, default: null },

    /**
     * Whether this subscription has ever actually collected money.
     *
     * Set by subscription.service.ts#recordInvoice the first time a paid,
     * non-zero invoice lands, and never unset.
     *
     * It exists to answer one question: is `past_due` a customer whose card
     * just failed, or a trial that never paid at all? LemonSqueezy retries a
     * failed renewal for roughly two weeks, and we keep those accounts open
     * because locking someone out mid-retry punishes an expired card. Extending
     * the same courtesy to a 1-day trial whose very first charge failed would
     * hand out a fortnight of free access to anyone who let it fail on purpose.
     *
     * Retry grace is for customers who have already paid us. This is how we
     * tell which those are — see subscription.service.ts#accessFor.
     */
    everPaid: { type: Boolean, default: false },

    /**
     * True for purchases made with a test-mode API key. Kept so a test row is
     * identifiable after the fact — production refuses to grant a plan from one.
     */
    testMode: { type: Boolean, default: false },

    /**
     * `data.attributes.updated_at` from the last event applied.
     *
     * Webhooks are retried with backoff and can therefore arrive out of order:
     * a delayed `subscription_updated` carrying the pre-cancellation state
     * would otherwise resurrect a subscription the customer already ended.
     * Older-or-equal timestamps are ignored.
     */
    lsUpdatedAt: { type: Date, default: null },

    /**
     * When the billing history was last pulled back from LemonSqueezy.
     *
     * `GET /billing/invoices` repairs an empty history by calling
     * `backfillInvoices`, and this is what stops that becoming a request to
     * LemonSqueezy on every page load. An account can legitimately have no
     * invoices for a while — a trial that has not converted — and their API
     * allows 300 calls a minute across the whole store.
     */
    invoicesSyncedAt: { type: Date, default: null },

    // Signed, valid 24h — cached only so a page can render a link immediately;
    // a fresh one is fetched whenever the user actually clicks through.
    customerPortalUrl: { type: String, default: "" },
    updatePaymentMethodUrl: { type: String, default: "" },
  },
  { timestamps: true },
);

export type Subscription = InferSchemaType<typeof subscriptionSchema>;
export const SubscriptionModel = model("Subscription", subscriptionSchema);
