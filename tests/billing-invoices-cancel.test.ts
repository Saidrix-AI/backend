import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The two things a customer does after paying: read their receipts, and stop
 * paying.
 *
 * Both were broken by the same gap. An `Invoice` row is written only by the
 * payment webhooks or by `backfillInvoices` inside `reconcile`, and `reconcile`
 * runs only when something calls `POST /billing/sync`. On a deployment where
 * webhooks are not arriving, a paying customer's billing history stayed empty
 * *permanently* — the page is a plain database read, and `backfillInvoices`
 * swallows its own errors, so nothing ever tried again.
 *
 * Cancelling had the mirror of it: the only route was the LemonSqueezy portal,
 * and the app never learned the result.
 */
process.env.LEMONSQUEEZY_API_KEY = "test-api-key";
process.env.LEMONSQUEEZY_STORE_ID = "1";
process.env.LEMONSQUEEZY_WEBHOOK_SECRET = "test-signing-secret";
process.env.LEMONSQUEEZY_TEST_MODE = "true";
process.env.LS_VARIANT_BASIC_MONTHLY = "1001";
process.env.LS_VARIANT_BASIC_YEARLY = "1002";
process.env.LS_VARIANT_PRO_MONTHLY = "2001";
process.env.LS_VARIANT_PRO_YEARLY = "2002";
process.env.LS_VARIANT_PREMIUM_MONTHLY = "3001";
process.env.LS_VARIANT_PREMIUM_YEARLY = "3002";

const listSubscriptionInvoices = vi.fn(async () => [] as unknown[]);
const cancelSubscription = vi.fn();
vi.mock("../src/services/lemonSqueezy.client.js", () => ({
  createCheckout: vi.fn(async () => "https://checkout.example/abc"),
  getSubscription: vi.fn(),
  listSubscriptionsByEmail: vi.fn(async () => []),
  listSubscriptionInvoices: (...a: unknown[]) => listSubscriptionInvoices(...(a as [])),
  cancelSubscription: (...a: unknown[]) => cancelSubscription(...(a as [])),
}));

const { app } = await import("../src/app.js");
const { UserModel } = await import("../src/database/models/user.model.js");
const { SubscriptionModel } = await import("../src/database/models/subscription.model.js");
const { InvoiceModel } = await import("../src/database/models/invoice.model.js");
const { signAccessToken } = await import("../src/services/token.service.js");

let mongo: MongoMemoryServer;
let userId: string;
let token: string;

/** One paid invoice, shaped the way LemonSqueezy actually returns them. */
function lsInvoice(id = "8118130") {
  return {
    id,
    attributes: {
      subscription_id: 2413512,
      billing_reason: "initial",
      card_brand: "visa",
      card_last_four: "4242",
      currency: "USD",
      subtotal: 5396,
      tax: 0,
      total: 5396,
      total_formatted: "$53.96",
      status: "paid",
      refunded: false,
      urls: { invoice_url: "https://receipt.example" },
      created_at: "2026-08-07T06:22:27.000000Z",
      test_mode: true,
    },
  };
}

async function giveSubscription(extra: Record<string, unknown> = {}) {
  await SubscriptionModel.create({
    userId: new mongoose.Types.ObjectId(userId),
    lemonSqueezyId: "2413512",
    plan: "pro",
    billing: "monthly",
    status: "active",
    ...extra,
  });
  await UserModel.updateOne({ _id: userId }, { $set: { plan: "pro", planStatus: "active" } });
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

beforeEach(async () => {
  listSubscriptionInvoices.mockReset();
  listSubscriptionInvoices.mockResolvedValue([]);
  cancelSubscription.mockReset();
  await Promise.all([
    UserModel.deleteMany({}),
    SubscriptionModel.deleteMany({}),
    InvoiceModel.deleteMany({}),
  ]);
  const user = await UserModel.create({
    name: "Invoice Tester",
    username: `inv-${Date.now()}`,
    email: `inv-${Date.now()}@example.com`,
    passwordHash: "x",
    emailVerified: true,
  });
  userId = String(user._id);
  token = signAccessToken(userId, user.email);
});

function getInvoices() {
  return request(app).get("/api/billing/invoices").set("Authorization", `Bearer ${token}`);
}

describe("billing: invoices repair themselves", () => {
  it("backfills a history that a dropped webhook left empty", async () => {
    // The reported bug, exactly: a real subscription, a real paid invoice at
    // LemonSqueezy, and nothing in our database to show for it.
    await giveSubscription();
    listSubscriptionInvoices.mockResolvedValue([lsInvoice()]);

    const res = await getInvoices();

    expect(res.status).toBe(200);
    expect(res.body.data.invoices).toHaveLength(1);
    expect(res.body.data.invoices[0].number).toBe("8118130");
    expect(listSubscriptionInvoices).toHaveBeenCalledTimes(1);
  });

  it("does not ask LemonSqueezy again inside the cooldown", async () => {
    // An account can legitimately have no invoices for a while — a trial that
    // has not converted — and their API allows 300 calls a minute store-wide.
    await giveSubscription();
    listSubscriptionInvoices.mockResolvedValue([]);

    await getInvoices();
    await getInvoices();
    await getInvoices();

    expect(listSubscriptionInvoices).toHaveBeenCalledTimes(1);
  });

  it("starts the cooldown even when the backfill fails", async () => {
    // Otherwise a store that is down turns every page load into another doomed
    // request.
    await giveSubscription();
    listSubscriptionInvoices.mockRejectedValue(new Error("lemonsqueezy is down"));

    const first = await getInvoices();
    const second = await getInvoices();

    // Still answers — a missing receipt must not break the page.
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(listSubscriptionInvoices).toHaveBeenCalledTimes(1);
  });

  it("does not call LemonSqueezy for an account with no subscription", async () => {
    const res = await getInvoices();
    expect(res.status).toBe(200);
    expect(res.body.data.invoices).toHaveLength(0);
    expect(listSubscriptionInvoices).not.toHaveBeenCalled();
  });

  it("does not call LemonSqueezy when invoices already exist", async () => {
    await giveSubscription();
    await InvoiceModel.create({
      userId: new mongoose.Types.ObjectId(userId),
      lemonSqueezyInvoiceId: "already-here",
      plan: "pro",
      billing: "monthly",
      total: 5396,
      createdAtLS: new Date(),
    });

    const res = await getInvoices();
    expect(res.body.data.invoices).toHaveLength(1);
    expect(listSubscriptionInvoices).not.toHaveBeenCalled();
  });
});

describe("billing: cancel", () => {
  /** What LemonSqueezy returns from DELETE — cancelled, with an end date. */
  function cancelledPayload(endsAt: string) {
    return {
      type: "subscriptions",
      id: "2413512",
      attributes: {
        store_id: 1,
        customer_id: 55,
        order_id: 77,
        product_id: 9,
        variant_id: 2001,
        user_email: "inv@example.com",
        status: "cancelled",
        status_formatted: "Cancelled",
        ends_at: endsAt,
        renews_at: null,
        updated_at: "2026-09-01T00:00:00.000000Z",
        test_mode: true,
      },
    };
  }

  function cancel() {
    return request(app).post("/api/billing/cancel").set("Authorization", `Bearer ${token}`);
  }

  it("applies the cancellation immediately, with no webhook", async () => {
    // The point of the whole change: going through the portal left the app
    // saying "Active" straight after the customer had cancelled.
    await giveSubscription();
    const endsAt = new Date(Date.now() + 20 * 24 * 60 * 60 * 1000).toISOString();
    cancelSubscription.mockResolvedValue(cancelledPayload(endsAt));

    const res = await cancel();

    expect(res.status).toBe(200);
    expect(cancelSubscription).toHaveBeenCalledWith("2413512");
    // Access continues to the end of the paid period.
    expect(res.body.data.planStatus).toBe("grace");
    expect(res.body.data.active).toBe(true);

    const user = await UserModel.findById(userId).lean();
    expect(user!.planStatus).toBe("grace");
    expect(user!.planExpiresAt).toBeInstanceOf(Date);
  });

  it("only ever cancels the caller's own subscription", async () => {
    // The id comes from the session, so there is nothing in the request to
    // point at someone else's.
    const other = await UserModel.create({
      name: "Someone Else",
      username: `other-${Date.now()}`,
      email: `other-${Date.now()}@example.com`,
      passwordHash: "x",
    });
    await SubscriptionModel.create({
      userId: other._id,
      lemonSqueezyId: "9999999",
      plan: "premium",
      status: "active",
    });
    await giveSubscription();
    cancelSubscription.mockResolvedValue(
      cancelledPayload(new Date(Date.now() + 86_400_000).toISOString()),
    );

    await request(app)
      .post("/api/billing/cancel")
      .set("Authorization", `Bearer ${token}`)
      .send({ subscriptionId: "9999999", userId: String(other._id) });

    expect(cancelSubscription).toHaveBeenCalledWith("2413512");
    expect(cancelSubscription).not.toHaveBeenCalledWith("9999999");

    const untouched = await SubscriptionModel.findOne({ lemonSqueezyId: "9999999" }).lean();
    expect(untouched!.status).toBe("active");
  });

  it("404s with no subscription, without calling LemonSqueezy", async () => {
    const res = await cancel();
    expect(res.status).toBe(404);
    expect(cancelSubscription).not.toHaveBeenCalled();
  });

  it("refuses to cancel one that is already cancelled", async () => {
    await giveSubscription({ status: "cancelled" });
    const res = await cancel();
    expect(res.status).toBe(409);
    expect(cancelSubscription).not.toHaveBeenCalled();
  });

  it("needs a session", async () => {
    const res = await request(app).post("/api/billing/cancel");
    expect(res.status).toBe(401);
    expect(cancelSubscription).not.toHaveBeenCalled();
  });
});
