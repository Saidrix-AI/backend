import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * The paywall.
 *
 * There is no free tier, so every feature router is shut until a subscription
 * is paying for it — but signing in, reading your own profile and reaching the
 * billing API must all keep working, or a lapsed account has no way back in.
 *
 * The env is set before importing app.js because `isBillingEnabled()` is read
 * from the module-level config; with billing unconfigured the middleware no-ops
 * by design, which is exactly what would make this test vacuous.
 */
process.env.LEMONSQUEEZY_API_KEY = "test-api-key";
process.env.LEMONSQUEEZY_STORE_ID = "1";
process.env.LEMONSQUEEZY_WEBHOOK_SECRET = "test-signing-secret";
// Pinned, not inherited. Without this the trial assertions below read whatever
// TRIAL_DAYS the developer happens to have in their own .env, so "offers
// nothing when no trial is configured" passed or failed depending on the
// machine. The `withTrial` helper turns it on where a test needs it.
process.env.TRIAL_DAYS = "0";

const { app } = await import("../src/app.js");
const { UserModel } = await import("../src/database/models/user.model.js");
const { signAccessToken } = await import("../src/services/token.service.js");

let mongo: MongoMemoryServer;
let token: string;
let userId: string;

/** One representative GET behind each gated router. */
const GATED = [
  "/api/courses",
  "/api/courses/active",
  "/api/projects",
  "/api/progress/enrollments",
  "/api/routine",
];

/** Reachable with no plan at all — the way back in. */
const OPEN = ["/api/user/profile", "/api/billing/subscription", "/api/billing/invoices"];

async function setPlanState(planStatus: string, extra: Record<string, unknown> = {}) {
  await UserModel.updateOne({ _id: userId }, { $set: { planStatus, ...extra } });
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
  await UserModel.deleteMany({});
  const user = await UserModel.create({
    name: "Paywall Tester",
    username: `pay-${Date.now()}`,
    email: `pay-${Date.now()}@example.com`,
    passwordHash: "x",
  });
  userId = String(user._id);
  token = signAccessToken(userId, user.email);
});

describe("with no subscription", () => {
  for (const path of GATED) {
    it(`402s ${path}`, async () => {
      const res = await request(app).get(path).set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(402);
      expect(res.body.code).toBe("subscription_required");
    });
  }

  for (const path of OPEN) {
    it(`still serves ${path}`, async () => {
      const res = await request(app).get(path).set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
    });
  }

  it("still 401s an unauthenticated request rather than 402ing it", async () => {
    // Missing payment is not the reason a request with no token fails, and
    // answering 402 would send an anonymous visitor to a billing page.
    const res = await request(app).get("/api/courses");
    expect(res.status).toBe(401);
  });

  it("distinguishes 'never subscribed' from 'ended' in the message", async () => {
    const fresh = await request(app).get("/api/courses").set("Authorization", `Bearer ${token}`);
    expect(fresh.body.message).toContain("Choose a plan");

    await setPlanState("lapsed", { plan: "pro" });
    const ended = await request(app).get("/api/courses").set("Authorization", `Bearer ${token}`);
    expect(ended.body.message).toContain("ended");
  });
});

describe("with an active subscription", () => {
  it("opens every gated route", async () => {
    await setPlanState("active", { plan: "pro" });
    for (const path of GATED) {
      const res = await request(app).get(path).set("Authorization", `Bearer ${token}`);
      expect(res.status, `${path} should be open`).toBe(200);
    }
  });
});

describe("a cancelled subscription inside its grace period", () => {
  it("stays open until the end date, and shuts after it", async () => {
    await setPlanState("grace", {
      plan: "pro",
      planExpiresAt: new Date(Date.now() + 60_000),
    });
    const during = await request(app).get("/api/courses").set("Authorization", `Bearer ${token}`);
    expect(during.status).toBe(200);

    // Expiry is re-checked at request time, so a missed `subscription_expired`
    // webhook cannot leave a cancelled account open indefinitely: the stored
    // status still says "grace" here and access is refused anyway.
    await setPlanState("grace", { planExpiresAt: new Date(Date.now() - 1000) });
    const after = await request(app).get("/api/courses").set("Authorization", `Bearer ${token}`);
    expect(after.status).toBe(402);
  });
});

/**
 * A free trial whose charge failed.
 *
 * The rule is stricter than an ordinary lapse: nothing opens until the payment
 * clears. The API has to be the one enforcing that, because the client guard is
 * only a routing hint — but the way back in (auth, profile, billing) must stay
 * reachable, or the student is locked out of fixing it too.
 */
describe("with a failed trial payment", () => {
  for (const path of GATED) {
    it(`locks ${path}`, async () => {
      await setPlanState("payment_required", { plan: "basic" });
      const res = await request(app).get(path).set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(402);
      // A distinct code: the client sends this state to /complete-payment
      // rather than to the billing page, which would tell them to "renew" a
      // subscription that has never worked.
      expect(res.body.code).toBe("payment_required");
    });
  }

  for (const path of OPEN) {
    it(`leaves ${path} reachable`, async () => {
      await setPlanState("payment_required", { plan: "basic" });
      const res = await request(app).get(path).set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
    });
  }

  it("says what is actually wrong", async () => {
    await setPlanState("payment_required", { plan: "basic" });
    const res = await request(app).get("/api/courses").set("Authorization", `Bearer ${token}`);
    expect(res.body.message).toContain("payment did not go through");
  });

  it("is reported verbatim on the session payload, not flattened to lapsed", async () => {
    // effectiveStatus() collapses anything that has run out into "lapsed".
    // payment_required must survive that, or the client cannot tell the two
    // apart and the whole reason for the separate status disappears.
    await setPlanState("payment_required", { plan: "basic" });
    const res = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${token}`);
    expect(res.body.data.user.planStatus).toBe("payment_required");
  });
});

describe("the session payload", () => {
  it("carries the plan state the client routes on", async () => {
    await setPlanState("active", { plan: "premium" });
    const res = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${token}`);
    expect(res.body.data.user.plan).toBe("premium");
    expect(res.body.data.user.planStatus).toBe("active");
  });

  it("reports a run-out grace period as lapsed, not as grace", async () => {
    await setPlanState("grace", { plan: "pro", planExpiresAt: new Date(Date.now() - 1000) });
    const res = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${token}`);
    expect(res.body.data.user.planStatus).toBe("lapsed");
  });
});

/**
 * A deployment with no LemonSqueezy keys cannot sell a plan, so it must not
 * charge for one — and the CLIENT has to be told the same thing. Reporting
 * `planStatus: "none"` here while the API serves every route is what had local
 * development bouncing every login to a pricing page whose buttons 503.
 */
describe("with billing switched off", () => {
  it("opens the API and says so on the session payload", async () => {
    const { env } = await import("../src/config/env.js");
    const key = env.LEMONSQUEEZY_API_KEY;
    (env as { LEMONSQUEEZY_API_KEY?: string }).LEMONSQUEEZY_API_KEY = undefined;
    try {
      const gated = await request(app).get("/api/courses").set("Authorization", `Bearer ${token}`);
      expect(gated.status).toBe(200);

      const me = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${token}`);
      expect(me.body.data.user.planStatus).toBe("active");
    } finally {
      (env as { LEMONSQUEEZY_API_KEY?: string }).LEMONSQUEEZY_API_KEY = key;
    }
  });
});

describe("the plan is not settable from the browser", () => {
  it("has no PUT /api/user/plan at all", async () => {
    // The endpoint this replaces let any logged-in account award itself
    // Premium. Its absence is the security property, so it is asserted.
    const res = await request(app)
      .put("/api/user/plan")
      .set("Authorization", `Bearer ${token}`)
      .send({ plan: "premium" });
    expect(res.status).toBe(404);

    const user = await UserModel.findById(userId).lean();
    expect(user!.plan).toBeNull();
  });
});

/**
 * What the session payload says about a free trial.
 *
 * Both fields are display hints with no authority — the server picks the
 * checkout variant from stored state regardless of what the client believes —
 * but they have to be right, because one of them is the sentence that warns a
 * student their card is about to be charged.
 */
describe("trial fields on the session payload", () => {
  async function me() {
    const res = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${token}`);
    return res.body.data.user;
  }

  /** Declares a trial for the duration of `run`, then puts TRIAL_DAYS back. */
  async function withTrial(run: () => Promise<void>) {
    const { env } = await import("../src/config/env.js");
    const box = env as { TRIAL_DAYS: number };
    const before = box.TRIAL_DAYS;
    box.TRIAL_DAYS = 1;
    try {
      await run();
    } finally {
      box.TRIAL_DAYS = before;
    }
  }

  it("offers a trial to an account that has never had one", async () => {
    await withTrial(async () => {
      expect((await me()).trialEligible).toBe(true);
    });
  });

  it("refuses a second trial, forever", async () => {
    await withTrial(async () => {
      await UserModel.updateOne({ _id: userId }, { $set: { trialConsumedAt: new Date() } });
      expect((await me()).trialEligible).toBe(false);
    });
  });

  it("offers nothing when no trial is configured", async () => {
    // Most deployments, including every local one. Advertising a trial that
    // cannot be sold would be worse than not advertising it.
    expect((await me()).trialEligible).toBe(false);
  });

  it("carries the trial end date for the countdown banner", async () => {
    const endsAt = new Date(Date.now() + 3_600_000);
    await UserModel.updateOne({ _id: userId }, { $set: { trialEndsAt: endsAt } });
    expect((await me()).trialEndsAt).toBe(endsAt.toISOString());
  });

  it("carries null when no trial is running", async () => {
    expect((await me()).trialEndsAt).toBeNull();
  });
});
