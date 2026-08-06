import type OpenAI from "openai";
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

function transcript(history: HistoryMessage[]): string {
  if (history.length === 0) return "(none)";
  return history
    .slice(-MAX_HISTORY_MESSAGES)
    .map((m) => `${m.role === "user" ? "student" : "assistant"}: ${m.content.slice(0, MAX_MESSAGE_CHARS)}`)
    .join("\n");
}

/** Classifies the turn; returns null on any failure so the caller can skip forcing. */
export async function classifyCourseIntent(
  client: OpenAI,
  model: string,
  history: HistoryMessage[],
  userMessage: string,
  signal?: AbortSignal,
): Promise<CourseRoute | null> {
  try {
    const completion = await client.chat.completions.create(
      {
        model,
        messages: [
          { role: "system", content: ROUTER_PROMPT },
          { role: "user", content: `Chat so far:\n${transcript(history)}\n\nLATEST student message: ${userMessage.slice(0, MAX_MESSAGE_CHARS)}` },
        ],
        max_tokens: 60,
        temperature: 0,
        response_format: { type: "json_object" },
      },
      { signal, timeout: 10_000, maxRetries: 0 },
    );
    const raw = JSON.parse(completion.choices?.[0]?.message?.content ?? "") as {
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
  if (route.intent === "selection") return hasProposal ? "generate_course" : null;
  if (route.intent === "routine") {
    return route.routineReady ? "list_courses" : "ask_routine_setup";
  }
  if (route.intent === "single" || route.intent === "multi") {
    return "start_learning_intake";
  }
  return null;
}
