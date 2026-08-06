import type OpenAI from "openai";
import type { z } from "zod";
import { env } from "../../config/env.js";
import { ApiError } from "../../utils/apiError.js";

/**
 * Generic single-forced-tool-call runner with one repair round-trip — the LLM
 * boundary shared by the lecture-maker (planner / topic workers / svg workers)
 * and the project reviewer (requirements author / file workers / requirement
 * checker). Callers supply the tool, the prompts, a parser and a `label` used
 * in the failure message.
 */

export interface LlmDeps {
  client: OpenAI;
  model: string;
}

const MAX_ISSUES = 12;
/** The repair round gets a little less time than the first attempt. */
const REPAIR_TIMEOUT_RATIO = 0.75;
/** Env-driven so slow reasoning models (e.g. glm-5.2) don't time out. */
const INITIAL_TIMEOUT_MS = env.LLM_TIMEOUT_MS;
const REPAIR_TIMEOUT_MS = Math.round(env.LLM_TIMEOUT_MS * REPAIR_TIMEOUT_RATIO);

/** Zod issues formatted for a repair message (sliced to keep the turn small). */
export function formatZodIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, MAX_ISSUES)
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
}

export type ParseResult<T> = { success: true; data: T } | { success: false; issues: string };

export interface ForcedToolCallOptions<T> {
  deps: LlmDeps;
  tool: OpenAI.Chat.ChatCompletionFunctionTool;
  system: string;
  user: string;
  /**
   * May be async: the svg worker renders the drawing in a browser and shows it
   * to a vision model before deciding whether to accept it.
   */
  parse: (raw: unknown) => ParseResult<T> | Promise<ParseResult<T>>;
  /** Appended to the truncation repair message, e.g. "Emit fewer, shorter blocks." */
  sizeHint: string;
  /** Per-call output cap. */
  maxTokens: number;
  /**
   * Per-call wall clock, for roles whose budget differs from the shared
   * default. Defaults to LLM_TIMEOUT_MS; the svg worker sets its own, because a
   * cheap model can spend four minutes on one drawing.
   */
  timeoutMs?: number;
  /** Names the work in the 502 thrown when both attempts fail, e.g. "Lecture generation". */
  label: string;
  /**
   * Total attempts: the first try plus repair rounds. Two by default — one
   * repair — which is right when the feedback is "your JSON was malformed".
   * The svg worker raises it, because its feedback is measured coordinates the
   * model can actually act on, so a further round is worth paying for.
   */
  maxAttempts?: number;
}

type Choice = OpenAI.Chat.ChatCompletion.Choice | undefined;
/** `truncated` marks the one failure whose output must NOT be echoed back. */
type Extraction<T> = { payload: T } | { issue: string; truncated?: boolean };

export async function runForcedToolCall<T>(opts: ForcedToolCallOptions<T>): Promise<T> {
  const name = opts.tool.function.name;
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: opts.system },
    { role: "user", content: opts.user },
  ];

  const initialTimeout = opts.timeoutMs ?? INITIAL_TIMEOUT_MS;
  const repairTimeout = opts.timeoutMs ? Math.round(opts.timeoutMs * REPAIR_TIMEOUT_RATIO) : REPAIR_TIMEOUT_MS;

  const maxAttempts = Math.max(1, opts.maxAttempts ?? 2);

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const completion = await opts.deps.client.chat.completions.create(
      {
        model: opts.deps.model,
        messages,
        max_tokens: opts.maxTokens,
        tools: [opts.tool],
        tool_choice: { type: "function", function: { name } },
      },
      { timeout: attempt === 0 ? initialTimeout : repairTimeout, maxRetries: 1 },
    );

    const choice: Choice = completion.choices?.[0];
    const result = await extract(choice, name, opts.parse, opts.sizeHint);
    if ("payload" in result) return result.payload;
    if (attempt >= maxAttempts - 1) break;

    if (result.truncated) {
      // Echoing a truncated tool call feeds the model thousands of tokens of
      // its own half-finished sprawl, which only invites more of the same.
      // Restart from the original prompt with a firmer size instruction.
      messages.length = 0;
      messages.push(
        { role: "system", content: opts.system },
        { role: "user", content: `${opts.user}\n\nIMPORTANT: your previous attempt was far too long and had to be discarded. ${opts.sizeHint}` },
      );
    } else {
      messages.push(...repairMessages(choice, result.issue, name));
    }
  }

  throw new ApiError(502, `${opts.label} failed: the model returned an invalid ${name} structure.`);
}

async function extract<T>(
  choice: Choice,
  name: string,
  parse: (raw: unknown) => ParseResult<T> | Promise<ParseResult<T>>,
  sizeHint: string,
): Promise<Extraction<T>> {
  // Truncation is checked FIRST: when a response is cut off badly enough, the
  // tool call never materialises at all, and the missing-call branch below
  // would misreport it as "you replied with plain text" — sending the model a
  // repair instruction that says nothing about length, so it runs away again.
  if (choice?.finish_reason === "length") {
    return { issue: `Your output was truncated. ${sizeHint}`, truncated: true };
  }
  const call = choice?.message?.tool_calls?.[0];
  if (!call || call.type !== "function" || call.function.name !== name) {
    return { issue: `You must respond by calling the ${name} function — do not reply with plain text.` };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(call.function.arguments || "{}");
  } catch {
    return { issue: `The ${name} arguments were not valid JSON. Call ${name} again with valid JSON. ${sizeHint}` };
  }
  const parsed = await parse(raw);
  if (!parsed.success) {
    return { issue: `The structure had problems: ${parsed.issues}. Call ${name} again with these fixed.` };
  }
  return { payload: parsed.data };
}

/**
 * Repair turn that keeps the tool-call protocol legal: echo the assistant
 * message and answer every tool call; without a tool call, a user message.
 */
function repairMessages(choice: Choice, issue: string, name: string): OpenAI.Chat.ChatCompletionMessageParam[] {
  const msg = choice?.message;
  const calls = msg?.tool_calls;
  if (!calls?.length) {
    return [{ role: "user", content: issue }];
  }
  return [
    { role: "assistant", content: msg?.content ?? null, tool_calls: calls },
    ...calls.map(
      (c, i): OpenAI.Chat.ChatCompletionMessageParam => ({
        role: "tool",
        tool_call_id: c.id,
        content: i === 0 ? issue : `Ignored — call ${name} exactly once.`,
      }),
    ),
  ];
}
