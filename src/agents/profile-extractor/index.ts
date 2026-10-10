import { env } from "../../config/env.js";
import type { ExtractableField } from "../../database/models/learnerProfile.model.js";
import {
  emptyLearnerFields,
  getLearnerProfile,
  upsertLearnerProfile,
} from "../../services/learnerProfile.service.js";
import { getModelName, hasOpenAICompatProvider } from "../llm.js";
import { formatZodIssues, runForcedToolCall, type LlmDeps } from "../shared/forcedToolCall.js";
import { buildExtractSystemPrompt, buildExtractUserMessage } from "./prompt.js";
import { buildExtractTool, extractedFactsSchema, type ExtractedFacts } from "./schema.js";

/**
 * Fills gaps in the learner profile from what the student says in chat.
 *
 * Runs fire-and-forget after a turn is persisted (services/chat.service.ts), so
 * it must never throw and never slow a reply down. Three gates keep it close to
 * free:
 *
 *   1. A profile with no empty fields short-circuits before any LLM call, so
 *      this stops running entirely once the wizard has been completed.
 *   2. Only the student's own recent messages are read — never the assistant's,
 *      which would let the tutor's guesses become "facts".
 *   3. upsertLearnerProfile with source "chat" refuses to overwrite anything the
 *      student typed in the wizard or on their profile page.
 */

const MAX_OUTPUT_TOKENS = 512;
/** How many of the student's own messages to look at. */
export const EXTRACT_WINDOW = 6;

function resolveDeps(): LlmDeps | null {
  if (!hasOpenAICompatProvider()) return null;
  return { model: env.COURSE_MAKER_MODEL ?? getModelName() };
}

/** The model call on its own, so the gating in `updateProfileFromChat` stays testable. */
export async function extractProfileFacts(
  messages: string[],
  fields: ExtractableField[],
  deps?: LlmDeps,
): Promise<ExtractedFacts> {
  const resolved = deps ?? resolveDeps();
  if (!resolved || !fields.length || !messages.length) return {};

  return runForcedToolCall({
    deps: resolved,
    tool: buildExtractTool(fields),
    system: buildExtractSystemPrompt(),
    user: buildExtractUserMessage(messages, fields),
    parse: (raw) => {
      const r = extractedFactsSchema.safeParse(raw ?? {});
      return r.success
        ? { success: true, data: r.data }
        : { success: false, issues: formatZodIssues(r.error) };
    },
    sizeHint: "Emit only the fields they clearly stated.",
    maxTokens: MAX_OUTPUT_TOKENS,
    label: "Profile extraction",
  });
}

/**
 * The whole pass: gate, extract, write. Returns the keys it filled, which is
 * only useful to tests — the caller does not await it.
 */
export async function updateProfileFromChat(
  userId: string,
  userMessages: string[],
  deps?: LlmDeps,
): Promise<ExtractableField[]> {
  try {
    const profile = await getLearnerProfile(userId);
    const missing = emptyLearnerFields(profile);
    if (!missing.length) return [];

    const recent = userMessages
      .map((m) => m.trim())
      .filter(Boolean)
      .slice(-EXTRACT_WINDOW);
    if (!recent.length) return [];

    const facts = await extractProfileFacts(recent, missing, deps);

    // Belt and braces: the tool schema only offers the missing fields, but a
    // model that invents an extra key must not be able to overwrite an answer.
    const patch: Record<string, unknown> = {};
    for (const key of missing) {
      if (facts[key] !== undefined) patch[key] = facts[key];
    }
    if (!Object.keys(patch).length) return [];

    await upsertLearnerProfile(userId, patch, "chat");
    return Object.keys(patch) as ExtractableField[];
  } catch {
    // A background nicety must never surface as a chat failure.
    return [];
  }
}
