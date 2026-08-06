import type OpenAI from "openai";

/**
 * Project CRUD tools as the model sees them. These manage the student's own
 * project cards; the AI that *designs* projects is the project-planner agent
 * (../../project-planner/prompt.ts) and the one that specs them is
 * project-requirements. See ../project-tools.ts for the implementations.
 */

export const listProjectsTool: OpenAI.Chat.ChatCompletionFunctionTool = {
  type: "function",
  function: {
    name: "list_projects",
    description:
      "List all of the student's projects with their ids, titles and tags. Call this before updating or deleting a project to find its id.",
    parameters: { type: "object", properties: {} },
  },
};

export const createProjectTool: OpenAI.Chat.ChatCompletionFunctionTool = {
  type: "function",
  function: {
    name: "create_project",
    description: "Create a new project for the student. Use when they ask to add or make a project.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Project title, e.g. 'Todo App'" },
        desc: { type: "string", description: "One-sentence description" },
        tags: { type: "array", items: { type: "string" }, description: "Short tags, e.g. ['react', 'api']" },
      },
      required: ["title"],
    },
  },
};

export const updateProjectTool: OpenAI.Chat.ChatCompletionFunctionTool = {
  type: "function",
  function: {
    name: "update_project",
    description:
      "Update an existing project's title, description or tags. Get the projectId from list_projects first.",
    parameters: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "The project id from list_projects" },
        title: { type: "string" },
        desc: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["projectId"],
    },
  },
};

export const deleteProjectTool: OpenAI.Chat.ChatCompletionFunctionTool = {
  type: "function",
  function: {
    name: "delete_project",
    description:
      "Permanently delete one of the student's projects. Only call this after the student has explicitly confirmed the deletion in their most recent message.",
    parameters: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "The project id from list_projects" },
      },
      required: ["projectId"],
    },
  },
};
