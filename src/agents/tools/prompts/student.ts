import type OpenAI from "openai";

/**
 * Read-only tools over the student's own profile and progress, as the model
 * sees them. See ../student-tools.ts for the implementations.
 */

export const getMyProfileTool: OpenAI.Chat.ChatCompletionFunctionTool = {
  type: "function",
  function: {
    name: "get_my_profile",
    description:
      "Read the student's profile: name, username, email, country, timezone, language, bio and member-since date. Contains no passwords or sensitive data.",
    parameters: { type: "object", properties: {} },
  },
};

export const getMyProgressTool: OpenAI.Chat.ChatCompletionFunctionTool = {
  type: "function",
  function: {
    name: "get_my_progress",
    description:
      "Read the student's learning progress and stats: enrollments, lessons, quiz scores, study time, routine tasks, project statuses and achievements. Call this before giving study advice.",
    parameters: { type: "object", properties: {} },
  },
};
