import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gatedLlmCall, isTransient } from "../src/agents/shared/llmGate.js";
import { env } from "../src/config/env.js";

/*
 * The gate answers two provider failures, and they call for opposite things.
 *
 * A 429 is a fact about the ACCOUNT: this gateway counts failed attempts
 * against the quota ("Maximum 10 requests within 1 minutes, Including the
 * number of failed attempts"), so every caller has to stop and wait out a full
 * window. A 503 is a fact about ONE REQUEST: measured 2026-08-20, the free tier
 * sheds load in bursts — "cache-only admission rejected a cold or overloaded
 * request" — while other calls, and the paid model on the same key, are fine.
 * Treating the second like the first would stall the whole app over one cold
 * request; treating the first like the second would burn the quota it is
 * waiting for. These tests pin them apart.
 */

const err = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });

/**
 * Real backoffs are seconds long; fake timers keep the suite instant.
 *
 * The rejection is caught before the timers are advanced: the call settles
 * during runAllTimersAsync, and without a handler already attached vitest sees
 * it as an unhandled rejection before the assertion gets to it.
 */
async function runWithFakeTimers<T>(fn: () => Promise<T>): Promise<T> {
  const settled = fn().then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  await vi.runAllTimersAsync();
  const result = await settled;
  if (result.ok) return result.value;
  throw result.error;
}

beforeEach(() => {
  vi.useFakeTimers();
  // tests/setup.ts turns the throttle off; these tests are about the retry
  // behaviour, not the rate window, so leaving it off keeps them deterministic.
  env.LLM_MAX_CONCURRENCY = 0;
  env.LLM_REQUESTS_PER_MINUTE = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("isTransient", () => {
  it("treats 5xx and status-less network failures as retryable", () => {
    expect(isTransient(err(503))).toBe(true);
    expect(isTransient(err(502))).toBe(true);
    expect(isTransient(err(500))).toBe(true);
    expect(isTransient(new Error("fetch failed"))).toBe(true);
    expect(isTransient(new Error("socket hang up"))).toBe(true);
    expect(isTransient(new Error("Request timed out."))).toBe(true);
    expect(isTransient(Object.assign(new Error("x"), { code: "ECONNRESET" }))).toBe(true);
  });

  /*
   * The important negative: a 4xx that is not 429 is OUR request being wrong.
   * It would fail identically on the next attempt and on a fallback model, so
   * retrying it only spends the rate window to be told so again.
   */
  it("does not retry a request the provider has rejected on its merits", () => {
    expect(isTransient(err(400))).toBe(false);
    expect(isTransient(err(401))).toBe(false);
    expect(isTransient(err(404))).toBe(false);
    expect(isTransient(err(422))).toBe(false);
  });

  it("reads the status through a wrapped cause", () => {
    expect(isTransient({ cause: err(503) })).toBe(true);
    expect(isTransient({ cause: err(400) })).toBe(false);
  });
});

describe("gatedLlmCall", () => {
  it("retries a transient failure and returns the eventual success", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(err(503))
      .mockRejectedValueOnce(err(503))
      .mockResolvedValueOnce("ok");

    await expect(runWithFakeTimers(() => gatedLlmCall(fn))).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("retries a dropped socket the same way", async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error("fetch failed")).mockResolvedValueOnce("ok");

    await expect(runWithFakeTimers(() => gatedLlmCall(fn))).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("gives up after the transient budget and rethrows the provider's error", async () => {
    const fn = vi.fn().mockRejectedValue(err(503));

    await expect(runWithFakeTimers(() => gatedLlmCall(fn))).rejects.toMatchObject({ status: 503 });
    // First call plus the backoffs. Kept deliberately small: this provider's
    // bad patches last minutes, and each failed attempt still spends a slot in
    // a window that counts failures.
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("does not retry a 4xx at all", async () => {
    const fn = vi.fn().mockRejectedValue(err(400));

    await expect(runWithFakeTimers(() => gatedLlmCall(fn))).rejects.toMatchObject({ status: 400 });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("still retries a 429, on its own budget", async () => {
    const fn = vi.fn().mockRejectedValueOnce(err(429)).mockResolvedValueOnce("ok");

    await expect(runWithFakeTimers(() => gatedLlmCall(fn))).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  /*
   * The budgets must not share a counter: a job that survived a rough patch of
   * 503s should still have its full 429 allowance, and vice versa.
   */
  it("keeps the transient and rate budgets separate", async () => {
    // Transient budget spent to its last attempt, then the full 429 allowance.
    const fn = vi
      .fn()
      .mockRejectedValueOnce(err(503))
      .mockRejectedValueOnce(err(503))
      .mockRejectedValueOnce(err(429))
      .mockRejectedValueOnce(err(429))
      .mockResolvedValueOnce("ok");

    await expect(runWithFakeTimers(() => gatedLlmCall(fn))).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(5);
  });
});
