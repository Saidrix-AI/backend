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
      "Permanently delete ONE of the student's projects. Only call this after the student has explicitly confirmed the deletion in their most recent message. To remove several projects at once, use delete_projects instead — repeating this tool is capped per turn and the rest will be refused.",
    parameters: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "The project id from list_projects" },
      },
      required: ["projectId"],
    },
  },
};

/** Bulk counterpart — see the note on deleteRoutineItemsTool for why it exists. */
export const deleteProjectsTool: OpenAI.Chat.ChatCompletionFunctionTool = {
  type: "function",
  function: {
    name: "delete_projects",
    description:
      "Permanently delete MANY projects in ONE call — use this whenever the student asks to delete all their projects or more than one of them. Call list_projects first to get the ids, then pass every id to remove here. ALWAYS prefer this over repeating delete_project, which is capped per turn. Only call it after the student has explicitly confirmed in their most recent message — say how many projects will go, and wait for their answer.",
    parameters: {
      type: "object",
      properties: {
        projectIds: {
          type: "array",
          description: "The project ids to delete, from list_projects",
          items: { type: "string" },
        },
      },
      required: ["projectIds"],
    },
  },
};
