import { env } from "../../config/env.js";
import { ConversationModel } from "../../database/models/conversation.model.js";
import { StudentMemoryModel } from "../../database/models/studentMemory.model.js";
import { getModelName, hasOpenAICompatProvider } from "../llm.js";
import { formatZodIssues, runForcedToolCall, type LlmDeps } from "../shared/forcedToolCall.js";
import { buildDistillSystemPrompt, buildDistillUserMessage } from "./prompt.js";
import { distillTool, distilledMemorySchema } from "./schema.js";

/**
 * Keeps the student's rolling memory up to date from their conversations.
 *
 * Runs fire-and-forget after a turn is persisted (services/chat.service.ts), so
 * like the profile extractor beside it, it must never throw and never slow a
 * reply down. Unlike the extractor it reads the tutor's side of the transcript
 * too — "the last session was spent on closures" is a fact about the session,
 * not a claim about the student — which is exactly why its output is treated as
 * untrusted downstream.
 *
 * Three gates keep the cost near zero:
 *   1. Nothing happens until DISTILL_EVERY new messages have accumulated, so
 *      this is roughly one small call per four exchanges, not one per turn.
 *   2. No configured LLM client short-circuits before any work.
 *   3. An in-flight conversation is skipped rather than distilled twice.
 */

/**
 * New messages required before a pass runs. Messages are pushed two at a time
 * (user + assistant), so 8 is four exchanges — long enough that there is
 * something worth writing down, short enough that a single session gets
 * remembered before the student closes the tab.
 */
export const DISTILL_EVERY = 8;

/**
 * Upper bound on how much transcript one pass reads. Only reachable if
 * distillation was broken or disabled for a while and a backlog built up;
 * without it, re-enabling it would send one enormous call. The skipped middle is
 * accepted on purpose — the notes are a summary, not an archive.
 */
const MAX_SLICE_MESSAGES = 24;

/** Per-message clamp. A single tutor reply can run to thousands of characters. */
const MAX_MESSAGE_CHARS = 600;

const MAX_OUTPUT_TOKENS = 700;

/**
 * Conversations currently being distilled, so two turns arriving close together
 * cannot both pay for the same slice. Per-process, like the generation-job map
 * in lecture.service — the conditional update below is what keeps a second
 * process from double-advancing the cursor.
 */
const inFlight = new Set<string>();

function resolveDeps(): LlmDeps | null {
  if (!hasOpenAICompatProvider()) return null;
  return {
    model: env.MEMORY_DISTILLER_MODEL ?? env.COURSE_MAKER_MODEL ?? getModelName(),
  };
}

/** The minimum a caller must supply — a mongoose doc satisfies it structurally. */
export interface DistillableConversation {
  _id: unknown;
  userId: unknown;
  distilledUpTo?: number | null;
  messages: ReadonlyArray<{ role: string; content: string }>;
}

/** Reported speech, never raw roles — see the note on buildDistillUserMessage. */
function toExchangeLines(
  messages: ReadonlyArray<{ role: string; content: string }>,
): string[] {
  return messages
    .map((m) => {
      const text = String(m.content ?? "").trim().slice(0, MAX_MESSAGE_CHARS);
      if (!text) return "";
      return `${m.role === "assistant" ? "Tutor" : "Student"}: ${text}`;
    })
    .filter(Boolean);
}

/** The model call on its own, so the gating in distillConversation stays testable. */
export async function distillMemory(
  previous: string,
  exchanges: string[],
  deps?: LlmDeps,
): Promise<string> {
  const resolved = deps ?? resolveDeps();
  if (!resolved || !exchanges.length) return "";

  const result = await runForcedToolCall({
    deps: resolved,
    tool: distillTool,
    system: buildDistillSystemPrompt(),
    user: buildDistillUserMessage(previous, exchanges),
    parse: (raw) => {
      const r = distilledMemorySchema.safeParse(raw ?? {});
      return r.success
        ? { success: true, data: r.data }
        : { success: false, issues: formatZodIssues(r.error) };
    },
    sizeHint: "Keep the notes well under the character limit — drop the least useful lines.",
    maxTokens: MAX_OUTPUT_TOKENS,
    label: "Memory distillation",
  });

  return result.narrative;
}

/**
 * The whole pass: gate, distill, write. Returns the new narrative, which is only
 * useful to tests — the caller does not await it.
 *
 * On any failure the previous narrative is kept AND the cursor is left where it
 * was, so the same slice is retried after the next turn rather than lost.
 */
export async function distillConversation(
  conversation: DistillableConversation,
  deps?: LlmDeps,
): Promise<string> {
  const key = String(conversation._id);
  if (inFlight.has(key)) return "";

  try {
    const from = Math.max(0, conversation.distilledUpTo ?? 0);
    const to = conversation.messages.length;
    if (to - from < DISTILL_EVERY) return "";
    if (!deps && !resolveDeps()) return "";

    const exchanges = toExchangeLines(
      conversation.messages.slice(from, to).slice(-MAX_SLICE_MESSAGES),
    );
    if (!exchanges.length) return "";

    inFlight.add(key);
    const userId = String(conversation.userId);
    const previous = await currentNarrative(userId);
    const narrative = await distillMemory(previous, exchanges, deps);
    if (!narrative) return "";

    await StudentMemoryModel.updateOne(
      { userId: conversation.userId },
      { $set: { narrative, narrativeAt: new Date() }, $inc: { distillCount: 1 } },
      { upsert: true },
    );

    // Conditional on the cursor still being behind: the doc handed to us was
    // read before the LLM call and may be stale by now, and writing it back
    // wholesale (via .save()) would clobber turns persisted in the meantime.
    await ConversationModel.updateOne(
      { _id: conversation._id, distilledUpTo: { $lt: to } },
      { $set: { distilledUpTo: to } },
    );

    return narrative;
  } catch {
    // A background nicety must never surface as a chat failure.
    return "";
  } finally {
    inFlight.delete(key);
  }
}

async function currentNarrative(userId: string): Promise<string> {
  const doc = await StudentMemoryModel.findOne({ userId }).select("narrative").lean();
  return doc?.narrative ?? "";
}
