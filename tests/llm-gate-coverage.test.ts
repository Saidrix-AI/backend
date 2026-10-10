import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/*
 * The gate is only as accurate as its coverage.
 *
 * agents/shared/llmGate.ts throttles against a limit the provider enforces
 * ACCOUNT-WIDE, so a caller that reaches the model without it does not merely go
 * unthrottled — it spends quota the gate still believes it has, and 429s the
 * gated callers alongside itself. That is not hypothetical: the chat agent
 * called the model directly until 2026-08-31, and one chat turn is a router call
 * plus up to MAX_TOOL_ITERATIONS streamed rounds, enough to exhaust a small cap
 * on a single message while lecture generation was being carefully paced.
 *
 * The regression is invisible in behaviour tests — an ungated call works fine
 * until the account is busy — so it is pinned structurally instead: any agent
 * file that drives a model must reach the gate, directly via gatedLlmCall or
 * through runForcedToolCall, which is itself gated.
 */

const AGENTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "agents");

/** Calls a LangChain model: `.invoke(` / `.stream(` on some runnable. */
const DRIVES_A_MODEL = /\.(invoke|stream)\(/;
const REACHES_THE_GATE = /gatedLlmCall|runForcedToolCall/;

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const found = await Promise.all(
    entries.map(async (entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(full);
      return entry.name.endsWith(".ts") ? [full] : [];
    }),
  );
  return found.flat();
}

describe("llmGate coverage", () => {
  it("routes every agent that drives a model through the gate", async () => {
    const files = await sourceFiles(AGENTS_DIR);
    // A guard that scans nothing passes vacuously; make the walk prove itself.
    expect(files.length).toBeGreaterThan(10);

    const ungated: string[] = [];
    for (const file of files) {
      const source = await readFile(file, "utf8");
      if (DRIVES_A_MODEL.test(source) && !REACHES_THE_GATE.test(source)) {
        ungated.push(path.relative(AGENTS_DIR, file).replace(/\\/g, "/"));
      }
    }

    expect(ungated).toEqual([]);
  });

  it("still sees the callers it is meant to be guarding", async () => {
    // Without this the first test would also pass if the regex stopped matching
    // anything at all — a silently disarmed guard is worse than none.
    const files = await sourceFiles(AGENTS_DIR);
    const drivers: string[] = [];
    for (const file of files) {
      if (DRIVES_A_MODEL.test(await readFile(file, "utf8"))) {
        drivers.push(path.relative(AGENTS_DIR, file).replace(/\\/g, "/"));
      }
    }
    expect(drivers).toContain("chat-agent/stream.ts");
    expect(drivers).toContain("shared/forcedToolCall.ts");
  });
});
