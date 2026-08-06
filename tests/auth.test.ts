import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { app } from "../src/app.js";
import { VerificationTokenModel } from "../src/database/models/verificationToken.model.js";
import { RefreshTokenModel } from "../src/database/models/refreshToken.model.js";
import { sha256 } from "../src/utils/crypto.js";
import { MAX_OTP_ATTEMPTS } from "../src/services/verification.service.js";
import { MAX_FAILED_ATTEMPTS } from "../src/services/auth.service.js";

let mongo: MongoMemoryServer;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

const base = {
  name: "Test Student",
  username: "teststudent",
  email: "student@example.com",
  password: "supersecret123",
};

describe("auth: register & login", () => {
  it("registers a new user, returns an access token + user, sets refresh cookie", async () => {
    const res = await request(app).post("/api/auth/register").send(base);
    expect(res.status).toBe(201);
    expect(res.body.data.accessToken).toBeTypeOf("string");
    expect(res.body.data.user.email).toBe(base.email);
    expect(res.body.data.user.emailVerified).toBe(false);
    const cookies = res.headers["set-cookie"] as unknown as string[];
    expect(cookies.some((c) => c.startsWith("refresh_token="))).toBe(true);
  });

  it("rejects duplicate email", async () => {
    const res = await request(app)
      .post("/api/auth/register")
      .send({ ...base, username: "different" });
    expect(res.status).toBe(409);
  });

  it("rejects a duplicate username, and names that field", async () => {
    const res = await request(app)
      .post("/api/auth/register")
      .send({ ...base, email: "someone-else@example.com" });
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/username/i);
  });

  // Usernames are stored lowercase, so casing can't be used to squat a name.
  it("rejects a duplicate username in different casing", async () => {
    const res = await request(app)
      .post("/api/auth/register")
      .send({ ...base, username: "TestStudent", email: "casing@example.com" });
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/username/i);
  });

  it("rejects a weak password", async () => {
    const res = await request(app).post("/api/auth/register").send({
      name: "Weak",
      username: "weakuser",
      email: "weak@example.com",
      password: "allletters",
    });
    expect(res.status).toBe(400);
  });

  it("logs in by email", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ identifier: base.email, password: base.password });
    expect(res.status).toBe(200);
    expect(res.body.data.accessToken).toBeTypeOf("string");
  });

  it("logs in by username", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ identifier: base.username, password: base.password });
    expect(res.status).toBe(200);
  });

  it("rejects a wrong password", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ identifier: base.email, password: "wrongpassword1" });
    expect(res.status).toBe(401);
  });
});

// Powers the signup form's live check. Every answer is a 200 with a verdict —
// the form renders one inline line and shouldn't have to branch on status codes.
describe("auth: username availability", () => {
  const check = (username: string) =>
    request(app).get("/api/auth/check-username").query({ username });

  it("reports a free username as available", async () => {
    const res = await check("brand.new_name");
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ username: "brand.new_name", available: true });
  });

  it("reports a taken username as unavailable, regardless of casing", async () => {
    const res = await check("TestStudent");
    expect(res.status).toBe(200);
    expect(res.body.data.available).toBe(false);
    expect(res.body.data.username).toBe("teststudent");
    expect(res.body.data.reason).toMatch(/taken/i);
  });

  it("explains a malformed username instead of erroring", async () => {
    const short = await check("ab");
    expect(short.status).toBe(200);
    expect(short.body.data.available).toBe(false);
    expect(short.body.data.reason).toMatch(/3 characters/);

    const bad = await check("no spaces!");
    expect(bad.status).toBe(200);
    expect(bad.body.data.available).toBe(false);
    expect(bad.body.data.reason).toMatch(/letters, numbers/i);
  });

  it("treats a missing username as unavailable, not a crash", async () => {
    const res = await request(app).get("/api/auth/check-username");
    expect(res.status).toBe(200);
    expect(res.body.data.available).toBe(false);
  });

  // The check and the register schema read from one definition; if they ever
  // drift, the form promises a name that submit then refuses.
  it("agrees with register: a name it calls available registers", async () => {
    const name = "agreeing.user_1";
    const available = await check(name);
    expect(available.body.data.available).toBe(true);

    const res = await request(app).post("/api/auth/register").send({
      name: "Agreeing",
      username: name,
      email: "agreeing@example.com",
      password: "supersecret123",
    });
    expect(res.status).toBe(201);
    expect((await check(name)).body.data.available).toBe(false);
  });
});

describe("auth: account lockout", () => {
  it("locks the account after repeated failures", async () => {
    await request(app).post("/api/auth/register").send({
      name: "Locky",
      username: "lockuser",
      email: "lock@example.com",
      password: "supersecret123",
    });

    for (let i = 0; i < 5; i++) {
      await request(app)
        .post("/api/auth/login")
        .send({ identifier: "lock@example.com", password: "wrongpass1" });
    }

    // Correct password now, but the account is locked.
    const res = await request(app)
      .post("/api/auth/login")
      .send({ identifier: "lock@example.com", password: "supersecret123" });
    expect(res.status).toBe(423);
  });

  it("counts every parallel wrong password against the lockout cap", async () => {
    await request(app).post("/api/auth/register").send({
      name: "Parallel Lock",
      username: "parallellock",
      email: "parallellock@example.com",
      password: "supersecret123",
    });

    // The whole budget spent at once, the way a credential-stuffing script
    // would — not one guess at a time. Incrementing the counter with a
    // read-then-write lets these all read the same starting value and write
    // the same incremented one, so the cap is never reached and the account
    // stays open. Every guess has to be counted for the lockout to mean
    // anything.
    const guesses = await Promise.all(
      Array.from({ length: MAX_FAILED_ATTEMPTS }, () =>
        request(app)
          .post("/api/auth/login")
          .send({ identifier: "parallellock@example.com", password: "wrongpass1" }),
      ),
    );
    expect(guesses.every((g) => g.status === 401)).toBe(true);

    // The correct password must now be refused: the budget is spent.
    const res = await request(app)
      .post("/api/auth/login")
      .send({ identifier: "parallellock@example.com", password: "supersecret123" });
    expect(res.status).toBe(423);
  });
});

/** The CSRF token the server just set, as a browser would read it back. */
function csrfFrom(res: request.Response): string {
  const cookies = (res.headers["set-cookie"] as unknown as string[]) ?? [];
  const raw = cookies.find((c) => c.startsWith("csrf_token="));
  if (!raw) throw new Error("no csrf_token cookie was set");
  return decodeURIComponent(raw.split(";")[0].split("=")[1]);
}

describe("auth: refresh & logout", () => {
  it("rotates the refresh token and issues a new access token, then logs out", async () => {
    const agent = request.agent(app);
    const registered = await agent.post("/api/auth/register").send({
      name: "Refresher",
      username: "refreshuser",
      email: "refresh@example.com",
      password: "supersecret123",
    });

    // Echoing the cookie back in the header is what a browser does; the routes
    // that run on the refresh cookie alone require it.
    const refreshed = await agent
      .post("/api/auth/refresh")
      .set("X-CSRF-Token", csrfFrom(registered))
      .send();
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.data.accessToken).toBeTypeOf("string");

    const loggedOut = await agent
      .post("/api/auth/logout")
      .set("X-CSRF-Token", csrfFrom(refreshed))
      .send();
    expect(loggedOut.status).toBe(200);

    // After logout the (now-cleared) cookie can't refresh.
    const afterLogout = await agent.post("/api/auth/refresh").send();
    expect(afterLogout.status).toBe(401);
  });

  it("refuses a refresh that carries the cookie but not the CSRF header", async () => {
    const agent = request.agent(app);
    await agent.post("/api/auth/register").send({
      name: "Forged",
      username: "forgeduser",
      email: "forged@example.com",
      password: "supersecret123",
    });

    // What a cross-origin page can manage: the browser attaches the cookies, but
    // the same-origin policy stops it reading them to build the header.
    const forged = await agent.post("/api/auth/refresh").send();
    expect(forged.status).toBe(403);
  });

  it("refuses a refresh whose CSRF header does not match the cookie", async () => {
    const agent = request.agent(app);
    await agent.post("/api/auth/register").send({
      name: "Mismatch",
      username: "mismatchuser",
      email: "mismatch@example.com",
      password: "supersecret123",
    });

    const forged = await agent
      .post("/api/auth/refresh")
      .set("X-CSRF-Token", "a".repeat(64))
      .send();
    expect(forged.status).toBe(403);
  });

  it("still refreshes a session that predates the CSRF cookie", async () => {
    // The grace path: neither cookie nor header. Sessions issued before the
    // check existed must not be logged out by the deploy that added it.
    const registered = await request(app).post("/api/auth/register").send({
      name: "Legacy",
      username: "legacyuser",
      email: "legacy@example.com",
      password: "supersecret123",
    });
    const refreshCookie = (registered.headers["set-cookie"] as unknown as string[])
      .find((c) => c.startsWith("refresh_token="))!
      .split(";")[0];

    const refreshed = await request(app)
      .post("/api/auth/refresh")
      .set("Cookie", refreshCookie)
      .send();
    expect(refreshed.status).toBe(200);
    // ...and it is only a one-time pass: the response re-issues the pair.
    expect(csrfFrom(refreshed)).toBeTypeOf("string");
  });
});

describe("auth: email verification", () => {
  it("verifies email with a valid OTP", async () => {
    const reg = await request(app).post("/api/auth/register").send({
      name: "Verify",
      username: "verifyuser",
      email: "verify@example.com",
      password: "supersecret123",
    });
    const { accessToken, user } = reg.body.data;

    // Register emails an OTP asynchronously (fire-and-forget). Wait for that
    // write to land, then overwrite it with a known code so the test is
    // deterministic (the real code is emailed; only its hash is stored).
    await vi.waitFor(async () => {
      const existing = await VerificationTokenModel.findOne({
        userId: user.id,
        type: "email_verify",
      });
      expect(existing).not.toBeNull();
    });
    await VerificationTokenModel.deleteMany({ userId: user.id, type: "email_verify" });
    await VerificationTokenModel.create({
      userId: user.id,
      type: "email_verify",
      codeHash: sha256("123456"),
      expiresAt: new Date(Date.now() + 60_000),
    });

    const res = await request(app)
      .post("/api/auth/verify-email")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ code: "123456" });
    expect(res.status).toBe(200);

    const me = await request(app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${accessToken}`);
    expect(me.body.data.user.emailVerified).toBe(true);
  });

  it("counts every parallel wrong guess against the attempt cap", async () => {
    const reg = await request(app).post("/api/auth/register").send({
      name: "Bruteforce",
      username: "bruteuser",
      email: "brute@example.com",
      password: "supersecret123",
    });
    const { accessToken, user } = reg.body.data;

    await vi.waitFor(async () => {
      const existing = await VerificationTokenModel.findOne({
        userId: user.id,
        type: "email_verify",
      });
      expect(existing).not.toBeNull();
    });
    await VerificationTokenModel.deleteMany({ userId: user.id, type: "email_verify" });
    await VerificationTokenModel.create({
      userId: user.id,
      type: "email_verify",
      codeHash: sha256("123456"),
      expiresAt: new Date(Date.now() + 60_000),
    });

    // The whole budget spent at once, the way a brute-force script would — not
    // one guess at a time. Every one must be counted.
    const guesses = await Promise.all(
      Array.from({ length: MAX_OTP_ATTEMPTS }, (_, i) =>
        request(app)
          .post("/api/auth/verify-email")
          .set("Authorization", `Bearer ${accessToken}`)
          .send({ code: String(100000 + i) }),
      ),
    );
    expect(guesses.every((g) => g.status === 400)).toBe(true);

    const record = await VerificationTokenModel.findOne({
      userId: user.id,
      type: "email_verify",
    });
    expect(record?.attempts).toBe(MAX_OTP_ATTEMPTS);

    // Budget exhausted: even the RIGHT code must now be refused.
    const correct = await request(app)
      .post("/api/auth/verify-email")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ code: "123456" });
    expect(correct.status).toBe(429);

    const me = await request(app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${accessToken}`);
    expect(me.body.data.user.emailVerified).toBe(false);
  });
});

describe("auth: password reset", () => {
  it("does not reveal whether an email exists", async () => {
    const res = await request(app)
      .post("/api/auth/forgot-password")
      .send({ email: "nobody@example.com" });
    expect(res.status).toBe(200);
  });

  it("resets the password and revokes existing sessions", async () => {
    const reg = await request(app).post("/api/auth/register").send({
      name: "Resetter",
      username: "resetuser",
      email: "reset@example.com",
      password: "supersecret123",
    });
    const userId = reg.body.data.user.id;

    await VerificationTokenModel.create({
      userId,
      type: "password_reset",
      codeHash: sha256("reset-token-abc"),
      expiresAt: new Date(Date.now() + 60_000),
    });

    const res = await request(app)
      .post("/api/auth/reset-password")
      .send({ token: "reset-token-abc", newPassword: "brandnewpass9" });
    expect(res.status).toBe(200);

    // Old refresh tokens are gone.
    const remaining = await RefreshTokenModel.countDocuments({ userId });
    expect(remaining).toBe(0);

    // New password works.
    const login = await request(app)
      .post("/api/auth/login")
      .send({ identifier: "reset@example.com", password: "brandnewpass9" });
    expect(login.status).toBe(200);
  });

  it("rejects a reset token that has already been used", async () => {
    const reg = await request(app).post("/api/auth/register").send({
      name: "Once Only",
      username: "onceonly",
      email: "once@example.com",
      password: "supersecret123",
    });
    const userId = reg.body.data.user.id;

    await VerificationTokenModel.create({
      userId,
      type: "password_reset",
      codeHash: sha256("single-use-token"),
      expiresAt: new Date(Date.now() + 60_000),
    });

    const first = await request(app)
      .post("/api/auth/reset-password")
      .send({ token: "single-use-token", newPassword: "firstpassword1" });
    expect(first.status).toBe(200);

    // The same link, clicked again — must not work a second time.
    const second = await request(app)
      .post("/api/auth/reset-password")
      .send({ token: "single-use-token", newPassword: "secondpassword2" });
    expect(second.status).toBe(400);

    // And the second password must never have been applied.
    const stillFirst = await request(app)
      .post("/api/auth/login")
      .send({ identifier: "once@example.com", password: "firstpassword1" });
    expect(stillFirst.status).toBe(200);

    const secondRejected = await request(app)
      .post("/api/auth/login")
      .send({ identifier: "once@example.com", password: "secondpassword2" });
    expect(secondRejected.status).toBe(401);
  });

  it("reports link liveness without consuming the token", async () => {
    const reg = await request(app).post("/api/auth/register").send({
      name: "Checker",
      username: "checkeruser",
      email: "check@example.com",
      password: "supersecret123",
    });
    const userId = reg.body.data.user.id;

    await VerificationTokenModel.create({
      userId,
      type: "password_reset",
      codeHash: sha256("checkable-token"),
      expiresAt: new Date(Date.now() + 60_000),
    });

    const live = await request(app)
      .get("/api/auth/reset-password/check")
      .query({ token: "checkable-token" });
    expect(live.status).toBe(200);
    expect(live.body.data.valid).toBe(true);

    // Checking must not burn the link — opening the page twice is normal.
    const again = await request(app)
      .get("/api/auth/reset-password/check")
      .query({ token: "checkable-token" });
    expect(again.body.data.valid).toBe(true);

    const unknown = await request(app)
      .get("/api/auth/reset-password/check")
      .query({ token: "never-issued" });
    expect(unknown.body.data.valid).toBe(false);

    const missing = await request(app).get("/api/auth/reset-password/check");
    expect(missing.status).toBe(200);
    expect(missing.body.data.valid).toBe(false);

    // Still redeemable after all that checking.
    const reset = await request(app)
      .post("/api/auth/reset-password")
      .send({ token: "checkable-token", newPassword: "checkedpass1" });
    expect(reset.status).toBe(200);

    // And dead once redeemed.
    const spent = await request(app)
      .get("/api/auth/reset-password/check")
      .query({ token: "checkable-token" });
    expect(spent.body.data.valid).toBe(false);
  });

  it("reports an expired link as dead", async () => {
    const reg = await request(app).post("/api/auth/register").send({
      name: "Expired",
      username: "expireduser",
      email: "expired@example.com",
      password: "supersecret123",
    });

    await VerificationTokenModel.create({
      userId: reg.body.data.user.id,
      type: "password_reset",
      codeHash: sha256("stale-token"),
      expiresAt: new Date(Date.now() - 1000),
    });

    const res = await request(app)
      .get("/api/auth/reset-password/check")
      .query({ token: "stale-token" });
    expect(res.body.data.valid).toBe(false);

    const reset = await request(app)
      .post("/api/auth/reset-password")
      .send({ token: "stale-token", newPassword: "shouldnotwork1" });
    expect(reset.status).toBe(400);
  });

  it("lets only one of two concurrent redemptions of the same token win", async () => {
    const reg = await request(app).post("/api/auth/register").send({
      name: "Racer",
      username: "raceruser",
      email: "race@example.com",
      password: "supersecret123",
    });
    const userId = reg.body.data.user.id;

    await VerificationTokenModel.create({
      userId,
      type: "password_reset",
      codeHash: sha256("race-token"),
      expiresAt: new Date(Date.now() + 60_000),
    });

    const [a, b] = await Promise.all([
      request(app)
        .post("/api/auth/reset-password")
        .send({ token: "race-token", newPassword: "racerpassone1" }),
      request(app)
        .post("/api/auth/reset-password")
        .send({ token: "race-token", newPassword: "racerpasstwo2" }),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 400]);
  });
});
