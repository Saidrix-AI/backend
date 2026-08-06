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
      "Search the Saidrix curriculum — 208 in-house deep-dive skill guides (each with Beginner/Intermediate/Advanced paths) spanning programming languages, frontend, backend, mobile, databases, architecture, DevOps, security, testing, DSA, game/embedded, and soft skills. Use this FIRST for 'how do I learn / teach me / roadmap for / what should I study / explain from our curriculum' questions, to ground answers in Saidrix's own material and cite it.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "A focused query describing the skill or topic to look up.",
        },
        level: {
          type: "string",
          enum: ["beginner", "intermediate", "advanced"],
          description: "Optional: restrict results to one difficulty level.",
        },
        category: {
          type: "string",
          description:
            "Optional: restrict to a category name, e.g. 'Frontend Development', 'Security', 'Soft Skills and Career'.",
        },
      },
      required: ["query"],
    },
  },
};

export const SEARCH_COURSE_CONTENT_TOOL_NAME = "search_course_content";
