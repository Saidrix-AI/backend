import { AIMessage, HumanMessage, type BaseMessage } from "@langchain/core/messages";
import { Types } from "mongoose";
import { tutorGraph } from "../agents/graph.js";
import { CHAT_AGENT_NAME } from "../agents/chat-agent/index.js";
import { ConversationModel } from "../database/models/conversation.model.js";
import { ApiError } from "../utils/apiError.js";

export interface ChatResult {
  reply: string;
  conversationId: string;
}

export async function sendMessage(
  userId: string,
  message: string,
  conversationId?: string,
): Promise<ChatResult> {
  let conversation;
  if (conversationId) {
    if (!Types.ObjectId.isValid(conversationId)) {
      throw new ApiError(400, "Invalid conversation id");
    }
    conversation = await ConversationModel.findOne({ _id: conversationId, userId });
    if (!conversation) {
      throw new ApiError(404, "Conversation not found");
    }
  } else {
    conversation = new ConversationModel({
      userId,
      title: message.slice(0, 60),
      messages: [],
    });
  }

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
