import { SystemMessage, HumanMessage, AIMessage } from "@langchain/core/messages";
import type OpenAI from "openai";
import { getChatModel, getOpenAICompatClient, reasoningParams } from "../llm.js";
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
function buildUserMessage(
  userMessage: string,
  attachments: InputAttachment[] = [],
): OpenAI.Chat.ChatCompletionUserMessageParam {
  const textFiles = attachments.filter((a) => a.kind === "text");
  const images = attachments.filter((a) => a.kind === "image");

  let text = userMessage;
  for (const file of textFiles) {
    text += `\n\n--- Attached file: ${file.name} ---\n${file.data}`;
  }

  if (images.length === 0) {
    return { role: "user", content: text };
  }

  return {
    role: "user",
    content: [
      { type: "text", text },
      ...images.map((img) => ({
        type: "image_url" as const,
        image_url: { url: img.data },
      })),
    ],
  };
}

const MAX_TOOL_ITERATIONS = 5;

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
const DESTRUCTIVE_TOOLS = new Set(["delete_course", "delete_project", "delete_routine_item"]);
const MAX_DESTRUCTIVE_CALLS_PER_TURN = 3;

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
  const oai = getOpenAICompatClient();

  if (!oai) {
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
      forcedTool = "generate_course";
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
      const route = await classifyCourseIntent(
        oai.client,
        env.COURSE_MAKER_MODEL ?? oai.model,
        history,
        userMessage,
        options.signal,
      );
      if (route) forcedTool = forcedToolFor(route, historyHasProposal(history));
    }
    if (forcedTool && !toolset.has(forcedTool)) forcedTool = null;
  }
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    {
      role: "system",
      content: buildChatAgentPrompt({
        dbTools: Boolean(options.userId),
        curriculum: toolset.has(SEARCH_COURSE_CONTENT_TOOL_NAME),
        today: new Date().toISOString().slice(0, 10),
        ...(options.learnerContext ? { learner: options.learnerContext } : {}),
      }),
    },
    ...history.map((m) => ({ role: m.role, content: m.content })),
    buildUserMessage(userMessage, options.attachments),
  ];

  // Counts every delete_* call attempted across the whole turn (all
  // iterations, successes and failures alike) — declared outside the
  // iteration loop because the runaway batch that motivated this reached
  // across iterations: list_routine ran in between the failed attempts and
  // the mass delete.
  let destructiveCalls = 0;

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
    const forceThisTurn = iteration === 0 && options.forceSearch && searchEnabled;
    // On the final allowed turn, disable tools so the model must produce a
    // text answer instead of requesting yet another search (which we'd have
    // no round left to satisfy, leaving an empty reply).
    const lastTurn = iteration === MAX_TOOL_ITERATIONS - 1;

    const stream = await oai.client.chat.completions.create(
      {
        model: oai.model,
        stream: true,
        messages,
        ...(toolSchemas.length > 0
          ? {
              tools: toolSchemas,
              tool_choice: forceThisTurn
                ? { type: "function", function: { name: WEB_SEARCH_TOOL_NAME } }
                : iteration === 0 && forcedTool
                  ? { type: "function", function: { name: forcedTool } }
                  : lastTurn
                    ? "none"
                    : "auto",
            }
          : {}),
        // Ask OpenRouter to include reasoning tokens (non-standard field).
        ...({ include_reasoning: true } as Record<string, unknown>),
        // gpt-5.x rejects function tools unless reasoning is off — see llm.ts.
        ...reasoningParams(oai.model),
      },
      { signal: options.signal },
    );

    let content = "";
    const slots: { id: string; name: string; args: string }[] = [];

    for await (const chunk of stream) {
      const choice = chunk.choices[0];
      const delta = choice?.delta as
        | {
            content?: string | null;
            reasoning?: string | null;
            tool_calls?: Array<{
              index: number;
              id?: string;
              function?: { name?: string; arguments?: string };
            }>;
          }
        | undefined;

      if (delta?.reasoning) yield { type: "thinking", delta: delta.reasoning };
      if (delta?.content) {
        content += delta.content;
        yield { type: "content", delta: delta.content };
      }
      for (const tc of delta?.tool_calls ?? []) {
        const slot = (slots[tc.index] ??= { id: "", name: "", args: "" });
        if (tc.id) slot.id = tc.id;
        if (tc.function?.name) slot.name += tc.function.name;
        if (tc.function?.arguments) slot.args += tc.function.arguments;
      }
    }

    // Trust the tool calls themselves, NOT finish_reason: gpt-4o-mini closes a
    // FORCED tool call with finish_reason "stop" (glm-5.2 says "tool_calls"),
    // and gating on the label silently threw the call away — every forced tool
    // turn came back as an empty reply. Sparse indices and half-streamed slots
    // are filtered out here rather than reaching the toolset lookup.
    const toolCalls = slots.filter((t) => t?.name);

    // No tool requested → this was the final answer.
    if (toolCalls.length === 0) return;

    // Record the assistant's tool-call turn, then run each tool.
    messages.push({
      role: "assistant",
      content: content || null,
      tool_calls: toolCalls.map((t) => ({
        id: t.id,
        type: "function",
        function: { name: t.name, arguments: t.args },
      })),
    });

    for (const [index, call] of toolCalls.entries()) {
      const tool = toolset.get(call.name);
      if (!tool) {
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: "Unknown tool.",
        });
        continue;
      }

      let args: Record<string, unknown> = {};
      try {
        // Malformed JSON falls through to {} — the tool's zod schema reports
        // the missing fields back to the model so it can retry.
        args = JSON.parse(call.args || "{}") as Record<string, unknown>;
      } catch {
        args = {};
      }

      const eventId = `${iteration}-${index}`;
      yield {
        type: "tool_call",
        id: eventId,
        name: call.name,
        label: tool.runningLabel(args),
        query: typeof args.query === "string" ? args.query : "",
      };

      let outcome: Awaited<ReturnType<typeof tool.run>>;
      if (DESTRUCTIVE_TOOLS.has(call.name) && ++destructiveCalls > MAX_DESTRUCTIVE_CALLS_PER_TURN) {
        // Over the cap: don't touch the database at all. The model gets a
        // message it can show the student, rather than a wall of silent
        // deletions it keeps working through.
        outcome = {
          ok: false,
          label: "Stopped — too many deletions in one turn",
          modelText:
            `You've hit the limit of ${MAX_DESTRUCTIVE_CALLS_PER_TURN} delete attempts for this turn ` +
            "(some may have failed). Stop deleting now — tell the student exactly what you did and did " +
            "not delete, and ask them to confirm before you delete anything else.",
        };
      } else {
        outcome = await tool.run({ userId: options.userId ?? "" }, args);
      }
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
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: outcome.modelText,
      });
    }
  }
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
  const stream = await model.stream(messages, { signal });
  for await (const chunk of stream) {
    const text = typeof chunk.content === "string" ? chunk.content : "";
    if (text) yield { type: "content", delta: text };
  }
}
