import { SystemMessage } from "@langchain/core/messages";
import type { MessagesAnnotation } from "@langchain/langgraph";
import { getChatModel } from "../llm.js";
import { gatedLlmCall } from "../shared/llmGate.js";
import { CHAT_AGENT_PROMPT } from "./prompt.js";

export const CHAT_AGENT_NAME = "chat-agent";

/** LangGraph node: takes conversation messages, returns the tutor's reply. */
export async function chatAgentNode(
  state: typeof MessagesAnnotation.State,
): Promise<{ messages: unknown[] }> {
  const model = getChatModel();
  // Shares the account-wide quota with the generation pipeline — see
  // agents/shared/llmGate.ts. Ungated, this competed with calls the gate was
  // already pacing and 429'd both.
  const response = await gatedLlmCall(() =>
    model.invoke([new SystemMessage(CHAT_AGENT_PROMPT), ...state.messages]),
  );
  return { messages: [response] };
}
