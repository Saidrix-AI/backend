import crypto from "node:crypto";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * The billing webhook — the only door through which a plan can ever be granted.
 *
 * The env has to be set BEFORE anything imports config/env.ts, because the
 * variant map in config/entitlements.ts is built once at module load. Hence the
 * dynamic imports below.
 */
const SECRET = "test-signing-secret";

process.env.LEMONSQUEEZY_API_KEY = "test-api-key";
process.env.LEMONSQUEEZY_STORE_ID = "1";
process.env.LEMONSQUEEZY_WEBHOOK_SECRET = SECRET;
process.env.LEMONSQUEEZY_TEST_MODE = "true";
process.env.LS_VARIANT_BASIC_MONTHLY = "1001";
process.env.LS_VARIANT_BASIC_YEARLY = "1002";
process.env.LS_VARIANT_PRO_MONTHLY = "2001";
process.env.LS_VARIANT_PRO_YEARLY = "2002";
process.env.LS_VARIANT_PREMIUM_MONTHLY = "3001";
process.env.LS_VARIANT_PREMIUM_YEARLY = "3002";

const { app } = await import("../src/app.js");
const { UserModel } = await import("../src/database/models/user.model.js");
const { SubscriptionModel } = await import("../src/database/models/subscription.model.js");
const { InvoiceModel } = await import("../src/database/models/invoice.model.js");
const { WebhookEventModel } = await import("../src/database/models/webhookEvent.model.js");

let mongo: MongoMemoryServer;
let userId: string;

const WEBHOOK = "/api/billing/webhook";

interface SubAttrs {
  variant_id?: number;
  status?: string;
  updated_at?: string;
  ends_at?: string | null;
  renews_at?: string | null;
  test_mode?: boolean;
  user_email?: string;
  card_last_four?: string;
  pause?: { mode?: string } | null;
}

function subscriptionPayload(attrs: SubAttrs = {}, eventName = "subscription_created") {
  return {
    meta: { event_name: eventName, custom_data: { user_id: userId } },
    data: {
      type: "subscriptions",
      id: "sub_1",
      attributes: {
        store_id: 1,
        customer_id: 55,
        order_id: 77,
        product_id: 9,
        variant_id: 2001,
        user_email: "billing@example.com",
        status: "active",
        status_formatted: "Active",
        card_brand: "visa",
        card_last_four: "4242",
        renews_at: "2026-09-05T00:00:00.000000Z",
        ends_at: null,
        trial_ends_at: null,
        created_at: "2026-08-05T00:00:00.000000Z",
        updated_at: "2026-08-05T00:00:00.000000Z",
        test_mode: true,
        urls: { customer_portal: "https://portal.example", update_payment_method: "https://card.example" },
        ...attrs,
      },
    },
  };
}

function invoicePayload(attrs: Record<string, unknown> = {}) {
  return {
    meta: { event_name: "subscription_payment_success", custom_data: { user_id: userId } },
    data: {
      type: "subscription-invoices",
      id: "inv_1",
      attributes: {
        subscription_id: 1,
        billing_reason: "initial",
        card_brand: "visa",
        card_last_four: "4242",
        currency: "USD",
        subtotal: 6745,
        discount_total: 0,
        tax: 0,
        total: 6745,
        total_formatted: "$67.45",
        status: "paid",
        refunded: false,
        urls: { invoice_url: "https://receipt.example" },
        created_at: "2026-08-05T00:00:00.000000Z",
        updated_at: "2026-08-05T00:00:00.000000Z",
        test_mode: true,
        ...attrs,
      },
    },
  };
}

/** Signs exactly the bytes that will be sent, the way LemonSqueezy does. */
function send(payload: unknown, secret = SECRET) {
  const raw = JSON.stringify(payload);
  const signature = crypto.createHmac("sha256", secret).update(raw).digest("hex");
  return request(app)
    .post(WEBHOOK)
    .set("Content-Type", "application/json")
    .set("X-Signature", signature)
    .send(raw);
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
  await Promise.all([
    UserModel.deleteMany({}),
    SubscriptionModel.deleteMany({}),
    InvoiceModel.deleteMany({}),
    WebhookEventModel.deleteMany({}),
  ]);
  const user = await UserModel.create({
    name: "Billing Tester",
    username: `bill-${Date.now()}`,
    email: "billing@example.com",
    passwordHash: "x",
  });
  userId = String(user._id);
});

describe("signature verification", () => {
  it("accepts a correctly signed request", async () => {
    const res = await send(subscriptionPayload());
    expect(res.status).toBe(200);
    expect(res.body.data.applied).toBe(true);
  });

  it("rejects a request signed with the wrong secret", async () => {
    const res = await send(subscriptionPayload(), "not-the-secret");
    expect(res.status).toBe(401);
    expect(await SubscriptionModel.countDocuments({})).toBe(0);
  });

  it("rejects a missing signature", async () => {
    const raw = JSON.stringify(subscriptionPayload());
    const res = await request(app)
      .post(WEBHOOK)
      .set("Content-Type", "application/json")
      .send(raw);
    expect(res.status).toBe(401);
  });

  /**
   * `crypto.timingSafeEqual` throws on unequal buffer lengths, so a short
   * signature has to be length-checked before it reaches the comparison — the
   * snippet in LemonSqueezy's own docs omits that and would 500 here.
   */
  it("rejects a truncated signature without crashing", async () => {
    const raw = JSON.stringify(subscriptionPayload());
    const res = await request(app)
      .post(WEBHOOK)
      .set("Content-Type", "application/json")
      .set("X-Signature", "abc123")
      .send(raw);
    expect(res.status).toBe(401);
  });

  it("rejects a body tampered with after signing", async () => {
    const payload = subscriptionPayload();
    const raw = JSON.stringify(payload);
    const signature = crypto.createHmac("sha256", SECRET).update(raw).digest("hex");
    // Same signature, upgraded tier.
    const tampered = JSON.stringify(subscriptionPayload({ variant_id: 3001 }));
    const res = await request(app)
      .post(WEBHOOK)
      .set("Content-Type", "application/json")
      .set("X-Signature", signature)
      .send(tampered);
    expect(res.status).toBe(401);
  });
});

describe("idempotency and ordering", () => {
  it("applies a replayed delivery only once", async () => {
    await send(subscriptionPayload());
    const second = await send(subscriptionPayload());
    expect(second.status).toBe(200);
    expect(second.body.data.duplicate).toBe(true);
    expect(await SubscriptionModel.countDocuments({})).toBe(1);
  });

  it("ignores an event older than the state already stored", async () => {
    await send(
      subscriptionPayload({ status: "cancelled", ends_at: "2026-09-05T00:00:00.000000Z", updated_at: "2026-08-06T00:00:00.000000Z" }),
    );
    // A delayed pre-cancellation update, arriving after the cancellation.
    const stale = await send(
      subscriptionPayload({ status: "active", updated_at: "2026-08-05T00:00:00.000000Z" }, "subscription_updated"),
    );
    expect(stale.body.data.reason).toBe("stale_event");
    const sub = await SubscriptionModel.findOne({}).lean();
    expect(sub!.status).toBe("cancelled");
  });

  it("lets the newest event win however the deliveries interleave", async () => {
    // Retries use exponential backoff, so events for one subscription routinely
    // arrive together and out of order. Reading the stored row, deciding
    // "not stale", and then writing are three separate steps: overlapping
    // deliveries can all read the same snapshot and then land in any order,
    // letting an OLDER event's state be written last — resurrecting a
    // cancelled subscription, or cancelling a live one.
    //
    // Whatever order these six land in, the row must end up matching the
    // newest of them.
    //
    // Dispatched NEWEST FIRST on purpose. Requests tend to complete in the
    // order they were fired, so this puts the oldest event last — the arrival
    // pattern that makes a read-then-write implementation write the stale
    // state last and keep it. Ascending order hides the bug by luck.
    const days = [6, 5, 4, 3, 2, 1];
    await Promise.all(
      days.map((d) =>
        send(
          subscriptionPayload(
            {
              status: "active",
              updated_at: `2026-08-0${d}T00:00:00.000000Z`,
              // Distinguishes which event's payload actually got written.
              card_last_four: `000${d}`,
            } as SubAttrs,
            "subscription_updated",
          ),
        ),
      ),
    );

    const sub = await SubscriptionModel.findOne({}).lean();
    expect(sub!.lsUpdatedAt?.toISOString()).toBe("2026-08-06T00:00:00.000Z");
    expect(sub!.cardLastFour).toBe("0006");
    // One subscription per account, no matter how many events raced to create it.
    expect(await SubscriptionModel.countDocuments({})).toBe(1);
  });
});

describe("granting a plan", () => {
  it("maps the variant to a tier and mirrors it onto the user", async () => {
    await send(subscriptionPayload({ variant_id: 3002 }));
    const sub = await SubscriptionModel.findOne({}).lean();
    expect(sub!.plan).toBe("premium");
    expect(sub!.billing).toBe("yearly");

    const user = await UserModel.findById(userId).lean();
    expect(user!.plan).toBe("premium");
    expect(user!.planStatus).toBe("active");
    expect(user!.planSince).toBeTruthy();
  });

  it("grants nothing for a variant that is not ours", async () => {
    const res = await send(subscriptionPayload({ variant_id: 999999 }));
    expect(res.body.data.reason).toBe("unknown_variant");
    expect(await SubscriptionModel.countDocuments({})).toBe(0);
    const user = await UserModel.findById(userId).lean();
    expect(user!.plan).toBeNull();
  });

  it("falls back to the email when no custom_data is present", async () => {
    const payload = subscriptionPayload();
    payload.meta.custom_data = {} as never;
    const res = await send(payload);
    expect(res.body.data.applied).toBe(true);
    const user = await UserModel.findById(userId).lean();
    expect(user!.plan).toBe("pro");
  });

  it("matches nothing when neither the id nor the email is ours", async () => {
    const payload = subscriptionPayload({ user_email: "stranger@example.com" });
    payload.meta.custom_data = {} as never;
    const res = await send(payload);
    expect(res.body.data.reason).toBe("no_matching_user");
  });
});

describe("status to access", () => {
  const cases: Array<[string, SubAttrs, string]> = [
    ["active", { status: "active" }, "active"],
    ["on trial", { status: "on_trial" }, "active"],
    ["past due (still retrying)", { status: "past_due" }, "active"],
    ["paused for free", { status: "paused", pause: { mode: "free" } }, "active"],
    ["paused and voided", { status: "paused", pause: { mode: "void" } }, "lapsed"],
    ["unpaid", { status: "unpaid" }, "lapsed"],
    ["expired", { status: "expired" }, "lapsed"],
  ];

  for (const [name, attrs, expected] of cases) {
    it(`${name} → ${expected}`, async () => {
      await send(subscriptionPayload(attrs));
      const user = await UserModel.findById(userId).lean();
      expect(user!.planStatus).toBe(expected);
    });
  }

  it("cancelled keeps access until ends_at, then loses it", async () => {
    const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    await send(subscriptionPayload({ status: "cancelled", ends_at: future }));
    let user = await UserModel.findById(userId).lean();
    expect(user!.planStatus).toBe("grace");
    expect(user!.planExpiresAt).toBeTruthy();

    const past = new Date(Date.now() - 1000).toISOString();
    await send(
      subscriptionPayload(
        { status: "cancelled", ends_at: past, updated_at: "2026-08-09T00:00:00.000000Z" },
        "subscription_updated",
      ),
    );
    user = await UserModel.findById(userId).lean();
    expect(user!.planStatus).toBe("lapsed");
  });
});

describe("test mode", () => {
  it("refuses to grant a plan from a test purchase on a live server", async () => {
    // `LEMONSQUEEZY_TEST_MODE=true` says this deployment expects test traffic;
    // flipping it is what makes a $0 checkout unable to unlock a real account.
    const { env } = await import("../src/config/env.js");
    (env as { LEMONSQUEEZY_TEST_MODE: boolean }).LEMONSQUEEZY_TEST_MODE = false;
    try {
      const res = await send(subscriptionPayload({ test_mode: true }));
      expect(res.body.data.reason).toBe("test_mode_on_live_server");
      expect(await SubscriptionModel.countDocuments({})).toBe(0);
    } finally {
      (env as { LEMONSQUEEZY_TEST_MODE: boolean }).LEMONSQUEEZY_TEST_MODE = true;
    }
  });
});

describe("invoices", () => {
  it("records a payment against the plan that was live at the time", async () => {
    await send(subscriptionPayload());
    const res = await send(invoicePayload());
    expect(res.body.data.applied).toBe(true);

    const invoice = await InvoiceModel.findOne({}).lean();
    expect(invoice!.total).toBe(6745);
    expect(invoice!.plan).toBe("pro");
    expect(invoice!.receiptUrl).toBe("https://receipt.example");

    // A later upgrade must not rewrite the history.
    await send(
      subscriptionPayload({ variant_id: 3001, updated_at: "2026-08-09T00:00:00.000000Z" }, "subscription_updated"),
    );
    const again = await InvoiceModel.findOne({}).lean();
    expect(again!.plan).toBe("pro");
  });

  it("asks for a retry when the payment beats its subscription", async () => {
    const res = await send(invoicePayload());
    expect(res.status).toBe(503);
    expect(await InvoiceModel.countDocuments({})).toBe(0);
    // The idempotency row must be gone, or the retry would be swallowed as a
    // duplicate and the invoice lost forever.
    expect(await WebhookEventModel.countDocuments({})).toBe(0);

    await send(subscriptionPayload());
    const retry = await send(invoicePayload());
    expect(retry.status).toBe(200);
    expect(await InvoiceModel.countDocuments({})).toBe(1);
  });

  it("marks a refunded payment", async () => {
    await send(subscriptionPayload());
    await send(invoicePayload({ refunded: true, refunded_amount: 6745 }));
    const invoice = await InvoiceModel.findOne({}).lean();
    expect(invoice!.status).toBe("refunded");
  });
});

describe("events we do not act on", () => {
  it("acknowledges them so LemonSqueezy stops retrying", async () => {
    const res = await send({
      meta: { event_name: "customer_updated" },
      data: { type: "customers", id: "c1", attributes: { updated_at: "2026-08-05T00:00:00Z" } },
    });
    expect(res.status).toBe(200);
    expect(res.body.data.ignored).toBe("customer_updated");
  });
});
