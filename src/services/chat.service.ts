import { AIMessage, HumanMessage, type BaseMessage } from "@langchain/core/messages";
import { Types } from "mongoose";
import { tutorGraph } from "../agents/graph.js";
import {
  CHAT_AGENT_NAME,
  streamChatAgent,
  PROPOSAL_HISTORY_MARKER,
  type AgentStreamEvent,
  type HistoryMessage,
  type SearchSource,
  type InputAttachment,
  type ProposedCourse,
  type AskQuestion,
  type AssessmentStart,
  type IntakeStart,
} from "../agents/chat-agent/index.js";
import { ConversationModel } from "../database/models/conversation.model.js";
import {
  EXTRACT_WINDOW,
  updateProfileFromChat,
} from "../agents/profile-extractor/index.js";
import { ApiError } from "../utils/apiError.js";
import { buildStudentContext } from "./studentMemory.service.js";
import { distillConversation } from "../agents/memory-distiller/index.js";

export interface ChatResult {
  reply: string;
  conversationId: string;
}

export type ChatStreamEvent =
  | AgentStreamEvent
  | { type: "done"; conversationId: string }
  | { type: "error"; message: string };

/** Tool action performed during a turn, persisted for the activity chips. */
interface MessageAction {
  name: string;
  label: string;
  ok: boolean;
  changed?: string;
}

/** Strips text-attachment content before persisting — only used for that turn's context. */
function attachmentMetadata(attachments: InputAttachment[] = []) {
  if (attachments.length === 0) return undefined;
  return attachments.map((a) => ({
    name: a.name,
    mimeType: a.mimeType,
    kind: a.kind,
    dataUrl: a.kind === "image" ? a.data : undefined,
  }));
}

/** Loads an existing conversation (owner-checked) or creates a new unsaved one. */
async function loadOrCreateConversation(userId: string, message: string, conversationId?: string) {
  if (conversationId) {
    if (!Types.ObjectId.isValid(conversationId)) {
      throw new ApiError(400, "Invalid conversation id");
    }
    const conversation = await ConversationModel.findOne({ _id: conversationId, userId });
    if (!conversation) {
      throw new ApiError(404, "Conversation not found");
    }
    return conversation;
  }
  return new ConversationModel({ userId, title: message.slice(0, 60), messages: [] });
}

export async function sendMessage(
  userId: string,
  message: string,
  conversationId?: string,
): Promise<ChatResult> {
  const conversation = await loadOrCreateConversation(userId, message, conversationId);

  const history: BaseMessage[] = conversation.messages.map((m) =>
    m.role === "user" ? new HumanMessage(m.content) : new AIMessage(m.content),
  );

  const result = await tutorGraph.invoke({
    messages: [...history, new HumanMessage(message)],
  });

  const last = result.messages.at(-1);
  const reply =
    typeof last?.content === "string" ? last.content : JSON.stringify(last?.content ?? "");

  conversation.messages.push(
    { role: "user", content: message },
    { role: "assistant", content: reply, agent: CHAT_AGENT_NAME },
  );
  await conversation.save();

  return { reply, conversationId: conversation.id };
}

/**
 * Streams a tutor reply as SSE-friendly events: interleaved `thinking` and
 * `content` deltas, then a final `done`. The full turn is persisted once the
 * stream completes. Errors are yielded as `error` events (never thrown) so the
 * SSE connection can close cleanly.
 */
export async function* streamMessage(
  userId: string,
  message: string,
  conversationId?: string,
  options: { webSearch?: boolean; attachments?: InputAttachment[]; signal?: AbortSignal } = {},
): AsyncGenerator<ChatStreamEvent> {
  let conversation;
  try {
    conversation = await loadOrCreateConversation(userId, message, conversationId);
  } catch (err) {
    yield { type: "error", message: err instanceof Error ? err.message : "Failed to start chat" };
    return;
  }

  const history: HistoryMessage[] = conversation.messages.map((m) => ({
    role: m.role as "user" | "assistant",
    content:
      m.role !== "assistant"
        ? m.content
        : m.proposal?.length
          ? m.content + proposalHistorySuffix(m.proposal)
          : m.intake
            ? m.content + intakeHistorySuffix()
            : m.assessment
              ? m.content + assessmentHistorySuffix(m.assessment.questions)
              : m.questions?.length
                ? m.content + questionsHistorySuffix(m.questions)
                : m.content,
  }));

  let content = "";
  let reasoning = "";
  const sources: SearchSource[] = [];
  const actions: MessageAction[] = [];
  let proposal: ProposedCourse[] | undefined;
  let questions: AskQuestion[] | undefined;
  let assessment: AssessmentStart | undefined;
  let intake: IntakeStart | undefined;
  // Everything known about this student, read once for the whole turn: who they
  // are, how they are doing, what they have been measured on, and what earlier
  // sessions were about. The chat agent is the one consumer that takes all four
  // slices — it is the only one having a conversation. Never throws (it returns
  // "" on any failure), so a missing profile can't break a chat.
  const learnerContext = await buildStudentContext(userId);

  try {
    for await (const ev of streamChatAgent(history, message, {
      forceSearch: options.webSearch,
      attachments: options.attachments,
      signal: options.signal,
      userId,
      learnerContext,
    })) {
      if (ev.type === "thinking") reasoning += ev.delta;
      else if (ev.type === "content") content += ev.delta;
      else if (ev.type === "sources") sources.push(...ev.sources);
      else if (ev.type === "course_proposal") proposal = ev.courses;
      else if (ev.type === "ask_questions") questions = ev.questions;
      else if (ev.type === "assessment") assessment = ev.assessment;
      else if (ev.type === "intake") intake = ev.intake;
      else if (ev.type === "tool_result" && ev.name !== "web_search") {
        actions.push({ name: ev.name, label: ev.label, ok: ev.ok, changed: ev.changed });
      }
      yield ev;
    }
  } catch (err) {
    // Client cancelled — persist whatever was generated so far instead of
    // surfacing an error, then stop (no `done` event to send).
    if (options.signal?.aborted) {
      if (content.trim() || reasoning.trim() || actions.length) {
        await persistTurn(
          conversation,
          message,
          content.trim() || "(no response — generation was cancelled)",
          reasoning,
          sources,
          actions,
          proposal,
          questions,
          assessment,
          intake,
          options.attachments,
        );
      }
      return;
    }
    yield { type: "error", message: err instanceof Error ? err.message : "Generation failed" };
    return;
  }

  // The model occasionally finishes without any answer text (e.g. it only
  // produced reasoning, or spent all tool rounds searching). Persist a
  // fallback so the required `content` field never fails validation, and let
  // the client know the turn produced nothing usable.
  const finalContent =
    content.trim() || "I couldn't generate a response for that. Please try again.";
  if (!content.trim()) {
    yield { type: "content", delta: finalContent };
  }

  await persistTurn(
    conversation,
    message,
    finalContent,
    reasoning,
    sources,
    actions,
    proposal,
    questions,
    assessment,
    intake,
    options.attachments,
  );
  yield { type: "done", conversationId: conversation.id };
}

/**
 * Compact text form of a persisted proposal, appended to the assistant turn in
 * model history (tool messages aren't replayed) so a later "create these"
 * selection can be resolved by title or number.
 */
function proposalHistorySuffix(
  courses: ReadonlyArray<{ title: string; objective: string; level?: string | null }>,
): string {
  const lines = courses.map(
    (c, i) => `${i + 1}. "${c.title}" — ${c.objective}${c.level ? ` (${c.level})` : ""}`,
  );
  return `\n\n${PROPOSAL_HISTORY_MARKER}\n${lines.join("\n")}]`;
}

/**
 * Compact text form of a persisted question batch, appended to the assistant
 * turn in model history (tool messages aren't replayed) so the model can see
 * what it asked before the student's answers arrive as a plain message.
 */
function questionsHistorySuffix(
  questions: ReadonlyArray<{ question: string; header: string }>,
): string {
  const lines = questions.map((q, i) => `${i + 1}. [${q.header}] ${q.question}`);
  return `\n\n[Questions you asked as interactive cards:\n${lines.join("\n")}]`;
}

/**
 * Marks a turn that started the guided intake. The stages run outside the chat
 * (client ↔ /api/intake), so the model must not re-interview the student — it
 * simply waits for the "Learning intake complete" message.
 */
function intakeHistorySuffix(): string {
  return (
    "\n\n[You started the guided intake (goal & target → language → knowledge check → timetable). " +
    "It runs in the cards outside this chat; the student's goal, chosen language, knowledge profile " +
    'and timetable arrive as one "Learning intake complete" message. Do not start another intake and ' +
    "do not ask any of it in text.]"
  );
}

/**
 * Marks a turn that started a knowledge check, so the model knows the student
 * is mid-assessment and must not start another one or interview them in text.
 */
function assessmentHistorySuffix(
  questions: ReadonlyArray<{ question: string; header: string }>,
): string {
  const lines = questions.map((q, i) => `${i + 1}. [${q.header}] ${q.question}`);
  return (
    `\n\n[You started a multi-round knowledge check. Round 1 asked:\n${lines.join("\n")}\n` +
    "The later rounds run outside this chat; the student's profile arrives as a " +
    '"Knowledge check complete" message. Do not start another check.]'
  );
}

type ConversationDoc = Awaited<ReturnType<typeof loadOrCreateConversation>>;

/** Persists a completed (or cancelled-but-partial) turn. */
async function persistTurn(
  conversation: ConversationDoc,
  message: string,
  finalContent: string,
  reasoning: string,
  sources: SearchSource[],
  actions: MessageAction[],
  proposal?: ProposedCourse[],
  questions?: AskQuestion[],
  assessment?: AssessmentStart,
  intake?: IntakeStart,
  attachments?: InputAttachment[],
) {
  conversation.messages.push(
    { role: "user", content: message, attachments: attachmentMetadata(attachments) },
    {
      role: "assistant",
      content: finalContent,
      reasoning: reasoning || undefined,
      sources: sources.length ? sources.map((s) => ({ title: s.title, url: s.url })) : undefined,
      actions: actions.length ? actions : undefined,
      proposal: proposal?.length ? proposal : undefined,
      questions: questions?.length ? questions : undefined,
      assessment: assessment ?? undefined,
      intake: intake ?? undefined,
      agent: CHAT_AGENT_NAME,
    },
  );
  await conversation.save();
  learnFromTurn(conversation);
  rememberFromTurn(conversation);
}

/**
 * Picks up anything the student said about themselves and fills gaps in their
 * learner profile. Deliberately not awaited: it is a background nicety, so it
 * must never delay a reply or fail a turn, and it short-circuits without an LLM
 * call once the profile is complete (see agents/profile-extractor).
 */
function learnFromTurn(conversation: ConversationDoc): void {
  const userMessages = conversation.messages
    .filter((m) => m.role === "user")
    .slice(-EXTRACT_WINDOW)
    .map((m) => m.content);
  if (!userMessages.length) return;

  void updateProfileFromChat(String(conversation.userId), userMessages);
}

/**
 * Folds this conversation's new messages into the student's rolling memory, so
 * the next conversation doesn't start blank.
 *
 * Sibling of learnFromTurn and deliberately not awaited for the same reason.
 * Unlike the extractor it reads the assistant's side too — "we spent the last
 * session on closures" is a fact about the session, not a claim about the
 * student — and it gates on how much has accumulated since the last pass rather
 * than running every turn (see agents/memory-distiller).
 */
function rememberFromTurn(conversation: ConversationDoc): void {
  void distillConversation(conversation);
}

export async function listConversations(userId: string) {
  return ConversationModel.find({ userId, deletedAt: null })
    .sort({ updatedAt: -1 })
    .select("title createdAt updatedAt")
    .lean();
}

export async function listTrash(userId: string) {
  return ConversationModel.find({ userId, deletedAt: { $ne: null } })
    .sort({ deletedAt: -1 })
    .select("title createdAt updatedAt deletedAt")
    .lean();
}

async function findOwnedConversation(userId: string, conversationId: string) {
  if (!Types.ObjectId.isValid(conversationId)) {
    throw new ApiError(400, "Invalid conversation id");
  }
  const conversation = await ConversationModel.findOne({ _id: conversationId, userId });
  if (!conversation) {
    throw new ApiError(404, "Conversation not found");
  }
  return conversation;
}

export async function moveToTrash(userId: string, conversationId: string) {
  const conversation = await findOwnedConversation(userId, conversationId);
  conversation.deletedAt = new Date();
  await conversation.save();
}

export async function restoreConversation(userId: string, conversationId: string) {
  const conversation = await findOwnedConversation(userId, conversationId);
  conversation.deletedAt = null;
  await conversation.save();
}

export async function permanentlyDeleteConversation(userId: string, conversationId: string) {
  await findOwnedConversation(userId, conversationId);
  await ConversationModel.deleteOne({ _id: conversationId, userId });
}

export async function getConversation(userId: string, conversationId: string) {
  if (!Types.ObjectId.isValid(conversationId)) {
    throw new ApiError(400, "Invalid conversation id");
  }
  const conversation = await ConversationModel.findOne({ _id: conversationId, userId });
  if (!conversation) {
    throw new ApiError(404, "Conversation not found");
  }
  return conversation;
}
