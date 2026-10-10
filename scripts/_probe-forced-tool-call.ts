import type OpenAI from "openai";
import { runForcedToolCall } from "../src/agents/shared/forcedToolCall.js";
import { env } from "../src/config/env.js";

/**
 * Live check on the LangChain forced-tool-call runner, against a real provider.
 *
 * The interesting path is the REPAIR round, not the happy one: a repair echoes
 * the assistant turn and answers its tool call, and some providers reject a
 * tool message with no function `name`. qwen3.8-max is one of them — it 500s —
 * which is what the LangChain move fixed, so this parser deliberately rejects
 * the first emission to force that second round.
 *
 * Key comes from the environment, never a literal — see _probe-provider.ts.
 *
 *   PROBE_MODEL=qwen/qwen3.8-max-free npx tsx scripts/_probe-forced-tool-call.ts
 */

const model = process.env.PROBE_MODEL ?? env.LLM_MODEL ?? "qwen/qwen3.8-max-free";

const TOOL: OpenAI.Chat.ChatCompletionFunctionTool = {
  type: "function",
  function: {
    name: "emit_city",
    description: "Emit one city.",
    parameters: {
      type: "object",
      required: ["city", "country"],
      properties: { city: { type: "string" }, country: { type: "string" } },
    },
  },
};

let attempts = 0;

console.log(`[probe] provider=${env.LLM_PROVIDER} model=${model}`);

try {
  const result = await runForcedToolCall<string>({
    deps: { model },
    tool: TOOL,
    system: "You emit cities via the emit_city function.",
    user: "Emit the capital of Bangladesh.",
    sizeHint: "Keep it short.",
    maxTokens: 512,
    label: "Probe",
    parse: (raw) => {
      attempts++;
      const { city, country } = (raw ?? {}) as { city?: string; country?: string };
      console.log(`[probe] attempt ${attempts} emitted:`, JSON.stringify(raw));
      // Reject the first emission no matter what it says, to force a repair.
      if (attempts === 1) {
        return { success: false, issues: "country must be the ISO-3166 alpha-2 code, not the full name" };
      }
      return city && country
        ? { success: true, data: `${city}, ${country}` }
        : { success: false, issues: "city and country are both required" };
    },
  });

  console.log(`\n[probe] PASS — repair round completed, final payload: ${result}`);
  console.log(`[probe] total model calls: ${attempts}`);
  if (attempts < 2) {
    console.warn("[probe] WARNING: only one attempt ran — the repair path was not exercised.");
  }
} catch (err) {
  console.error("\n[probe] FAIL —", err instanceof Error ? err.message : err);
  process.exitCode = 1;
}
