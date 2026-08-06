import type OpenAI from "openai";
import { describe, expect, it, vi } from "vitest";
import { runForcedToolCall } from "../src/agents/shared/forcedToolCall.js";
import { env } from "../src/config/env.js";
import { fakeDeps, toolCallResponse } from "./helpers/fakeLlm.js";

const TOOL: OpenAI.Chat.ChatCompletionFunctionTool = {
  type: "function",
  function: {
    name: "emit_thing",
    description: "Emit a thing.",
    parameters: { type: "object", required: ["value"], properties: { value: { type: "string" } } },
  },
};

const base = {
  tool: TOOL,
  system: "You are a thing emitter.",
  user: "Emit a thing.",
  sizeHint: "Emit something much smaller.",
  maxTokens: 4096,
  label: "Test generation",
  parse: (raw: unknown) => {
    const v = (raw as { value?: unknown }).value;
    return typeof v === "string"
      ? { success: true as const, data: v }
      : { success: false as const, issues: "value must be a string" };
  },
};

/** A response cut off before the tool call ever materialised. */
const truncatedNoCall = { choices: [{ finish_reason: "length", message: { content: null } }] };
/** A response cut off mid-arguments, so a partial tool call survives. */
const truncatedPartialCall = toolCallResponse("emit_thing", { value: "x" }, "length");

const sentText = (create: ReturnType<typeof vi.fn>, callIndex: number) =>
  JSON.stringify(create.mock.calls[callIndex]?.[0]?.messages ?? []);

describe("runForcedToolCall truncation handling", () => {
  /*
   * Regression: the missing-tool-call branch used to run BEFORE the
   * finish_reason check. A badly truncated response has no tool call, so it was
   * misreported as "you replied with plain text" — a repair instruction that
   * says nothing about length. On a cheap model that ran away again and the
   * whole drawing was lost.
   */
  it("diagnoses a truncated response as too long, not as a missing tool call", async () => {
    const { deps, create } = fakeDeps(truncatedNoCall, toolCallResponse("emit_thing", { value: "ok" }));
    await expect(runForcedToolCall({ ...base, deps })).resolves.toBe("ok");

    const repair = sentText(create, 1);
    expect(repair).toContain("far too long");
    expect(repair).toContain("Emit something much smaller.");
    expect(repair).not.toContain("do not reply with plain text");
  });

  it("restarts clean on truncation instead of echoing the half-finished output", async () => {
    const { deps, create } = fakeDeps(truncatedPartialCall, toolCallResponse("emit_thing", { value: "ok" }));
    await expect(runForcedToolCall({ ...base, deps })).resolves.toBe("ok");

    const repair = JSON.parse(sentText(create, 1)) as { role: string }[];
    // system + user only — no assistant echo, no tool message.
    expect(repair.map((m) => m.role)).toEqual(["system", "user"]);
  });

  it("still echoes the tool call for an ordinary validation failure", async () => {
    const { deps, create } = fakeDeps(
      toolCallResponse("emit_thing", { value: 42 }),
      toolCallResponse("emit_thing", { value: "ok" }),
    );
    await expect(runForcedToolCall({ ...base, deps })).resolves.toBe("ok");

    const repair = JSON.parse(sentText(create, 1)) as { role: string }[];
    expect(repair.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool"]);
    expect(sentText(create, 1)).toContain("value must be a string");
  });

  it("throws a labelled 502 when both attempts fail", async () => {
    const { deps } = fakeDeps(truncatedNoCall, truncatedNoCall);
    await expect(runForcedToolCall({ ...base, deps })).rejects.toMatchObject({ statusCode: 502 });
  });

  it("uses the caller's timeout for the first attempt and less for the repair", async () => {
    const { deps, create } = fakeDeps(
      toolCallResponse("emit_thing", { value: 42 }),
      toolCallResponse("emit_thing", { value: "ok" }),
    );
    await runForcedToolCall({ ...base, deps, timeoutMs: 120_000 });
    expect(create.mock.calls[0]?.[1]).toMatchObject({ timeout: 120_000 });
    expect(create.mock.calls[1]?.[1]).toMatchObject({ timeout: 90_000 });
  });

  // Asserted against env rather than a literal: the default is deliberately
  // tuned per model (it was raised from 60s to 180s for glm-5.2, a reasoning
  // model), and a hardcoded number here just goes stale the next time it moves.
  it("falls back to the default timeout when the caller sets none", async () => {
    const { deps, create } = fakeDeps(toolCallResponse("emit_thing", { value: "ok" }));
    await runForcedToolCall({ ...base, deps });
    expect(create.mock.calls[0]?.[1]).toMatchObject({ timeout: env.LLM_TIMEOUT_MS });
  });
});
