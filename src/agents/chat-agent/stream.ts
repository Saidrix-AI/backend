import {
  SystemMessage,
  HumanMessage,
  AIMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { getChatModel, getChatModelFor, getModelName } from "../llm.js";
import { gatedLlmCall } from "../shared/llmGate.js";
import { WEB_SEARCH_TOOL_NAME, type SearchSource } from "../tools/web-search.js";
import { SEARCH_COURSE_CONTENT_TOOL_NAME } from "../tools/course-content-search.js";
import { buildToolset } from "../tools/registry.js";
import { INTAKE_DONE_PREFIX } from "../tools/prompts/intake.js";
import type { ProposedCourse, AskQuestion, AssessmentStart, IntakeStart } from "../tools/types.js";
import { env } from "../../config/env.js";
import { buildChatAgentPrompt, CHAT_AGENT_PROMPT } from "./prompt.js";
import {
  ASSESSMENT_DONE_MULTI_PREFIX,
  ASSESSMENT_DONE_PREFIX,
  classifyCourseIntent,
  forcedToolFor,
  historyHasProposal,
  isRoutineSetupAnswer,
  ROUTER_MAX_TOKENS,
  SELECTION_PREFIX,
  type ForcedTool,
} from "./router.js";

export interface HistoryMessage {
  role: "user" | "assistant";
  content: string;
}

export interface InputAttachment {
  name: string;
  mimeType: string;
  kind: "image" | "text";
  /** data URL for images, raw text content for text files */
  data: string;
}

export type AgentStreamEvent =
  | { type: "thinking"; delta: string }
  | { type: "content"; delta: string }
  | { type: "tool_call"; id: string; name: string; label: string; query: string }
  | {
      type: "tool_result";
      id: string;
      name: string;
      ok: boolean;
      label: string;
      changed?: "course" | "project" | "routine";
    }
  | { type: "sources"; sources: SearchSource[] }
  | { type: "course_proposal"; id: string; courses: ProposedCourse[] }
  | { type: "ask_questions"; id: string; questions: AskQuestion[] }
  | { type: "assessment"; id: string; assessment: AssessmentStart }
  | { type: "intake"; id: string; intake: IntakeStart };

interface StreamOptions {
  /** Force a web search on the first turn (globe toggle on). */
  forceSearch?: boolean;
  /** Files attached to this turn's user message (images + text files). */
  attachments?: InputAttachment[];
  /** Aborts the upstream LLM call when the client cancels. */
  signal?: AbortSignal;
  /** Enables the per-user database tools (profile/progress/courses/projects/routine) when set. */
  userId?: string;
  /**
   * The student's background block (services/learnerProfile.service.ts), resolved
   * once per turn by chat.service so the WebSocket and SSE paths share one read.
   * Optional and empty-safe: without it the agent behaves exactly as before.
   */
  learnerContext?: string;
}

/** Builds the current turn's user message, folding in attachments. */
function buildUserMessage(userMessage: string, attachments: InputAttachment[] = []): HumanMessage {
  const textFiles = attachments.filter((a) => a.kind === "text");
  const images = attachments.filter((a) => a.kind === "image");

  let text = userMessage;
  for (const file of textFiles) {
    text += `\n\n--- Attached file: ${file.name} ---\n${file.data}`;
  }

  if (images.length === 0) {
    return new HumanMessage(text);
  }

  return new HumanMessage({
    content: [
      { type: "text", text },
      ...images.map((img) => ({
        type: "image_url" as const,
        image_url: { url: img.data },
      })),
    ],
  });
}

const MAX_TOOL_ITERATIONS = 5;

/**
 * Tool-call markup that must never reach the transcript.
 *
 * qwen writes its tool calls as `<tool_call>{…}</tool_call>` and the provider's
 * parser normally lifts them into structured calls. When it emits a malformed
 * one the parser leaves it alone and it arrives as ordinary content — a student
 * saw a bare `<tool_call>` in their chat after three generation failures in a
 * row. Other open models use `<|tool_call|>` and `<function_call>` for the same
 * thing, so all three are covered.
 */
const TOOL_MARKUP = /<\/?\|?(?:tool_call|function_call|tool_response)\|?>/gi;

/**
 * Longest prefix of `text` that could still grow into TOOL_MARKUP.
 *
 * Deltas are token-sized, so `<tool_` and `call>` routinely arrive in separate
 * chunks; replacing per chunk would miss every split tag. The caller holds this
 * tail back until the next delta completes it or proves it harmless.
 */
function danglingTagLength(text: string): number {
  const start = text.lastIndexOf("<");
  if (start < 0) return 0;
  const tail = text.slice(start);
  if (tail.includes(">")) return 0;
  return /^<\/?\|?[a-z_|]*$/i.test(tail) ? tail.length : 0;
}

/**
 * Streams content with tool markup removed, buffering a partial tag across
 * chunks. `flush()` releases whatever the buffer was still holding — a tag that
 * never completed is real text and the student should see it.
 */
function toolMarkupFilter() {
  let held = "";
  return {
    push(delta: string): string {
      const merged = held + delta;
      const keep = merged.length - danglingTagLength(merged);
      held = merged.slice(keep);
      return merged.slice(0, keep).replace(TOOL_MARKUP, "");
    },
    flush(): string {
      const rest = held.replace(TOOL_MARKUP, "");
      held = "";
      return rest;
    },
  };
}

/**
 * delete_course / delete_project / delete_routine_item are only supposed to
 * fire once per confirmed item — the chat prompt says so ("only after the
 * student's most recent message explicitly confirms deleting that exact
 * item"), but that's just prompt text, not an enforced limit. A model that
 * mishandles an id (guesses one instead of calling list_routine, or retries a
 * malformed call) can emit dozens of these in the SAME completion — OpenAI-style
 * tool calls arrive as an array, and the loop below executes every entry in it
 * with no cap. That's exactly what happened here: ~60 failed delete_routine_item
 * calls with a bad id, then — once list_routine handed back real ids — a batch
 * that deleted most of the student's routine in one turn. Capping the count
 * turns a runaway batch into a handful of no-ops instead of a wiped routine.
 */
const DESTRUCTIVE_TOOLS = new Set([
  "delete_course",
  "delete_project",
  "delete_routine_item",
  // The bulk tools count as ONE call however many ids they carry. That is the
  // point of them: "delete all my projects" is a single deliberate act, and
  // forcing it through the per-item tools is what used to collide with this
  // cap — the request could not be honoured at all.
  "delete_courses",
  "delete_projects",
  "delete_routine_items",
]);
const MAX_DESTRUCTIVE_CALLS_PER_TURN = 3;

/**
 * What the model is told once the cap trips. It names the bulk tool, because
 * the usual reason for hitting this is a legitimate "clear my routine" being
 * attempted one item at a time — and a refusal that does not say how to do it
 * properly just invites the same batch again next turn.
 */
const DELETION_CAP_MESSAGE =
  `You've hit the limit of ${MAX_DESTRUCTIVE_CALLS_PER_TURN} delete calls for this turn, so nothing further ` +
  "was deleted. Do NOT retry. If the student asked you to remove many things at once, use the bulk tool for " +
  "that kind — delete_courses, delete_projects or delete_routine_items — in ONE call carrying every id. Tell " +
  "them plainly what you did and did not delete, and ask them to confirm before you try again.";

/**
 * Streams the tutor reply token-by-token with tool use.
 *
 * openai / openrouter providers run a real tool-calling loop: the model may
 * call `web_search` (Tavily) or — when `options.userId` is set — the per-user
 * database tools (profile/progress reads, course/project/routine CRUD). Tool
 * results are fed back until the model produces a final answer. Reasoning
 * deltas stream as `thinking`, the answer as `content`, plus
 * `tool_call` / `tool_result` / `sources` events for tool activity.
 *
 * Other providers fall back to LangChain streaming (answer only, no tools).
 */
export async function* streamChatAgent(
  history: HistoryMessage[],
  userMessage: string,
  options: StreamOptions = {},
): AsyncGenerator<AgentStreamEvent> {
  const model = getModelName();
  // Asking OpenRouter for reasoning tokens: a non-standard field, so it rides in
  // modelKwargs. Providers that don't know it ignore it, and the deltas simply
  // never arrive — the answer still streams.
  const chat = getChatModelFor(model, undefined, { modelKwargs: { include_reasoning: true } });

  if (!chat) {
    yield* streamFallback(history, userMessage, options.attachments, options.signal);
    return;
  }

  const searchEnabled = Boolean(env.TAVILY_API_KEY);
  const toolset = buildToolset({ userId: options.userId, searchEnabled });
  const toolSchemas = [...toolset.values()].map((t) => t.schema);

  // Intent routing: force the right tool on the first round — models reliably
  // fill a forced tool call but often narrate the course plan or the routine
  // questions as text when left to pick the tool themselves. Messages the cards
  // themselves compile are matched deterministically; everything else goes
  // through one cheap classification (on the course-maker model, the reliable
  // slot).
  let forcedTool: ForcedTool | null = null;
  if (options.userId && !(options.forceSearch && searchEnabled)) {
    const trimmed = userMessage.trimStart();
    if (trimmed.startsWith(SELECTION_PREFIX)) {
      forcedTool = "create_path_courses";
    } else if (trimmed.startsWith(ASSESSMENT_DONE_MULTI_PREFIX)) {
      forcedTool = "propose_courses";
    } else if (trimmed.startsWith(ASSESSMENT_DONE_PREFIX)) {
      forcedTool = "generate_course";
    } else if (trimmed.startsWith(INTAKE_DONE_PREFIX)) {
      forcedTool = "propose_courses";
    } else if (isRoutineSetupAnswer(trimmed)) {
      // The setup answers: ground the schedule in real lesson counts first.
      forcedTool = "list_courses";
    } else {
      // Its own model: temperature 0 and a small cap, on the course-maker slot
      // (the reliable one). Null only if the provider has no compatible model,
      // which the guard above has already ruled out.
      const router = getChatModelFor(env.COURSE_MAKER_MODEL ?? model, ROUTER_MAX_TOKENS, {
        temperature: 0,
      });
      const route = router
        ? await classifyCourseIntent(router, history, userMessage, options.signal)
        : null;
      if (route) forcedTool = forcedToolFor(route, historyHasProposal(history));
    }
    if (forcedTool && !toolset.has(forcedTool)) forcedTool = null;
  }
  const messages: BaseMessage[] = [
    new SystemMessage(
      buildChatAgentPrompt({
        dbTools: Boolean(options.userId),
        curriculum: toolset.has(SEARCH_COURSE_CONTENT_TOOL_NAME),
        today: new Date().toISOString().slice(0, 10),
        ...(options.learnerContext ? { learner: options.learnerContext } : {}),
      }),
    ),
    ...history.map((m) => (m.role === "user" ? new HumanMessage(m.content) : new AIMessage(m.content))),
    buildUserMessage(userMessage, options.attachments),
  ];

  // Counts every delete_* call attempted across the whole turn (all
  // iterations, successes and failures alike) — declared outside the
  // iteration loop because the runaway batch that motivated this reached
  // across iterations: list_routine ran in between the failed attempts and
  // the mass delete.
  let destructiveCalls = 0;
  // Set the moment the cap trips. It forces the next round to be text-only, so
  // the model explains itself instead of spending its remaining iterations
  // re-issuing the batch that was just refused.
  let deletionsHalted = false;

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
    const forceThisTurn = iteration === 0 && options.forceSearch && searchEnabled;
    // On the final allowed turn, disable tools so the model must produce a
    // text answer instead of requesting yet another search (which we'd have
    // no round left to satisfy, leaving an empty reply). A tripped delete cap
    // ends the tool phase the same way, and for the same reason.
    const lastTurn = iteration === MAX_TOOL_ITERATIONS - 1 || deletionsHalted;

    // reasoningParams is already on the model (see getChatModelFor).
    const runnable =
      toolSchemas.length > 0
        ? chat.bindTools(toolSchemas, {
            tool_choice: forceThisTurn
              ? { type: "function", function: { name: WEB_SEARCH_TOOL_NAME } }
              : iteration === 0 && forcedTool
                ? { type: "function", function: { name: forcedTool } }
                : lastTurn
                  ? "none"
                  : "auto",
          })
        : chat;

    // Gated like every generation call: the provider's rate limit is
    // account-wide, so a chat turn that skipped the gate spent quota the gate
    // still believed it had — and this loop alone is up to MAX_TOOL_ITERATIONS
    // requests, enough to blow a small cap on one message. See shared/llmGate.ts.
    //
    // The slot is held until the request is ACCEPTED, not until the stream is
    // drained. That is the right unit for the rolling window (the provider
    // counts requests when they start, which is what 429s us) and it is where an
    // HTTP 429 surfaces; the concurrency cap is correspondingly approximate for
    // streams. Retrying is safe here because nothing has been consumed yet.
    const stream = await gatedLlmCall(() => runnable.stream(messages, { signal: options.signal }));

    let content = "";
    const slots: { id: string; name: string; args: string }[] = [];
    const clean = toolMarkupFilter();

    for await (const chunk of stream) {
      // Non-standard reasoning deltas land in additional_kwargs, since LangChain
      // has no typed home for a field OpenAI never defined.
      const reasoning = chunk.additional_kwargs?.reasoning;
      if (typeof reasoning === "string" && reasoning) {
        yield { type: "thinking", delta: reasoning };
      }
      const raw = typeof chunk.content === "string" ? chunk.content : "";
      if (raw) {
        const text = clean.push(raw);
        if (text) {
          content += text;
          yield { type: "content", delta: text };
        }
      }
      // tool_call_chunks is LangChain's normalised form of the OpenAI deltas:
      // same index/id/name/args, already split out of the raw payload.
      for (const tc of chunk.tool_call_chunks ?? []) {
        const slot = (slots[tc.index ?? 0] ??= { id: "", name: "", args: "" });
        if (tc.id) slot.id = tc.id;
        if (tc.name) slot.name += tc.name;
        if (tc.args) slot.args += tc.args;
      }
    }

    // Anything the tag buffer was still holding when the stream ended never
    // completed into markup, so it is real text the student should see.
    const tail = clean.flush();
    if (tail) {
      content += tail;
      yield { type: "content", delta: tail };
    }

    // Trust the tool calls themselves, NOT finish_reason: gpt-4o-mini closes a
    // FORCED tool call with finish_reason "stop" (glm-5.2 says "tool_calls"),
    // and gating on the label silently threw the call away — every forced tool
    // turn came back as an empty reply. Sparse indices and half-streamed slots
    // are filtered out here rather than reaching the toolset lookup.
    const toolCalls = slots.filter((t) => t?.name);

    // No tool requested → this was the final answer.
    if (toolCalls.length === 0) return;

    // Record the assistant's tool-call turn, then run each tool. Arguments are
    // parsed once here rather than re-parsed per message: AIMessage.tool_calls
    // holds objects, and the raw string stays in the loop below for the
    // malformed-JSON path the tools' zod schemas report back on.
    messages.push(
      new AIMessage({
        content,
        tool_calls: toolCalls.map((t) => ({
          id: t.id,
          name: t.name,
          args: safeParseArgs(t.args),
          type: "tool_call" as const,
        })),
      }),
    );

    for (const [index, call] of toolCalls.entries()) {
      const tool = toolset.get(call.name);
      if (!tool) {
        messages.push(toolReply(call, "Unknown tool."));
        continue;
      }

      // Malformed JSON falls through to {} — the tool's zod schema reports
      // the missing fields back to the model so it can retry.
      const args = safeParseArgs(call.args);

      const eventId = `${iteration}-${index}`;

      // Over the cap: don't touch the database at all. Every blocked call still
      // needs a tool message or the next request is malformed, but the STUDENT
      // sees one notice however many arrive — a batch of fifty refusals used to
      // render fifty identical "Stopped" chips, which read as a crash rather
      // than as a guard doing its job.
      if (DESTRUCTIVE_TOOLS.has(call.name) && ++destructiveCalls > MAX_DESTRUCTIVE_CALLS_PER_TURN) {
        messages.push(toolReply(call, DELETION_CAP_MESSAGE));
        if (!deletionsHalted) {
          deletionsHalted = true;
          yield {
            type: "tool_result",
            id: eventId,
            name: call.name,
            ok: false,
            label: "Stopped — too many deletions in one turn",
          };
        }
        continue;
      }

      yield {
        type: "tool_call",
        id: eventId,
        name: call.name,
        label: tool.runningLabel(args),
        query: typeof args.query === "string" ? args.query : "",
      };

      const outcome = await tool.run({ userId: options.userId ?? "" }, args);
      if (outcome.sources) yield { type: "sources", sources: outcome.sources };
      if (outcome.proposal) yield { type: "course_proposal", id: eventId, courses: outcome.proposal };
      if (outcome.questions) yield { type: "ask_questions", id: eventId, questions: outcome.questions };
      if (outcome.assessment) yield { type: "assessment", id: eventId, assessment: outcome.assessment };
      if (outcome.intake) yield { type: "intake", id: eventId, intake: outcome.intake };
      yield {
        type: "tool_result",
        id: eventId,
        name: call.name,
        ok: outcome.ok,
        label: outcome.label,
        changed: outcome.changed,
      };
      messages.push(toolReply(call, outcome.modelText));
    }
  }
}

/** Tool arguments as an object; `{}` when the model emitted unparseable JSON. */
function safeParseArgs(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw || "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * One tool result, answering a specific call.
 *
 * `name` is not decoration: some providers' chat templates require it on a tool
 * message and 500 without it (qwen3.8-max is one), and the OpenAI SDK's type
 * dropped the field because it is deprecated upstream — which is how it went
 * missing here in the first place. LangChain's ToolMessage keeps it.
 */
function toolReply(call: { id: string; name: string }, content: string): ToolMessage {
  return new ToolMessage({ content, tool_call_id: call.id, name: call.name });
}

/** LangChain streaming fallback for non-OpenAI providers (answer only, text attachments only — no vision). */
async function* streamFallback(
  history: HistoryMessage[],
  userMessage: string,
  attachments: InputAttachment[] = [],
  signal?: AbortSignal,
): AsyncGenerator<AgentStreamEvent> {
  const model = getChatModel();
  let text = userMessage;
  for (const file of attachments.filter((a) => a.kind === "text")) {
    text += `\n\n--- Attached file: ${file.name} ---\n${file.data}`;
  }
  const messages = [
    new SystemMessage(CHAT_AGENT_PROMPT),
    ...history.map((m) =>
      m.role === "user" ? new HumanMessage(m.content) : new AIMessage(m.content),
    ),
    new HumanMessage(text),
  ];
  // Gated for the same reason as the main loop above — one account-wide quota.
  const stream = await gatedLlmCall(() => model.stream(messages, { signal }));
  const clean = toolMarkupFilter();
  for await (const chunk of stream) {
    const raw = typeof chunk.content === "string" ? chunk.content : "";
    if (raw) {
      const text = clean.push(raw);
      if (text) yield { type: "content", delta: text };
    }
  }
  const tail = clean.flush();
  if (tail) yield { type: "content", delta: tail };
}
