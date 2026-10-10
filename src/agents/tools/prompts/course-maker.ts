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
      "Show the student their learning path as ordered, selectable course cards — rendered as a visual roadmap (Step 1 → Step 2 → …) so they can see what comes first and pick what to create. Call this INSTEAD of writing a course plan as text; the cards are the only way the student can select. Use it for EVERY learn request once the guided intake is complete.\n" +
      "When the intake summary names a curriculum template, the SERVER fills the course list from it (one course for a language, exactly the roadmap's steps for a career); send your best list anyway, it is only used for the step labels.\n" +
      "Otherwise decide `breadth`, which fixes how many courses the path has:\n" +
      "- topic / subject: ONE skill, tool or field — 'Python', 'SQL', 'Git', 'Python for data analysis'. Exactly ONE course, never split into parts.\n" +
      "- career: only when the student asked for a role or career path — 'become a web developer', 'Android developer'. 4-10 courses covering the WHOLE syllabus a working practitioner needs, each a distinct subject.\n" +
      "Leave out subjects the student's profile says they already know. Saves the ordered path and returns a pathId; creates no courses. Write all fields in the language the intake named.",
    parameters: {
      type: "object",
      properties: {
        breadth: {
          type: "string",
          enum: ["topic", "subject", "career"],
          description:
            "topic or subject = exactly 1 course; career = a role or career path the student asked for (4-10 courses, the full syllabus). Ignored when a curriculum template matched.",
        },
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
            "The path's courses STRICTLY in learning order, foundational first — as many as `breadth` says (topic/subject 1, career 4-10). Their `covers` scopes must NOT overlap — each course owns a distinct slice so nothing is taught twice across the path.",
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
      required: ["goal", "breadth", "courses"],
    },
  },
};

export const createPathCoursesTool: OpenAI.Chat.ChatCompletionFunctionTool = {
  type: "function",
  function: {
    name: "create_path_courses",
    description:
      "Create the courses the student picked from a proposed learning path — ALL of them, in one call, in learning order. Call it when they reply 'Create these courses: …' after propose_courses. Pass the pathId propose_courses returned and the 1-based position of every chosen course. Takes about a minute per course; tell them you are building before the call. Courses beyond their plan's monthly limit are not created and stay on their path, where they can be created later from the Courses page.",
    parameters: {
      type: "object",
      properties: {
        pathId: {
          type: "string",
          description: "The pathId propose_courses returned, if you have it. Omit it to use the path you proposed most recently.",
        },
        orders: {
          type: "array",
          items: { type: "integer" },
          description:
            "The numbers of the courses they chose, as numbered in your proposal (1 = first course), e.g. [1, 2, 4]",
        },
      },
      required: ["orders"],
    },
  },
};
