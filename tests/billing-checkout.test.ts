import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `POST /billing/checkout` — the route that can spend the student's money.
 *
 * As with the webhook suite, the LemonSqueezy env has to be set before anything
 * imports config/env.ts, because the variant map is built once at module load.
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
// The second Basic-monthly variant, the one carrying the 1-day free trial.
// The Basic variants carry a 1-day trial in the dashboard; this declares it.
process.env.TRIAL_DAYS = "1";

// The real client would bill a real card. Counting the calls is the whole point
// of this suite: one call is one chargeable checkout.
const createCheckout = vi.fn(async () => "https://checkout.example/abc");
const getSubscription = vi.fn();
const listSubscriptionInvoices = vi.fn(async () => [] as unknown[]);
vi.mock("../src/services/lemonSqueezy.client.js", () => ({
  createCheckout: (...args: unknown[]) => createCheckout(...(args as [])),
  getSubscription: (...args: unknown[]) => getSubscription(...(args as [])),
  listSubscriptionsByEmail: vi.fn(async () => []),
  listSubscriptionInvoices: (...args: unknown[]) => listSubscriptionInvoices(...(args as [])),
}));

const { app } = await import("../src/app.js");
const { UserModel } = await import("../src/database/models/user.model.js");
const { SubscriptionModel } = await import("../src/database/models/subscription.model.js");
const { InvoiceModel } = await import("../src/database/models/invoice.model.js");

let mongo: MongoMemoryServer;
let accessToken: string;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

beforeEach(async () => {
  createCheckout.mockClear();
  getSubscription.mockReset();
  listSubscriptionInvoices.mockReset();
  listSubscriptionInvoices.mockResolvedValue([]);
  await Promise.all([
    UserModel.deleteMany({}),
    SubscriptionModel.deleteMany({}),
    InvoiceModel.deleteMany({}),
  ]);
  const reg = await request(app).post("/api/auth/register").send({
    name: "Checkout Tester",
    username: "checkoutuser",
    email: "checkout@example.com",
    password: "supersecret123",
  });
  accessToken = reg.body.data.accessToken;
});

function checkout(plan = "pro", billing = "monthly") {
  return request(app)
    .post("/api/billing/checkout")
    .set("Authorization", `Bearer ${accessToken}`)
    .send({ plan, billing });
}

/** What the server actually asked LemonSqueezy for. */
function sold(call = 0): { variantId: string; skipTrial?: boolean } {
  // The mock is declared with no parameters, so vitest types its recorded calls
  // as an empty tuple. The real client takes CreateCheckoutInput.
  const args = createCheckout.mock.calls[call] as unknown as [
    { variantId: string; skipTrial?: boolean },
  ];
  return args[0];
}

/** The variant id sold. */
function soldVariant(call = 0): string {
  return sold(call).variantId;
}

/** Whether the free trial was withheld on that checkout. */
function skippedTrial(call = 0): boolean {
  return sold(call).skipTrial === true;
}

/** Clears the reservation a previous checkout deliberately left standing. */
async function releaseCheckoutLock() {
  await UserModel.updateOne(
    { email: "checkout@example.com" },
    { $set: { checkoutLockedUntil: null } },
  );
}

describe("billing: checkout", () => {
  it("creates one checkout for a subscriber-to-be", async () => {
    const res = await checkout();
    expect(res.status).toBe(200);
    expect(res.body.data.url).toBe("https://checkout.example/abc");
    expect(createCheckout).toHaveBeenCalledTimes(1);
  });

  it("bills once when checkouts race", async () => {
    // A double-click, two tabs, or a replayed request. Checking "does this
    // account already have a subscription?" and then creating the checkout are
    // two separate operations; without something reserving the decision between
    // them, every one of these passes the check and mints a REAL charge.
    const results = await Promise.all(Array.from({ length: 5 }, () => checkout()));

    const ok = results.filter((r) => r.status === 200);
    const refused = results.filter((r) => r.status === 409);

    expect(ok).toHaveLength(1);
    expect(refused).toHaveLength(4);
    expect(refused.every((r) => r.body.code === "checkout_in_progress")).toBe(true);
    // The assertion that is actually about money.
    expect(createCheckout).toHaveBeenCalledTimes(1);
  });

  it("holds the reservation after a success, so a repeat submit is refused", async () => {
    // Sequential, not concurrent — the case a lock released on success would
    // miss. The subscription-exists check cannot see a checkout that has been
    // handed out but not yet paid, so without the reservation outliving the
    // response this second call would mint another chargeable link.
    const first = await checkout();
    expect(first.status).toBe(200);

    const second = await checkout();
    expect(second.status).toBe(409);
    expect(second.body.code).toBe("checkout_in_progress");
    expect(createCheckout).toHaveBeenCalledTimes(1);

    const user = await UserModel.findOne({ email: "checkout@example.com" }).lean();
    expect(user?.checkoutLockedUntil).toBeInstanceOf(Date);
  });

  it("releases the reservation when the checkout could not be created", async () => {
    // Nothing chargeable exists, so making the user wait would be punishing a
    // failure that was ours.
    createCheckout.mockRejectedValueOnce(new Error("lemonsqueezy is down"));
    const failed = await checkout();
    expect(failed.status).toBeGreaterThanOrEqual(500);

    const user = await UserModel.findOne({ email: "checkout@example.com" }).lean();
    expect(user?.checkoutLockedUntil ?? null).toBeNull();

    const retry = await checkout();
    expect(retry.status).toBe(200);
  });

  it("backfills the invoices a dropped payment webhook lost", async () => {
    // The scenario reconcile exists for: the subscription webhook was missed
    // (or, on a localhost deploy, could never arrive), so the account has a
    // subscription but no receipt for the money that was actually taken.
    // Restoring only the entitlement would leave that gap permanent — nothing
    // else ever calls recordInvoice again.
    const user = await UserModel.findOne({ email: "checkout@example.com" });
    await SubscriptionModel.create({
      userId: user!._id,
      lemonSqueezyId: "sub_1",
      plan: "pro",
      billing: "monthly",
      status: "active",
    });
    getSubscription.mockResolvedValue({
      type: "subscriptions",
      id: "sub_1",
      attributes: {
        variant_id: 2001,
        status: "active",
        user_email: "checkout@example.com",
        updated_at: "2026-08-05T00:00:00.000000Z",
        test_mode: true,
      },
    });
    listSubscriptionInvoices.mockResolvedValue([
      {
        type: "subscription-invoices",
        id: "inv_9",
        attributes: {
          subscription_id: "sub_1",
          billing_reason: "initial",
          status: "paid",
          currency: "USD",
          total: 5396,
          total_formatted: "$53.96",
          card_brand: "visa",
          card_last_four: "4242",
          created_at: "2026-08-05T00:00:00.000000Z",
          test_mode: true,
        },
      },
    ]);

    expect(await InvoiceModel.countDocuments({ userId: user!._id })).toBe(0);

    const res = await request(app)
      .post("/api/billing/sync")
      .set("Authorization", `Bearer ${accessToken}`)
      .send();
    expect(res.status).toBe(200);

    const invoices = await InvoiceModel.find({ userId: user!._id }).lean();
    expect(invoices).toHaveLength(1);
    expect(invoices[0]!.lemonSqueezyInvoiceId).toBe("inv_9");
    expect(invoices[0]!.totalFormatted).toBe("$53.96");
    expect(invoices[0]!.plan).toBe("pro");

    // Idempotent: syncing again must not duplicate the receipt.
    await request(app)
      .post("/api/billing/sync")
      .set("Authorization", `Bearer ${accessToken}`)
      .send();
    expect(await InvoiceModel.countDocuments({ userId: user!._id })).toBe(1);
  });

  it("does not fail the sync when the invoice fetch errors", async () => {
    // Restoring the plan is what the caller came for; a missing receipt must
    // not turn that into a failed request.
    const user = await UserModel.findOne({ email: "checkout@example.com" });
    await SubscriptionModel.create({
      userId: user!._id,
      lemonSqueezyId: "sub_1",
      plan: "pro",
      billing: "monthly",
      status: "active",
    });
    getSubscription.mockResolvedValue({
      type: "subscriptions",
      id: "sub_1",
      attributes: {
        variant_id: 2001,
        status: "active",
        user_email: "checkout@example.com",
        updated_at: "2026-08-05T00:00:00.000000Z",
        test_mode: true,
      },
    });
    listSubscriptionInvoices.mockRejectedValue(new Error("lemonsqueezy is down"));

    const res = await request(app)
      .post("/api/billing/sync")
      .set("Authorization", `Bearer ${accessToken}`)
      .send();
    expect(res.status).toBe(200);
    expect(res.body.data.planStatus).toBe("active");
  });

  it("refuses a second checkout once a subscription exists", async () => {
    const user = await UserModel.findOne({ email: "checkout@example.com" });
    await SubscriptionModel.create({
      userId: user!._id,
      lemonSqueezyId: "sub_1",
      plan: "pro",
      billing: "monthly",
      status: "active",
    });
    await UserModel.updateOne({ _id: user!._id }, { $set: { planStatus: "active", plan: "pro" } });

    const res = await checkout();
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("subscription_exists");
    expect(createCheckout).not.toHaveBeenCalled();
  });
});

/**
 * Who actually gets the free trial.
 *
 * The Basic variants carry a 1-day trial in the LemonSqueezy dashboard, so it
 * would be handed to every Basic buyer on every purchase unless the checkout
 * says otherwise. `checkout_options.skip_trial` is that "otherwise", and these
 * tests are about when the server sets it.
 *
 * The decision is made purely from stored state — the request body carries
 * {plan, billing} and nothing that could ask for a trial.
 */
describe("billing: who gets the free trial", () => {
  it("grants it to a first-time Basic monthly buyer", async () => {
    const res = await checkout("basic", "monthly");
    expect(res.status).toBe(200);
    expect(soldVariant()).toBe("1001");
    expect(skippedTrial()).toBe(false);
  });

  it("REFUSES a second trial once one has been consumed", async () => {
    // The abuse this exists to stop: take the trial, cancel it, come back. A
    // cancelled trial leaves planStatus in lapsed/none, which the
    // subscription-exists check happily allows a fresh checkout from — so
    // without skip_trial the same account could trial indefinitely, free.
    await UserModel.updateOne(
      { email: "checkout@example.com" },
      { $set: { trialConsumedAt: new Date() } },
    );

    const res = await checkout("basic", "monthly");
    expect(res.status).toBe(200);
    // Same variant as above — only the trial is withheld.
    expect(soldVariant()).toBe("1001");
    expect(skippedTrial()).toBe(true);
  });

  it("never trials the yearly variant", async () => {
    // Basic yearly carries the same trial in the dashboard, and a trial there
    // would attempt roughly twelve times the charge on day two.
    const res = await checkout("basic", "yearly");
    expect(res.status).toBe(200);
    expect(soldVariant()).toBe("1002");
    expect(skippedTrial()).toBe(true);
  });

  it("never trials the other tiers", async () => {
    // They carry no trial today. Asserted anyway: this is an allowlist, so a
    // trial switched on for Pro in the dashboard tomorrow stays unsold rather
    // than being given away silently.
    for (const [plan, variant] of [
      ["pro", "2001"],
      ["premium", "3001"],
    ] as const) {
      createCheckout.mockClear();
      await releaseCheckoutLock();
      const res = await checkout(plan, "monthly");
      expect(res.status).toBe(200);
      expect(soldVariant()).toBe(variant);
      expect(skippedTrial(), `${plan} must not be trialled`).toBe(true);
    }
  });

  it("withholds the trial entirely when TRIAL_DAYS is zero", async () => {
    const { env } = await import("../src/config/env.js");
    const before = env.TRIAL_DAYS;
    (env as { TRIAL_DAYS: number }).TRIAL_DAYS = 0;
    try {
      const res = await checkout("basic", "monthly");
      expect(res.status).toBe(200);
      expect(skippedTrial()).toBe(true);
    } finally {
      (env as { TRIAL_DAYS: number }).TRIAL_DAYS = before;
    }
  });

  it("still sells every tier with the extra variant configured", async () => {
    // hasAllVariants() used to compare PLAN_BY_VARIANT.size against an expected
    // 6. The trial variant makes it 7, which would have turned this route into
    // a blanket 503 — refusing paid purchases, not just trials.
    const first = await checkout("pro", "monthly");
    expect(first.status).toBe(200);
    await releaseCheckoutLock();

    const second = await checkout("premium", "yearly");
    expect(second.status).toBe(200);
    expect(soldVariant(1)).toBe("3002");
  });
});
