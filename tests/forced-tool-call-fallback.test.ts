import { AIMessage } from "@langchain/core/messages";
import type OpenAI from "openai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "../src/config/env.js";

/*
 * LLM_FALLBACK_MODEL: the last resort when the configured model is not
 * answering at all.
 *
 * Measured 2026-08-20: qwen's free tier sheds load in bursts — every call 503s
 * for minutes ("cache-only admission rejected a cold or overloaded request") —
 * while the paid model on the same key answers normally in the same seconds.
 * Course generation is ~7-10 calls per course and all of them must land, so one
 * bad window meant no course at all. These tests pin down when the switch does
 * and does not happen; llm-gate.test.ts covers the retries that come first.
 */

const mocks = vi.hoisted(() => ({ getChatModelFor: vi.fn() }));

vi.mock("../src/agents/llm.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agents/llm.js")>();
  return { ...actual, getChatModelFor: mocks.getChatModelFor };
});

const { runForcedToolCall } = await import("../src/agents/shared/forcedToolCall.js");

const TOOL: OpenAI.Chat.ChatCompletionFunctionTool = {
  type: "function",
  function: {
    name: "emit_thing",
    description: "Emit a thing.",
    parameters: { type: "object", required: ["value"], properties: { value: { type: "string" } } },
  },
};

const base = {
  deps: { model: "flaky/free-model" },
  tool: TOOL,
  system: "s",
  user: "u",
  sizeHint: "smaller",
  maxTokens: 256,
  label: "Test generation",
  parse: (raw: unknown) => ({ success: true as const, data: (raw as { value: string }).value }),
};

const good = () =>
  new AIMessage({
    content: "",
    tool_calls: [{ id: "call_1", name: "emit_thing", args: { value: "ok" }, type: "tool_call" }],
    response_metadata: { finish_reason: "tool_calls" },
  });

const boom = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });

/** A model whose invoke() plays out the given script. */
function modelThat(invoke: ReturnType<typeof vi.fn>) {
  return { bindTools: () => ({ invoke }) };
}

/** Backoffs are seconds long; fake timers keep this instant. */
async function run<T>(fn: () => Promise<T>): Promise<T> {
  const settled = fn().then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  await vi.runAllTimersAsync();
  const r = await settled;
  if (r.ok) return r.value;
  throw r.error;
}

const originalFallback = env.LLM_FALLBACK_MODEL;

beforeEach(() => {
  vi.useFakeTimers();
  mocks.getChatModelFor.mockReset();
  env.LLM_FALLBACK_MODEL = "paid/reliable-model";
});

afterEach(() => {
  vi.useRealTimers();
  env.LLM_FALLBACK_MODEL = originalFallback;
});

describe("fallback model", () => {
  it("switches after the primary exhausts its transient retries", async () => {
    const primary = vi.fn().mockRejectedValue(boom(503));
    const spare = vi.fn().mockResolvedValue(good());
    mocks.getChatModelFor.mockImplementation((model: string) =>
      modelThat(model === "paid/reliable-model" ? spare : primary),
    );

    await expect(run(() => runForcedToolCall({ ...base }))).resolves.toBe("ok");
    // The first call plus llmGate's backoffs, then one on the spare.
    expect(primary).toHaveBeenCalledTimes(3);
    expect(spare).toHaveBeenCalledTimes(1);
  });

  it("does not switch while the primary is merely slow to get it right", async () => {
    const primary = vi.fn().mockResolvedValue(good());
    mocks.getChatModelFor.mockImplementation(() => modelThat(primary));

    await expect(run(() => runForcedToolCall({ ...base }))).resolves.toBe("ok");
    expect(mocks.getChatModelFor).toHaveBeenCalledTimes(1);
    expect(mocks.getChatModelFor).toHaveBeenCalledWith("flaky/free-model", 256);
  });

  /*
   * A 4xx is our request being wrong. It would fail the same way on any model,
   * so switching would only spend more of the rate window to be told so again.
   */
  it("does not switch on a request the provider rejected on its merits", async () => {
    const primary = vi.fn().mockRejectedValue(boom(400));
    mocks.getChatModelFor.mockImplementation(() => modelThat(primary));

    await expect(run(() => runForcedToolCall({ ...base }))).rejects.toMatchObject({ status: 400 });
    expect(primary).toHaveBeenCalledTimes(1);
    expect(mocks.getChatModelFor).toHaveBeenCalledTimes(1);
  });

  it("stays on the primary when no fallback is configured", async () => {
    env.LLM_FALLBACK_MODEL = undefined;
    const primary = vi.fn().mockRejectedValue(boom(503));
    mocks.getChatModelFor.mockImplementation(() => modelThat(primary));

    await expect(run(() => runForcedToolCall({ ...base }))).rejects.toMatchObject({ status: 503 });
    expect(mocks.getChatModelFor).toHaveBeenCalledTimes(1);
  });

  it("does not switch when the fallback is the model already failing", async () => {
    env.LLM_FALLBACK_MODEL = "flaky/free-model";
    const primary = vi.fn().mockRejectedValue(boom(503));
    mocks.getChatModelFor.mockImplementation(() => modelThat(primary));

    await expect(run(() => runForcedToolCall({ ...base }))).rejects.toMatchObject({ status: 503 });
    expect(mocks.getChatModelFor).toHaveBeenCalledTimes(1);
  });

  /* Falling back once per call is the budget; a dead fallback must not loop. */
  it("gives up when the fallback is down too", async () => {
    const primary = vi.fn().mockRejectedValue(boom(503));
    const spare = vi.fn().mockRejectedValue(boom(503));
    mocks.getChatModelFor.mockImplementation((model: string) =>
      modelThat(model === "paid/reliable-model" ? spare : primary),
    );

    await expect(run(() => runForcedToolCall({ ...base }))).rejects.toMatchObject({ status: 503 });
    expect(spare).toHaveBeenCalledTimes(3);
  });
});
