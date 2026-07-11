import { SystemMessage } from "@langchain/core/messages";
import type { MessagesAnnotation } from "@langchain/langgraph";
import { getChatModel } from "../llm.js";
import { CHAT_AGENT_PROMPT } from "./prompt.js";

export const CHAT_AGENT_NAME = "chat-agent";

/** LangGraph node: takes conversation messages, returns the tutor's reply. */
export async function chatAgentNode(
  state: typeof MessagesAnnotation.State,
): Promise<{ messages: unknown[] }> {
  const model = getChatModel();
  const response = await model.invoke([
    new SystemMessage(CHAT_AGENT_PROMPT),
    ...state.messages,
  ]);
  return { messages: [response] };
}
