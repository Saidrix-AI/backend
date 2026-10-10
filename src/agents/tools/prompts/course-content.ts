import type OpenAI from "openai";

/**
 * The curriculum-search tool as the model sees it. Attached only when the RAG
 * layer is configured (see ../../../rag). Retrieval lives in ../course-content-search.ts.
 */
export const courseContentSearchTool: OpenAI.Chat.ChatCompletionFunctionTool = {
  type: "function",
  function: {
    name: "search_course_content",
    description:
      "Search the Saidrix curriculum — 64 in-house guides: a foundation course for each of ~37 programming languages (8 modules each, with practice tasks and completion criteria), step-by-step career roadmaps for web, Android, iOS, cross-platform, Windows desktop, remote, QA, security and system-software roles (frontend, backend, full-stack, DevOps, QA, security), and the software-engineering career structure. Use this FIRST for 'how do I learn / teach me / roadmap for / what should I study / explain from our curriculum' questions, to ground answers in Saidrix's own material and cite it.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "A focused query describing the skill or topic to look up.",
        },
        category: {
          type: "string",
          enum: ["Programming Language Foundations", "Career Roadmaps", "Career Guides"],
          description: "Optional: restrict to one part of the curriculum.",
        },
      },
      required: ["query"],
    },
  },
};

export const SEARCH_COURSE_CONTENT_TOOL_NAME = "search_course_content";
