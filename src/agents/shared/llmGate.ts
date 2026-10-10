/**
 * The one place every LLM request waits its turn.
 *
 * The generation pipeline fans out hard — a single lecture issues roughly
 * seventy model calls, many of them in parallel — and nothing used to stand
 * between that fan-out and the provider. That is fine against a provider with
 * headroom and fatal against one without: on 2026-08-12 the gateway in front of
 * this project's account began enforcing 2 requests per minute, and lecture
 * generation stopped completing at all. The first two calls succeeded, every
 * other call 429'd, and the whole job was discarded.
 *
 * EVERY path to the provider must come through here, not just the generation
 * fan-out. The chat agent called the model directly until 2026-08-31, and
 * because the cap is account-wide the two paths were spending one budget while
 * only one of them was counting: a single chat turn is a router call plus up to
 * MAX_TOOL_ITERATIONS streamed rounds, so it could exhaust a small cap on its
 * own and 429 the gated generation calls alongside it. If you add a new caller,
 * wrap it — the gate is only as accurate as its coverage.
 *
 * Two mechanisms, both off by default so a provider with headroom is unaffected:
 *
 *   LLM_MAX_CONCURRENCY      how many requests may be in flight at once
 *   LLM_REQUESTS_PER_MINUTE  how many may *start* in any rolling 60s
 *
 * And one that is always on: a 429 is retried after waiting out the window
 * rather than immediately. That is not a style preference — the gateway's own
 * message reads "Maximum 2 requests within 1 minutes, **Including the number of
 * failed attempts**", so a retry storm spends the very quota it is waiting for.
 * Retrying fast against a limiter that counts failures makes the outage longer.
 */

import { env } from "../../config/env.js";

const WINDOW_MS = 60_000;

/**
 * Extra wait before reusing a window slot.
 *
 * The provider's window is not the same clock as ours and runs slightly longer:
 * releasing at exactly WINDOW_MS + 25ms was measured 429ing every time, and
 * because this gateway counts failed attempts against the quota, a request that
 * arrives one second early does not merely get rejected — it spends the budget
 * it was waiting for, costing a whole extra window. Two seconds of patience is
 * far cheaper than that.
 */
const WINDOW_MARGIN_MS = 2_000;

/** Requests that have started inside the current rolling window. */
const starts: number[] = [];
let inFlight = 0;
const waiting: Array<() => void> = [];

/**
 * When the provider has told us to stop, and until when. Shared, not per-call.
 *
 * Without this the gate degrades to half its configured rate. Measured against
 * the live limiter at 2/min: two calls succeeded, and the three behind them each
 * woke up on their own timer, fired into a window the provider still considered
 * closed, ate another 429, and slept again — five calls took 242s where 120s was
 * the floor. A 429 is information about the *account*, so one caller learning it
 * has to stop all of them, and the window has to restart from that moment rather
 * than from whenever each caller happened to begin.
 */
let blockedUntil = 0;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function limits() {
  return {
    concurrency: env.LLM_MAX_CONCURRENCY > 0 ? env.LLM_MAX_CONCURRENCY : Infinity,
    perMinute: env.LLM_REQUESTS_PER_MINUTE > 0 ? env.LLM_REQUESTS_PER_MINUTE : Infinity,
  };
}

/** Drop start timestamps that have aged out of the rolling window. */
function prune(now: number): void {
  while (starts.length && now - starts[0] >= WINDOW_MS) starts.shift();
}

/**
 * How long until a slot frees up, or 0 if one is free now. Returns Infinity
 * when the block is the concurrency cap, which no amount of waiting clears —
 * that one is released by whoever is in flight, not by the clock.
 */
function waitFor(now: number): number {
  const { concurrency, perMinute } = limits();
  if (inFlight >= concurrency) return Infinity;
  if (now < blockedUntil) return blockedUntil - now;
  prune(now);
  if (starts.length < perMinute) return 0;
  return WINDOW_MS - (now - starts[0]) + WINDOW_MARGIN_MS;
}

/**
 * Records a provider refusal: everyone waits, and the rolling window restarts
 * from the far side of the block rather than carrying stale starts across it.
 */
function blockAll(untilMs: number): void {
  blockedUntil = Math.max(blockedUntil, untilMs);
  starts.length = 0;
}

function release(): void {
  inFlight--;
  waiting.shift()?.();
}

async function acquire(): Promise<void> {
  for (;;) {
    const delay = waitFor(Date.now());
    if (delay === 0) {
      inFlight++;
      starts.push(Date.now());
      return;
    }
    if (delay === Infinity) {
      // Concurrency-bound: sleep until a running request hands its slot over.
      await new Promise<void>((resolve) => waiting.push(resolve));
    } else {
      await sleep(delay);
    }
  }
}

/** HTTP status off an SDK error, whichever shape it arrived in. */
function statusOf(err: unknown): number | undefined {
  const e = err as { status?: number; response?: { status?: number }; cause?: unknown };
  return e?.status ?? e?.response?.status ?? (e?.cause ? statusOf(e.cause) : undefined);
}

function is429(err: unknown): boolean {
  return statusOf(err) === 429;
}

/**
 * A failure that says "try again", not "your request is wrong".
 *
 * This provider's free tier sheds load in bursts rather than degrading evenly:
 * measured 2026-08-20, it returned `503 openai_error` to every call for minutes
 * at a time — "cache-only admission rejected a cold or overloaded request" in
 * its own words — while the paid model on the same key answered normally. Some
 * of those arrive as a dropped socket with no status at all, so the message has
 * to be sniffed too.
 *
 * A 4xx that is not 429 is deliberately NOT transient: that is our request being
 * wrong, and retrying it just spends the rate window to be told so again.
 */
export function isTransient(err: unknown): boolean {
  const status = statusOf(err);
  if (status !== undefined) return status >= 500;
  const message = err instanceof Error ? `${err.message} ${String((err as { code?: string }).code ?? "")}` : String(err);
  return /fetch failed|socket hang up|terminated|timed out|network|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|UND_ERR/i.test(
    message,
  );
}

/**
 * Backoff for transient failures. Short and per-call on purpose — unlike a 429
 * this is not a fact about the account's quota, so the other callers are not
 * necessarily affected and must not be stopped.
 *
 * Two attempts, not more, and the reason is specific to this provider. Its bad
 * patches last MINUTES, not milliseconds, so no realistic backoff waits one out
 * — and every failed attempt still spends a slot in a window that counts
 * failures. Retrying harder therefore buys nothing and delays the one thing
 * that does work: LLM_FALLBACK_MODEL, which runs on different capacity. Keep
 * enough retries to ride out a genuine blip, then escalate.
 */
const TRANSIENT_BACKOFF_MS = [1_000, 4_000];

/** `Retry-After` in ms when the provider sends one, else a full window. */
function retryDelay(err: unknown): number {
  const headers = (err as { headers?: Record<string, string> })?.headers;
  const raw = headers?.["retry-after"];
  const secs = raw ? Number(raw) : NaN;
  return Number.isFinite(secs) && secs > 0 ? secs * 1000 + 250 : WINDOW_MS + 250;
}

/**
 * Runs `fn` under the concurrency + rate caps, retrying the two failures worth
 * retrying — and keeping them apart, because they call for opposite responses.
 *
 * A **429** is a fact about the account: everyone must stop, and the wait is a
 * full window. `retries` is deliberately small for it — against a limiter that
 * counts failed attempts, more retries is not more robustness, it is more spend
 * of the same budget.
 *
 * A **transient 5xx or dropped socket** is the opposite: it says nothing about
 * the quota, other callers may be fine, and the right answer is a short private
 * backoff. Blocking everyone for a minute over one cold request would turn a
 * blip into an outage, so that path never calls blockAll().
 *
 * The two budgets are counted separately: a run that survives a bad patch of
 * 503s must still have its full 429 allowance left.
 */
export async function gatedLlmCall<T>(fn: () => Promise<T>, retries = 2): Promise<T> {
  let rateAttempts = 0;
  let transientAttempts = 0;
  let pause = 0;

  for (;;) {
    // Slept before acquiring, never while holding a slot — a caller waiting out
    // its own backoff must not also be occupying the concurrency budget.
    if (pause) {
      await sleep(pause);
      pause = 0;
    }
    await acquire();
    try {
      return await fn();
    } catch (err) {
      if (is429(err)) {
        // Stop everyone, not just this caller — see blockedUntil. Done even on
        // the final attempt, so a caller that gives up still leaves the brake
        // on for the callers behind it.
        const delay = retryDelay(err);
        blockAll(Date.now() + delay);
        if (rateAttempts >= retries) throw err;
        rateAttempts++;
        console.warn(
          `[llm-gate] 429 from provider — holding all calls ${Math.round(delay / 1000)}s ` +
            `(attempt ${rateAttempts}/${retries})`,
        );
      } else if (isTransient(err)) {
        if (transientAttempts >= TRANSIENT_BACKOFF_MS.length) throw err;
        pause = TRANSIENT_BACKOFF_MS[transientAttempts];
        transientAttempts++;
        console.warn(
          `[llm-gate] transient provider failure (${describe(err)}) — retrying in ` +
            `${Math.round(pause / 1000)}s (attempt ${transientAttempts}/${TRANSIENT_BACKOFF_MS.length})`,
        );
      } else {
        throw err;
      }
    } finally {
      release();
    }
  }
}

/** Short label for the retry log — status when there is one, else the message. */
function describe(err: unknown): string {
  const status = statusOf(err);
  if (status !== undefined) return `HTTP ${status}`;
  return (err instanceof Error ? err.message : String(err)).slice(0, 60);
}
