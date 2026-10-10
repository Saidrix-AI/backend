import { afterEach, describe, expect, it, vi } from "vitest";
import { recordUsage, summarize, withTokenLedger } from "../src/agents/shared/tokenLedger.js";

const reply = (input: number, output: number) => ({ usage_metadata: { input_tokens: input, output_tokens: output } });

describe("token ledger", () => {
  afterEach(() => vi.restoreAllMocks());

  it("ignores usage recorded outside a ledger", () => {
    expect(() => recordUsage("plan", "m", reply(1, 1))).not.toThrow();
  });

  it("totals usage per step across parallel calls and logs it", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await withTokenLedger("lecture L1", async () => {
      recordUsage("plan", "m1", reply(100, 20));
      await Promise.all([
        (async () => recordUsage("write", "m1", reply(50, 10)))(),
        (async () => recordUsage("write", "m1", reply(70, 30)))(),
      ]);
      recordUsage("vision_critic", "m2", undefined);
    });
    expect(log).toHaveBeenCalledOnce();
    const text = String(log.mock.calls[0][0]);
    expect(text).toContain("[tokens] lecture L1: calls=4 in=220 out=60");
    expect(text).toMatch(/write\s+m1\s+calls=2 in=120 out=40/);
  });

  it("still logs when the job fails", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await expect(
      withTokenLedger("lecture L2", async () => {
        recordUsage("plan", "m1", reply(5, 5));
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(String(log.mock.calls[0][0])).toContain("calls=1 in=5 out=5");
  });

  it("keeps separate rows when a step falls back to another model", () => {
    const s = summarize([
      { step: "write", model: "a", input: 1, output: 1 },
      { step: "write", model: "b", input: 2, output: 2 },
    ]);
    expect(s.steps).toHaveLength(2);
    expect(s.input).toBe(3);
  });
});
