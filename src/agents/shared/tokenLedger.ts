import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Per-job token accounting: what one lecture (or any wrapped job) actually
 * cost, broken down by pipeline step.
 *
 * The LLM boundaries call `recordUsage` after every model reply; it is a no-op
 * unless the call is running inside `withTokenLedger`, so a boundary never has
 * to know which job it belongs to. AsyncLocalStorage carries the ledger through
 * the pipeline's Promise.all fan-out without threading it through every
 * function signature.
 */

export interface TokenEntry {
  /** The forced tool's name (e.g. `emit_topic_blocks`), or a fixed label. */
  step: string;
  model: string;
  input: number;
  output: number;
}

export interface StepTotal {
  step: string;
  model: string;
  calls: number;
  input: number;
  output: number;
}

export interface LedgerSummary {
  steps: StepTotal[];
  calls: number;
  input: number;
  output: number;
}

/** The slice of a LangChain AIMessage this module reads. */
interface UsageCarrier {
  usage_metadata?: { input_tokens?: number; output_tokens?: number };
}

const store = new AsyncLocalStorage<TokenEntry[]>();

export function recordUsage(step: string, model: string, reply: UsageCarrier | undefined): void {
  const entries = store.getStore();
  if (!entries) return;
  const usage = reply?.usage_metadata;
  entries.push({
    step,
    model,
    input: usage?.input_tokens ?? 0,
    output: usage?.output_tokens ?? 0,
  });
}

/** Groups entries by step + model, in the order each step first appeared. */
export function summarize(entries: TokenEntry[]): LedgerSummary {
  const byKey = new Map<string, StepTotal>();
  for (const e of entries) {
    const key = `${e.step}\u0000${e.model}`;
    const row = byKey.get(key) ?? { step: e.step, model: e.model, calls: 0, input: 0, output: 0 };
    row.calls += 1;
    row.input += e.input;
    row.output += e.output;
    byKey.set(key, row);
  }
  const steps = [...byKey.values()];
  return {
    steps,
    calls: entries.length,
    input: steps.reduce((n, s) => n + s.input, 0),
    output: steps.reduce((n, s) => n + s.output, 0),
  };
}

export function formatSummary(label: string, summary: LedgerSummary): string {
  const lines = summary.steps.map(
    (s) => `  ${s.step.padEnd(28)} ${s.model.padEnd(36)} calls=${s.calls} in=${s.input} out=${s.output}`,
  );
  return [
    `[tokens] ${label}: calls=${summary.calls} in=${summary.input} out=${summary.output}`,
    ...lines,
  ].join("\n");
}

/**
 * Runs `fn` with a fresh ledger and logs the per-step totals when it settles —
 * on failure too, since a failed generation still spent the tokens.
 */
export async function withTokenLedger<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const entries: TokenEntry[] = [];
  try {
    return await store.run(entries, fn);
  } finally {
    if (entries.length) console.log(formatSummary(label, summarize(entries)));
  }
}
