import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import type { ChatOpenAI } from "@langchain/openai";
import type OpenAI from "openai";
import type { z } from "zod";
import { env } from "../../config/env.js";
import { ApiError } from "../../utils/apiError.js";
import { getChatModelFor } from "../llm.js";
import { gatedLlmCall, isTransient } from "./llmGate.js";
import { recordUsage } from "./tokenLedger.js";

/**
 * Generic single-forced-tool-call runner with one repair round-trip — the LLM
 * boundary shared by the lecture-maker (planner / topic workers / svg workers)
 * and the project reviewer (requirements author / file workers / requirement
 * checker). Callers supply the tool, the prompts, a parser and a `label` used
 * in the failure message.
 *
 * Runs on LangChain (ChatOpenAI), not the raw OpenAI SDK. Beyond matching the
 * architecture the rest of the project is meant to use, that is what makes the
 * repair round portable: a repair echoes the assistant turn and answers its
 * tool call, and some providers reject a tool message that does not carry the
 * function `name`. The OpenAI SDK dropped `name` from its tool-message type
 * (deprecated upstream), so hand-built repairs silently omitted it; LangChain's
 * ToolMessage keeps it and @langchain/openai forwards it. Verified against
 * TokenRouter/qwen 2026-08-20: without `name` the repair round 500s.
 */

/**
 * The model id this call runs on. Production passes the id alone and the runner
 * builds the client; `chat` is the injection seam the agent tests use, the same
 * role `client` played before the LangChain move.
 */
export interface LlmDeps {
  model: string;
  chat?: ChatOpenAI;
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

/**
 * Where in the retry budget this parse is happening. `isFinal` is the useful
 * one: a parser that can salvage a nearly-good emission should still REJECT it
 * early — a repair round produces better output than any local fix — but on the
 * last attempt the choice is no longer "salvage or repair", it is "salvage or
 * throw away everything the pipeline has built".
 */
export interface ParseAttempt {
  /** 0-based. */
  attempt: number;
  isFinal: boolean;
}

export interface ForcedToolCallOptions<T> {
  deps: LlmDeps;
  tool: OpenAI.Chat.ChatCompletionFunctionTool;
  system: string;
  user: string;
  /**
   * May be async: the svg worker renders the drawing in a browser and shows it
   * to a vision model before deciding whether to accept it.
   *
   * `at` is optional to use — most parsers judge the payload alone. Parsers that
   * can salvage a near-miss read `at.isFinal` to decide between rejecting for a
   * repair round and accepting a reconciled payload.
   */
  parse: (raw: unknown, at: ParseAttempt) => ParseResult<T> | Promise<ParseResult<T>>;
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

/** `truncated` marks the one failure whose output must NOT be echoed back. */
type Extraction<T> = { payload: T } | { issue: string; truncated?: boolean };

export async function runForcedToolCall<T>(opts: ForcedToolCallOptions<T>): Promise<T> {
  const name = opts.tool.function.name;

  const chat = opts.deps.chat ?? getChatModelFor(opts.deps.model, opts.maxTokens);
  if (!chat) {
    throw new ApiError(503, `${opts.label} needs an OpenAI-compatible LLM provider.`);
  }
  // reasoning_effort is applied by getChatModelFor (gpt-5.x rejects function
  // tools unless reasoning is off — see llm.ts).
  const bind = (model: ChatOpenAI) =>
    model.bindTools([opts.tool], { tool_choice: { type: "function", function: { name } } });
  let bound = bind(chat);
  let usedFallback = false;
  let model = opts.deps.model;

  const opening = (): BaseMessage[] => [new SystemMessage(opts.system), new HumanMessage(opts.user)];
  const messages: BaseMessage[] = opening();

  const initialTimeout = opts.timeoutMs ?? INITIAL_TIMEOUT_MS;
  const repairTimeout = opts.timeoutMs ? Math.round(opts.timeoutMs * REPAIR_TIMEOUT_RATIO) : REPAIR_TIMEOUT_MS;

  const maxAttempts = Math.max(1, opts.maxAttempts ?? 2);

  /**
   * One model call, with a last-resort switch to LLM_FALLBACK_MODEL.
   *
   * The gate below already retried this a few times with backoff; reaching here
   * means the configured model is not answering at all right now — measured
   * against this project's free tier, that happens in bursts lasting minutes
   * while a paid model on the same key stays healthy. Only transient failures
   * qualify: a 4xx would fail identically on any model and the retry would just
   * spend more of the rate window.
   *
   * Skipped when a test injected `deps.chat` — that model IS the assertion.
   */
  const invoke = async (timeout: number): Promise<AIMessage> => {
    const call = () =>
      gatedLlmCall(() =>
        bound.invoke(messages, { options: { timeout, maxRetries: 1 } }),
      ) as Promise<AIMessage>;
    try {
      return await call();
    } catch (err) {
      const target = env.LLM_FALLBACK_MODEL;
      if (
        usedFallback ||
        opts.deps.chat ||
        !target ||
        target === opts.deps.model ||
        !isTransient(err)
      ) {
        throw err;
      }
      const spare = getChatModelFor(target, opts.maxTokens);
      if (!spare) throw err;
      usedFallback = true;
      model = target;
      bound = bind(spare);
      console.warn(
        `[forced-tool-call] ${opts.label}: "${opts.deps.model}" is not responding — falling back to "${target}".`,
      );
      return await call();
    }
  };

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // Every agent's LLM traffic funnels through here, which makes it the one
    // place worth putting the provider throttle — see shared/llmGate.ts.
    const reply = await invoke(attempt === 0 ? initialTimeout : repairTimeout);
    recordUsage(name, model, reply);

    const at: ParseAttempt = { attempt, isFinal: attempt === maxAttempts - 1 };
    const result = await extract(reply, name, opts.parse, opts.sizeHint, at);
    if ("payload" in result) return result.payload;
    if (attempt >= maxAttempts - 1) break;

    if (result.truncated) {
      // Echoing a truncated tool call feeds the model thousands of tokens of
      // its own half-finished sprawl, which only invites more of the same.
      // Restart from the original prompt with a firmer size instruction.
      messages.length = 0;
      messages.push(
        new SystemMessage(opts.system),
        new HumanMessage(
          `${opts.user}\n\nIMPORTANT: your previous attempt was far too long and had to be discarded. ${opts.sizeHint}`,
        ),
      );
    } else {
      messages.push(...repairMessages(reply, result.issue, name));
    }
  }

  throw new ApiError(502, `${opts.label} failed: the model returned an invalid ${name} structure.`);
}

async function extract<T>(
  reply: AIMessage,
  name: string,
  parse: (raw: unknown, at: ParseAttempt) => ParseResult<T> | Promise<ParseResult<T>>,
  sizeHint: string,
  at: ParseAttempt,
): Promise<Extraction<T>> {
  // Truncation is checked FIRST: when a response is cut off badly enough, the
  // tool call never materialises at all, and the missing-call branch below
  // would misreport it as "you replied with plain text" — sending the model a
  // repair instruction that says nothing about length, so it runs away again.
  if (reply.response_metadata?.finish_reason === "length") {
    return { issue: `Your output was truncated. ${sizeHint}`, truncated: true };
  }
  const call = reply.tool_calls?.find((c) => c.name === name);
  if (!call) {
    // LangChain parks a tool call whose arguments would not parse as JSON in
    // invalid_tool_calls rather than dropping it, which keeps the two failures
    // distinguishable: bad JSON gets a "send valid JSON" repair, no call at all
    // gets a "you must call the function" repair.
    if (reply.invalid_tool_calls?.some((c) => c.name === name)) {
      return { issue: `The ${name} arguments were not valid JSON. Call ${name} again with valid JSON. ${sizeHint}` };
    }
    return { issue: `You must respond by calling the ${name} function — do not reply with plain text.` };
  }
  // LangChain has already JSON-parsed the arguments into an object.
  const parsed = await parse(call.args, at);
  if (!parsed.success) {
    return { issue: `The structure had problems: ${parsed.issues}. Call ${name} again with these fixed.` };
  }
  return { payload: parsed.data };
}

/**
 * Repair turn that keeps the tool-call protocol legal: echo the assistant
 * message and answer every tool call; without a tool call, a user message.
 *
 * `name` on each ToolMessage is load-bearing — see the note at the top of this
 * file. The assistant turn is echoed as the AIMessage we received rather than
 * rebuilt, so its tool_call ids line up with the answers by construction.
 */
function repairMessages(reply: AIMessage, issue: string, name: string): BaseMessage[] {
  const calls = reply.tool_calls ?? [];
  if (!calls.length) {
    return [new HumanMessage(issue)];
  }
  return [
    reply,
    ...calls.map(
      (c, i) =>
        new ToolMessage({
          content: i === 0 ? issue : `Ignored — call ${name} exactly once.`,
          tool_call_id: c.id ?? "",
          name: c.name,
        }),
    ),
  ];
}
