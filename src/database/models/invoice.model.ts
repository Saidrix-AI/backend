import { Schema, model, Types, type InferSchemaType } from "mongoose";
import { PLAN_IDS } from "../../config/plans.js";
import { BILLING_PERIODS } from "../../config/entitlements.js";

/**
 * One payment against a subscription, written from the
 * `subscription_payment_*` webhooks.
 *
 * The account's billing history is built from these rows rather than fetched
 * from LemonSqueezy on every page load, so /account/invoices renders without a
 * third-party round trip and keeps working if their API is briefly down.
 *
 * Amounts are integer cents in the charged currency, exactly as LemonSqueezy
 * sends them — never floats, and never converted at read time.
 */
const invoiceSchema = new Schema(
  {
    userId: { type: Types.ObjectId, ref: "User", required: true },
    /** The subscription-invoice id. Unique, so a webhook retry cannot duplicate a row. */
    lemonSqueezyInvoiceId: { type: String, required: true, unique: true },
    subscriptionId: { type: String, default: "", index: true },

    /** "initial" | "renewal" | "updated" — LemonSqueezy's own vocabulary. */
    billingReason: { type: String, default: "" },
    status: {
      type: String,
      enum: ["paid", "pending", "failed", "refunded", "partial_refund", "void"],
      default: "paid",
    },

    currency: { type: String, default: "USD" },
    subtotal: { type: Number, default: 0 },
    discountTotal: { type: Number, default: 0 },
    tax: { type: Number, default: 0 },
    total: { type: Number, default: 0 },
    refundedAmount: { type: Number, default: 0 },
    /** LemonSqueezy's pre-formatted "$67.45" — their rounding, not ours. */
    totalFormatted: { type: String, default: "" },

    cardBrand: { type: String, default: "" },
    cardLastFour: { type: String, default: "" },

    /** The hosted receipt/invoice page. What "Download PDF" opens. */
    receiptUrl: { type: String, default: "" },

    /**
     * The tier this payment bought, snapshotted. Reading it off the live
     * subscription instead would silently rewrite billing history every time
     * the customer changed plan.
     */
    plan: { type: String, enum: PLAN_IDS, required: true },
    billing: { type: String, enum: BILLING_PERIODS, default: "monthly" },

    testMode: { type: Boolean, default: false },
    /** LemonSqueezy's created_at — the real payment date, not our insert time. */
    createdAtLS: { type: Date, required: true },
  },
  { timestamps: true },
);

// The account page lists one user's payments newest-first, and nothing else.
invoiceSchema.index({ userId: 1, createdAtLS: -1 });

export type Invoice = InferSchemaType<typeof invoiceSchema>;
export const InvoiceModel = model("Invoice", invoiceSchema);
