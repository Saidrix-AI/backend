import type OpenAI from "openai";
import { LEVELS } from "../../../validation/course.schema.js";

/**
 * The two tools that hand work to the Course-maker agent, as the model sees
 * them. What the generated course actually contains is prompted separately in
 * ../../course-maker/prompt.ts. See ../course-maker-tools.ts for the
 * implementations.
 */

export const generateCourseTool: OpenAI.Chat.ChatCompletionFunctionTool = {
  type: "function",
  function: {
    name: "generate_course",
    description:
      "Generate and save a COMPLETE course for the student — full chapter/module/lesson roadmap with per-chapter summaries and outcomes, quizzes, and 8-10 linked hands-on projects. Use when the student wants to learn a subject. Call once per course; do not call list_courses first (duplicates are handled internally). Takes about a minute. Creates the structure only — lecture content for the lessons is added later.",
    parameters: {
      type: "object",
      properties: {
        objective: {
          type: "string",
          description: "What this course should teach and for whom, e.g. 'Python for data analysis, from zero'",
        },
        level: { type: "string", enum: [...LEVELS] },
        titleHint: { type: "string", description: "Preferred course title, if the student implied one" },
        pathId: {
          type: "string",
          description:
            "For a multi-course path only: the pathId returned by propose_courses. Pass it with `order` so this course is generated in sequence and without repeating what its sibling courses cover. Omit for a standalone single course.",
        },
        order: {
          type: "integer",
          description:
            "For a multi-course path only: this course's 1-based position in the proposed path (1 = first). Required alongside pathId.",
        },
        seriesContext: {
          type: "string",
          description:
            "Deprecated for paths (use pathId + order instead). Only for ad-hoc context when no pathId exists.",
        },
        priorKnowledge: {
          type: "string",
          description:
            "What the student already knows about this topic and related skills, from the conversation — e.g. 'Complete beginner, comfortable with Excel' or '2 years of Python, new to statistics'. Ignored when a knowledge check was completed: that profile is attached automatically.",
        },
        withProjects: {
          type: "boolean",
          description: "Also create 8-10 linked hands-on projects (default true)",
        },
      },
      required: ["objective"],
    },
  },
};

export const proposeCoursesTool: OpenAI.Chat.ChatCompletionFunctionTool = {
  type: "function",
  function: {
    name: "propose_courses",
    description:
      "Show the student 1-5 proposed courses as an ordered, selectable learning path — rendered as a visual roadmap (Step 1 → Step 2 → …) so they can see what comes first and pick what to create. Call this INSTEAD of writing a course plan as text; the cards are the only way the student can select. Use it for EVERY learn request once the guided intake is complete: a broad career goal becomes 3-5 steps, a single topic becomes 1-3 steps, foundational first. Saves the ordered path and returns a pathId; creates no courses. After the student selects, create each chosen course with generate_course, passing that pathId and the course's order. Write all fields in the language the intake named.",
    parameters: {
      type: "object",
      properties: {
        goal: {
          type: "string",
          description: "The overall goal this path leads to, e.g. 'Become a data scientist'. Shown as the path title.",
        },
        summary: {
          type: "string",
          description:
            "ONE short sentence on what this path gives the student, shown under the goal on their Courses page. Plain and concrete, no marketing. E.g. 'Scripting skills to take repetitive work off your hands.'",
        },
        courses: {
          type: "array",
          description:
            "1-5 proposed courses STRICTLY in learning order, foundational first (a single narrow topic may be just one). Their `covers` scopes must NOT overlap — each course owns a distinct slice so nothing is taught twice across the path.",
          items: {
            type: "object",
            required: ["title", "objective", "covers", "theme"],
            properties: {
              title: { type: "string", description: "Course title" },
              theme: {
                type: "string",
                description:
                  "1-3 words naming what this step is about, listed down the side of the path as its outline. NOT the course title and NOT the subject name — the reader already knows the subject. E.g. for a Python path: 'Language basics', 'Logic & loops', 'Reusable code'.",
              },
              objective: {
                type: "string",
                description:
                  "What this course teaches and for whom — reused as the generate_course objective if selected",
              },
              level: { type: "string", enum: [...LEVELS] },
              covers: {
                type: "string",
                description:
                  "1-2 lines naming the CONCRETE topics this course teaches — distinct from every other course in the path (this is what prevents repetition). E.g. 'Python syntax, data types, control flow, functions, files'.",
              },
              note: {
                type: "string",
                description:
                  "Optional one short line on where this fits the path, e.g. 'Start here — foundation for the rest'",
              },
            },
          },
        },
      },
      required: ["goal", "courses"],
    },
  },
};
