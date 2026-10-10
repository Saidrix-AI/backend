import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { ChatOpenAI } from "@langchain/openai";
import { gatedLlmCall } from "../shared/llmGate.js";
import { ROUTINE_SETUP_HEADERS } from "../tools/prompts/routine.js";
import { ROUTER_PROMPT } from "./prompt.js";
import type { HistoryMessage } from "./stream.js";

/**
 * Course-intent router. Small models reliably EMIT tool calls when forced via
 * tool_choice but are unreliable at CHOOSING course tools among many on their
 * own (they narrate the plan as text instead). One cheap temperature-0
 * classification decides whether to force generate_course / propose_courses
 * on the first tool round; any router failure degrades to no forcing.
 */

/** Exact prefix the proposal-cards "Create selected" button sends. */
export const SELECTION_PREFIX = "Create these courses:";

/**
 * Exact prefixes the finished knowledge check sends. Which one the client uses
 * comes from the assessment's `nextAction`, so the course tool that follows a
 * completed check is decided by the server, not re-classified by a small model.
 *
 * The standalone check has been folded into the guided intake; these are kept
 * so conversations that were mid-check when that shipped still resolve.
 */
export const ASSESSMENT_DONE_PREFIX = "Knowledge check complete:";
export const ASSESSMENT_DONE_MULTI_PREFIX = "Knowledge check complete (multi):";

/** Marker that prefixes a re-injected proposal in model history (see chat.service). */
export const PROPOSAL_HISTORY_MARKER = "[Courses you proposed as selectable cards:";

export interface CourseRoute {
  intent: "single" | "multi" | "selection" | "routine" | "other";
  knowledgeKnown: boolean;
  /** Whether the routine setup answers (course + finish-by + time) are already in hand. */
  routineReady: boolean;
}

/**
 * True for the message the routine setup cards compile ("Study time: …" plus at
 * least one other setup line). Recognising it here skips the router entirely for
 * that turn, so the answers can never be re-interpreted as a fresh request for
 * the same questions.
 */
export function isRoutineSetupAnswer(message: string): boolean {
  const has = (header: string) => message.includes(`${header}:`);
  return (
    has(ROUTINE_SETUP_HEADERS.time) &&
    (has(ROUTINE_SETUP_HEADERS.deadline) || has(ROUTINE_SETUP_HEADERS.days))
  );
}

const MAX_HISTORY_MESSAGES = 8;
const MAX_MESSAGE_CHARS = 400;

/**
 * The router sits in front of every chat turn, so its budget is a latency
 * decision, not a correctness one — a router that has not answered by now is
 * worse than no router, and failing returns null, which just skips forcing.
 * Raised from 10s when the default model became a reasoning model: those spend
 * their first tokens thinking, and 10s was cutting them off mid-thought, which
 * disabled forced tools on every turn rather than occasionally.
 */
const ROUTER_TIMEOUT_MS = 20_000;

/**
 * The JSON out of a reply, tolerating a reasoning model that wraps it in a
 * ```json fence or pads it with a sentence. response_format:"json_object" would
 * be the strict fix, but not every model on TokenRouter accepts the field, and
 * a router that throws is a router that silently stops forcing tools.
 */
function jsonFrom(content: unknown): string {
  const text = typeof content === "string" ? content : "";
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced?.[1] ?? text).trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  return start >= 0 && end > start ? body.slice(start, end + 1) : body;
}

function transcript(history: HistoryMessage[]): string {
  if (history.length === 0) return "(none)";
  return history
    .slice(-MAX_HISTORY_MESSAGES)
    .map((m) => `${m.role === "user" ? "student" : "assistant"}: ${m.content.slice(0, MAX_MESSAGE_CHARS)}`)
    .join("\n");
}

/**
 * Output cap. Generous for a 3-field JSON object, because a reasoning model
 * spends part of the budget thinking before it writes any of it.
 */
export const ROUTER_MAX_TOKENS = 512;

/** Classifies the turn; returns null on any failure so the caller can skip forcing. */
export async function classifyCourseIntent(
  chat: ChatOpenAI,
  history: HistoryMessage[],
  userMessage: string,
  signal?: AbortSignal,
): Promise<CourseRoute | null> {
  try {
    // One request, but on the SAME account-wide quota as everything else, and it
    // fires on every chat turn — ungated it was the cheapest way to overspend
    // the window. See agents/shared/llmGate.ts.
    const reply = await gatedLlmCall(() =>
      chat.invoke(
        [
          new SystemMessage(ROUTER_PROMPT),
          new HumanMessage(
            `Chat so far:\n${transcript(history)}\n\nLATEST student message: ${userMessage.slice(0, MAX_MESSAGE_CHARS)}`,
          ),
        ],
        { signal, options: { timeout: ROUTER_TIMEOUT_MS, maxRetries: 0 } },
      ),
    );
    const raw = JSON.parse(jsonFrom(reply.content)) as {
      intent?: unknown;
      knowledge_known?: unknown;
      routine_ready?: unknown;
    };
    if (
      raw.intent !== "single" &&
      raw.intent !== "multi" &&
      raw.intent !== "selection" &&
      raw.intent !== "routine" &&
      raw.intent !== "other"
    ) {
      return null;
    }
    return {
      intent: raw.intent,
      knowledgeKnown: raw.knowledge_known === true,
      routineReady: raw.routine_ready === true,
    };
  } catch {
    return null;
  }
}

/** True when the model's own history shows it proposed courses earlier. */
export function historyHasProposal(history: HistoryMessage[]): boolean {
  return history.some(
    (m) => m.role === "assistant" && m.content.includes(PROPOSAL_HISTORY_MARKER),
  );
}

export type ForcedTool =
  | "generate_course"
  | "create_path_courses"
  | "propose_courses"
  | "start_learning_intake"
  | "ask_routine_setup"
  | "list_courses";

/**
 * Which tool to force on the first tool round, if any. A request to learn
 * something forces start_learning_intake so the goal/language/knowledge/
 * timetable questions render as interactive cards instead of the model
 * narrating them as plain text; a routine request forces ask_routine_setup for
 * the same reason, then list_courses once the answers are in so the schedule is
 * built on real lesson counts.
 *
 * Even a student who already stated their level goes through the intake — the
 * language question is required before anything is generated, and it is the
 * only place it gets asked.
 *
 * `hasProposal` gates the "selection" intent: without an actual prior proposal a
 * "selection" is a misclassification (e.g. "add my courses to my routine" reads
 * like picking courses), so we must NOT fabricate a course by forcing generation.
 */
export function forcedToolFor(route: CourseRoute, hasProposal: boolean): ForcedTool | null {
  if (route.intent === "selection") return hasProposal ? "create_path_courses" : null;
  if (route.intent === "routine") {
    return route.routineReady ? "list_courses" : "ask_routine_setup";
  }
  if (route.intent === "single" || route.intent === "multi") {
    return "start_learning_intake";
  }
  return null;
}
