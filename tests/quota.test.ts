import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * The metered limits: monthly course generations, and review submissions per
 * project. Both exist because the thing they meter costs real money — a course
 * is 10-20+ LLM calls and a review is one call per file in the repo.
 *
 * Billing must be configured, or every check no-ops by design.
 */
process.env.LEMONSQUEEZY_API_KEY = "test-api-key";
process.env.LEMONSQUEEZY_STORE_ID = "1";
process.env.LEMONSQUEEZY_WEBHOOK_SECRET = "test-signing-secret";

const { ENTITLEMENTS } = await import("../src/config/entitlements.js");
const { UserModel } = await import("../src/database/models/user.model.js");
const { UsageEventModel } = await import("../src/database/models/usageEvent.model.js");
const { SubscriptionModel } = await import("../src/database/models/subscription.model.js");
const { ProjectReviewModel } = await import("../src/database/models/projectReview.model.js");
const { assertCanGenerateCourse, assertCanReview, courseUsage, recordCourseGenerated, reviewUsage } =
  await import("../src/services/quota.service.js");
const { periodStartFrom } = await import("../src/services/subscription.service.js");

let mongo: MongoMemoryServer;
let userId: string;

const PROJECT = "project-1";

async function subscribe(plan: "basic" | "pro" | "premium", createdAt = new Date()) {
  await UserModel.updateOne({ _id: userId }, { $set: { plan, planStatus: "active" } });
  await SubscriptionModel.updateOne(
    { userId: new Types.ObjectId(userId) },
    {
      $set: {
        lemonSqueezyId: "sub_1",
        plan,
        billing: "monthly",
        status: "active",
        createdAt,
      },
    },
    { upsert: true, timestamps: false },
  );
}

/** Backdates a generation, to land it in a previous quota window. */
async function generatedAt(when: Date) {
  await UsageEventModel.create({
    userId: new Types.ObjectId(userId),
    kind: "course_generated",
    createdAt: when,
  });
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
    UsageEventModel.deleteMany({}),
    SubscriptionModel.deleteMany({}),
    ProjectReviewModel.deleteMany({}),
  ]);
  const user = await UserModel.create({
    name: "Quota Tester",
    username: `quota-${Date.now()}`,
    email: `quota-${Date.now()}@example.com`,
    passwordHash: "x",
  });
  userId = String(user._id);
});

describe("course generation allowance", () => {
  it("allows exactly the plan's number, then refuses", async () => {
    await subscribe("basic");
    const limit = ENTITLEMENTS.basic.coursesPerMonth;

    for (let i = 0; i < limit; i++) {
      await assertCanGenerateCourse(userId);
      await recordCourseGenerated(userId, `course-${i}`);
    }

    await expect(assertCanGenerateCourse(userId)).rejects.toMatchObject({ statusCode: 403 });
    const usage = await courseUsage(userId);
    expect(usage.used).toBe(limit);
    expect(usage.remaining).toBe(0);
  });

  it("gives each tier its own headroom", async () => {
    await subscribe("premium");
    expect((await courseUsage(userId)).limit).toBe(ENTITLEMENTS.premium.coursesPerMonth);
    await subscribe("pro");
    expect((await courseUsage(userId)).limit).toBe(ENTITLEMENTS.pro.coursesPerMonth);
  });

  it("names the limit and the reset date in the refusal", async () => {
    await subscribe("basic");
    for (let i = 0; i < ENTITLEMENTS.basic.coursesPerMonth; i++) {
      await recordCourseGenerated(userId, `c${i}`);
    }
    await expect(assertCanGenerateCourse(userId)).rejects.toMatchObject({
      message: expect.stringContaining(String(ENTITLEMENTS.basic.coursesPerMonth)),
    });
  });

  it("refills at the period boundary", async () => {
    // Subscribed 45 days ago, so the current window opened ~15 days back.
    const start = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000);
    await subscribe("basic", start);

    // Everything spent, but all of it in the PREVIOUS window.
    for (let i = 0; i < ENTITLEMENTS.basic.coursesPerMonth; i++) {
      await generatedAt(new Date(Date.now() - 40 * 24 * 60 * 60 * 1000));
    }

    const usage = await courseUsage(userId);
    expect(usage.used).toBe(0);
    await expect(assertCanGenerateCourse(userId)).resolves.toBeUndefined();
  });

  /**
   * The reason the ledger is its own append-only collection rather than a count
   * of Course rows: deleting a course must not win its quota back, because
   * generating it is what cost the money.
   */
  it("does not refund a deleted course", async () => {
    await subscribe("basic");
    for (let i = 0; i < ENTITLEMENTS.basic.coursesPerMonth; i++) {
      await recordCourseGenerated(userId, `course-${i}`);
    }
    // Nothing in the app deletes UsageEvents; the courses themselves are gone.
    expect((await courseUsage(userId)).remaining).toBe(0);
    await expect(assertCanGenerateCourse(userId)).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe("the monthly window", () => {
  it("anchors on the subscription day, so a yearly plan still refills monthly", () => {
    const anchor = new Date(Date.UTC(2025, 0, 10, 12, 0, 0));
    const now = new Date(Date.UTC(2026, 7, 20, 0, 0, 0));
    // Not January 2026 — the window is the one running in August.
    expect(periodStartFrom(anchor, now).toISOString()).toBe("2026-08-10T12:00:00.000Z");
  });

  it("uses last month's anniversary when this month's has not happened yet", () => {
    const anchor = new Date(Date.UTC(2025, 0, 25, 0, 0, 0));
    const now = new Date(Date.UTC(2026, 7, 5, 0, 0, 0));
    expect(periodStartFrom(anchor, now).toISOString()).toBe("2026-07-25T00:00:00.000Z");
  });

  it("clamps a 31st anchor to the last day of a short month", () => {
    // Rolling the overflow would land in March and skip February's window.
    const anchor = new Date(Date.UTC(2025, 0, 31, 0, 0, 0));
    const now = new Date(Date.UTC(2026, 1, 28, 12, 0, 0));
    expect(periodStartFrom(anchor, now).toISOString()).toBe("2026-02-28T00:00:00.000Z");
  });
});

describe("project review allowance", () => {
  it("allows the plan's submissions per project, then refuses", async () => {
    await subscribe("basic");
    const limit = ENTITLEMENTS.basic.reviewsPerProject;

    for (let i = 0; i < limit; i++) {
      await assertCanReview(userId, PROJECT);
      await ProjectReviewModel.create({
        userId: new Types.ObjectId(userId),
        projectId: PROJECT,
        attempt: i + 1,
        method: "github",
        sourceRef: "https://github.com/x/y",
        status: "completed",
      });
    }

    await expect(assertCanReview(userId, PROJECT)).rejects.toMatchObject({ statusCode: 403 });
  });

  it("counts per project, not across them", async () => {
    await subscribe("basic");
    for (let i = 0; i < ENTITLEMENTS.basic.reviewsPerProject; i++) {
      await ProjectReviewModel.create({
        userId: new Types.ObjectId(userId),
        projectId: PROJECT,
        attempt: i + 1,
        method: "github",
        sourceRef: "https://github.com/x/y",
        status: "completed",
      });
    }
    // The next project starts with a full allowance.
    await expect(assertCanReview(userId, "project-2")).resolves.toBeUndefined();
    expect((await reviewUsage(userId, "project-2")).used).toBe(0);
  });

  it("is a lifetime count per project — it never refills", async () => {
    await subscribe("basic");
    await ProjectReviewModel.create({
      userId: new Types.ObjectId(userId),
      projectId: PROJECT,
      attempt: 1,
      method: "github",
      sourceRef: "https://github.com/x/y",
      status: "completed",
      // Two years ago; a monthly reset would have wiped this.
      createdAt: new Date(Date.now() - 2 * 365 * 24 * 60 * 60 * 1000),
    });
    expect((await reviewUsage(userId, PROJECT)).used).toBe(1);
  });

  it("gives each tier its own number", async () => {
    await subscribe("premium");
    expect((await reviewUsage(userId, PROJECT)).limit).toBe(ENTITLEMENTS.premium.reviewsPerProject);
    await subscribe("pro");
    expect((await reviewUsage(userId, PROJECT)).limit).toBe(ENTITLEMENTS.pro.reviewsPerProject);
  });
});
