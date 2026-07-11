import { END, START, StateGraph, MessagesAnnotation } from "@langchain/langgraph";
import { chatAgentNode } from "./chat-agent/index.js";

// Single-agent graph for now. To add a new agent:
// 1. Create a folder under src/agents/<agent-name>/ (index.ts + prompt.ts + node)
// 2. addNode() it here and wire edges / conditional routing.
export const tutorGraph = new StateGraph(MessagesAnnotation)
  .addNode("chatAgent", chatAgentNode)
  .addEdge(START, "chatAgent")
  .addEdge("chatAgent", END)
  .compile();
