import type OpenAI from "openai";
import { LEVELS } from "../../../validation/course.schema.js";

/**
 * Course CRUD tools as the model sees them. A tool's `description` and its
 * parameter descriptions ARE prompt — they decide which tool gets called — so
 * they live here rather than buried in the tool's arg-parsing and run logic.
 * See ../course-tools.ts for the implementations.
 */

export const listCoursesTool: OpenAI.Chat.ChatCompletionFunctionTool = {
  type: "function",
  function: {
    name: "list_courses",
    description:
      "List all of the student's courses with their ids, titles, levels and lesson counts. Call this before updating or deleting a course to find its id.",
    parameters: { type: "object", properties: {} },
  },
};

export const createCourseTool: OpenAI.Chat.ChatCompletionFunctionTool = {
  type: "function",
  function: {
    name: "create_course",
    description: "Create a new course for the student. Use when they ask to add or make a course.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Course title, e.g. 'React Basics'" },
        desc: { type: "string", description: "One-sentence description" },
        level: { type: "string", enum: [...LEVELS] },
        lessons: { type: "number", description: "Planned number of lessons" },
      },
      required: ["title"],
    },
  },
};

export const updateCourseTool: OpenAI.Chat.ChatCompletionFunctionTool = {
  type: "function",
  function: {
    name: "update_course",
    description:
      "Update an existing course's title, description, level or lesson count. Get the courseId from list_courses first.",
    parameters: {
      type: "object",
      properties: {
        courseId: { type: "string", description: "The course id from list_courses" },
        title: { type: "string" },
        desc: { type: "string" },
        level: { type: "string", enum: [...LEVELS] },
        lessons: { type: "number" },
      },
      required: ["courseId"],
    },
  },
};

export const organizeLearningPathTool: OpenAI.Chat.ChatCompletionFunctionTool = {
  type: "function",
  function: {
    name: "organize_learning_path",
    description:
      "Organize the student's EXISTING courses into an ordered learning path so the Courses page shows them as a step-by-step roadmap with sequential lock/unlock (step 1 open, later steps unlock as the prior one is completed). Use when the student asks to order/sequence/organize their courses into a path or 'learning guide', or asks what to study first. Call list_courses first to get the ids, then pass them in the correct LEARNING order (foundational first, e.g. HTML → CSS → JavaScript). Does not create or modify course content.",
    parameters: {
      type: "object",
      properties: {
        goal: {
          type: "string",
          description: "The overall goal / path title, e.g. 'Front-End Web Development'. Shown as the path heading.",
        },
        courseIds: {
          type: "array",
          items: { type: "string" },
          description: "The student's existing course ids (from list_courses), in learning order — foundational first.",
        },
      },
      required: ["goal", "courseIds"],
    },
  },
};

export const deleteCourseTool: OpenAI.Chat.ChatCompletionFunctionTool = {
  type: "function",
  function: {
    name: "delete_course",
    description:
      "Permanently delete one of the student's courses. Only call this after the student has explicitly confirmed the deletion in their most recent message.",
    parameters: {
      type: "object",
      properties: {
        courseId: { type: "string", description: "The course id from list_courses" },
      },
      required: ["courseId"],
    },
  },
};
