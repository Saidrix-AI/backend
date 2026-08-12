import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * `GET /api/config` — what the landing page is allowed to claim.
 *
 * The landing page has no session to read, so this is the only thing standing
 * between "we offer a free trial" as a fact and as a lie. It must be reachable
 * without signing in, and it must never say a trial exists on a deployment that
 * cannot sell one.
 */
process.env.LEMONSQUEEZY_API_KEY = "test-api-key";
process.env.LEMONSQUEEZY_STORE_ID = "1";
process.env.LEMONSQUEEZY_WEBHOOK_SECRET = "test-signing-secret";
// Pinned so these assertions never read the developer's own .env. Each test
// sets the value it needs via `withEnv`; this is the floor they restore to.
process.env.TRIAL_DAYS = "0";

const { app } = await import("../src/app.js");
const { env } = await import("../src/config/env.js");

let mongo: MongoMemoryServer;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

/** Swaps one env value for the duration of `run`, then puts it back. */
async function withEnv(
  key: "TRIAL_DAYS" | "LEMONSQUEEZY_API_KEY",
  value: string | number | undefined,
  run: () => Promise<void>,
) {
  const box = env as Record<string, unknown>;
  const before = box[key];
  box[key] = value;
  try {
    await run();
  } finally {
    box[key] = before;
  }
}

describe("public config", () => {
  it("is readable with no session at all", async () => {
    // Every other API route needs a token. This one cannot.
    const res = await request(app).get("/api/config");
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it("advertises a trial once TRIAL_DAYS is set", async () => {
    await withEnv("TRIAL_DAYS", 1, async () => {
      const res = await request(app).get("/api/config");
      expect(res.body.data.trialAvailable).toBe(true);
      expect(res.body.data.trialDays).toBe(1);
      // Basic only — the landing copy names the plan, and naming the wrong one
      // would promise a trial on tiers that are never sold with one.
      expect(res.body.data.trialPlan).toBe("basic");
    });
  });

  it("advertises nothing at TRIAL_DAYS zero", async () => {
    await withEnv("TRIAL_DAYS", 0, async () => {
      const res = await request(app).get("/api/config");
      expect(res.body.data.trialAvailable).toBe(false);
    });
  });

  it("advertises nothing when billing is switched off entirely", async () => {
    // A trial with no way to check out is still nothing to sell.
    await withEnv("TRIAL_DAYS", 1, async () => {
      await withEnv("LEMONSQUEEZY_API_KEY", undefined, async () => {
        const res = await request(app).get("/api/config");
        expect(res.body.data.trialAvailable).toBe(false);
      });
    });
  });

  it("leaks nothing about the store or any account", async () => {
    await withEnv("TRIAL_DAYS", 1, async () => {
      const res = await request(app).get("/api/config");
      const body = JSON.stringify(res.body);
      expect(body).not.toContain("test-api-key");
      expect(body).not.toContain("test-signing-secret");
      expect(Object.keys(res.body.data).sort()).toEqual([
        "trialAvailable",
        "trialDays",
        "trialPlan",
      ]);
    });
  });
});
