import type OpenAI from "openai";
import type { AskQuestion } from "../types.js";

/**
 * Routine tools as the model sees them. There is no routine *agent* — the
 * whole feature is driven by these descriptions plus the "Scheduling & study
 * plans" section of the chat prompt (../../chat-agent/prompt.ts), so this file
 * is where routine wording is tuned. See ../routine-tools.ts for the
 * implementations.
 */

/** Routine item kinds, shared by the tool schemas and their zod args. */
export const ROUTINE_TYPES = ["class", "task", "project"] as const;

/** Bulk cap. Real study plans needed ~81 items for 3 courses; 150 leaves room. */
export const MAX_BULK_ITEMS = 150;

/** Item fields, reused by the single-create and bulk-create schemas. */
const ITEM_PROPERTIES = {
  type: { type: "string", enum: [...ROUTINE_TYPES], description: "What kind of item this is" },
  title: { type: "string", description: "Item title, e.g. 'Physics class'" },
  date: { type: "string", description: "Date in YYYY-MM-DD format" },
  time: { type: "string", description: "Start time, e.g. '09:00 AM'" },
  durationMin: { type: "number", description: "Duration in minutes" },
  subtitle: { type: "string", description: "Short extra detail" },
  tag: { type: "string", description: "Short tag, e.g. 'physics'" },
  deadline: { type: "string", description: "Deadline in YYYY-MM-DD format (tasks/projects)" },
};

export const listRoutineTool: OpenAI.Chat.ChatCompletionFunctionTool = {
  type: "function",
  function: {
    name: "list_routine",
    description:
      "List the student's routine items (classes, tasks, project work) with ids, dates and completion state. Call this before updating or deleting an item to find its id.",
    parameters: { type: "object", properties: {} },
  },
};

export const createRoutineItemTool: OpenAI.Chat.ChatCompletionFunctionTool = {
  type: "function",
  function: {
    name: "create_routine_item",
    description:
      "Add an item to the student's routine/schedule: a class, a task or project work on a specific date.",
    parameters: {
      type: "object",
      properties: ITEM_PROPERTIES,
      required: ["type", "title", "date"],
    },
  },
};

export const createRoutineItemsTool: OpenAI.Chat.ChatCompletionFunctionTool = {
  type: "function",
  function: {
    name: "create_routine_items",
    description:
      `Add MANY routine items in ONE call — use this to build a multi-day study plan or schedule ` +
      `(e.g. spreading a course's lessons across days). ALWAYS prefer this over calling ` +
      `create_routine_item repeatedly. This actually saves the plan; do not just describe a schedule ` +
      `in text. Up to ${MAX_BULK_ITEMS} items per call; if a plan needs more, call this again for the rest. ` +
      `Every date must be TODAY OR LATER — use the current date given in your system prompt, never a ` +
      `date from your own training period; past-dated plans are rejected.`,
    parameters: {
      type: "object",
      properties: {
        items: {
          type: "array",
          description: `The routine items to add (up to ${MAX_BULK_ITEMS} at once)`,
          items: {
            type: "object",
            required: ["type", "title", "date"],
            properties: {
              ...ITEM_PROPERTIES,
              title: { type: "string", description: "Item title, e.g. 'Python Basics - Lesson 1'" },
            },
          },
        },
      },
      required: ["items"],
    },
  },
};

export const updateRoutineItemTool: OpenAI.Chat.ChatCompletionFunctionTool = {
  type: "function",
  function: {
    name: "update_routine_item",
    description:
      "Update a routine item — reschedule it, rename it, or mark it completed. Get the itemId from list_routine first.",
    parameters: {
      type: "object",
      properties: {
        itemId: { type: "string", description: "The item id from list_routine" },
        ...ITEM_PROPERTIES,
        date: { type: "string", description: "New date in YYYY-MM-DD format" },
        deadline: { type: "string", description: "New deadline in YYYY-MM-DD format" },
        completed: { type: "boolean", description: "true to mark the item done" },
      },
      required: ["itemId"],
    },
  },
};

export const askRoutineSetupTool: OpenAI.Chat.ChatCompletionFunctionTool = {
  type: "function",
  function: {
    name: "ask_routine_setup",
    description:
      "Ask the student the four things a study routine needs — which course, how soon they want to finish, which days they can study, and what time of day — as interactive cards, one at a time. The questions are built by the server from the student's real courses, so you do NOT need to list their courses first and you must NOT ask any of this in plain text. Call this FIRST whenever the student wants a routine / study plan / timetable built from courses they already have, unless their messages already state the course, the finish-by window and the study time. After calling it, stop and wait for their answers.",
    parameters: {
      type: "object",
      properties: {
        courseTitle: {
          type: "string",
          description:
            "The exact course title if the student already named ONE course to schedule — the course question is then skipped.",
        },
      },
    },
  },
};

/**
 * Headers of the server-built setup questions. They double as the labels in the
 * compiled answer message the cards send back ("Study time: Evening (06:00 PM)"),
 * which is how ../../chat-agent/router.ts recognises that message.
 */
export const ROUTINE_SETUP_HEADERS = {
  course: "Course",
  deadline: "Finish by",
  days: "Study days",
  time: "Study time",
} as const;

/** Course options are single-select cards; more than this and the list stops being scannable. */
export const ROUTINE_SETUP_MAX_COURSE_OPTIONS = 6;

/**
 * The setup questions, built from the student's own courses. Server-owned (like
 * the knowledge check) rather than model-written, so the four fields the
 * scheduler needs always come back in a fixed shape whatever the model does.
 *
 * `chosenTitle` — already-decided course (the student named one, or owns only
 * one); its question is dropped so they aren't asked what they just said.
 */
export function buildRoutineSetupQuestions(
  courseTitles: string[],
  chosenTitle?: string,
): AskQuestion[] {
  const questions: AskQuestion[] = [];

  if (!chosenTitle && courseTitles.length > 1) {
    questions.push({
      question: "Which course do you want to schedule?",
      header: ROUTINE_SETUP_HEADERS.course,
      options: courseTitles.slice(0, ROUTINE_SETUP_MAX_COURSE_OPTIONS),
      multiSelect: true,
    });
  }

  questions.push(...routineTimingQuestions());
  return questions;
}

/**
 * When to study — the part that is asked whether or not a course exists yet.
 * The guided intake (services/intake.service.ts) asks these before any course
 * has been created, and `ask_routine_setup` asks them alongside the course
 * question; both must produce identical headers, because the compiled answer
 * message is matched on them (see chat-agent/router.ts isRoutineSetupAnswer).
 */
export function routineTimingQuestions(): AskQuestion[] {
  return [
    {
      question: "How soon do you want to finish it?",
      header: ROUTINE_SETUP_HEADERS.deadline,
      options: ["Within 1 week", "Within 2 weeks", "Within 1 month", "No rush — 2 months"],
    },
    {
      question: "Which days can you study?",
      header: ROUTINE_SETUP_HEADERS.days,
      options: ["Every day", "Weekdays only", "Weekends only", "3 days a week"],
    },
    {
      question: "What time of day should I schedule your study block?",
      header: ROUTINE_SETUP_HEADERS.time,
      options: [
        "Morning (08:00 AM)",
        "Afternoon (02:00 PM)",
        "Evening (06:00 PM)",
        "Night (09:00 PM)",
      ],
    },
  ];
}

/** Tool message after the setup cards are shown — the turn ends here. */
export const ROUTINE_SETUP_SHOWN =
  "Routine setup questions are shown to the student as interactive cards, one at a time. Do NOT " +
  "restate them as text, do NOT ask anything else, and do NOT build or save a schedule in this turn " +
  "— wait for the answers. When they arrive, work out a date for every lesson from the finish-by " +
  'window and the study days they chose, then save the whole plan with ONE create_routine_items ' +
  'call, titling each item "<Course> - Lesson N" at the time they chose.';

/** Tool message when there is nothing to schedule yet. */
export const ROUTINE_SETUP_NO_COURSES =
  "The student has no courses yet, so there is nothing to schedule. Tell them that and offer to " +
  "build a course first, or to add individual routine items they name themselves. Never invent " +
  "course names for a plan.";

export const deleteRoutineItemTool: OpenAI.Chat.ChatCompletionFunctionTool = {
  type: "function",
  function: {
    name: "delete_routine_item",
    description:
      "Permanently delete ONE item from the student's routine. Only call this after the student has explicitly confirmed the deletion in their most recent message. To remove several items — or to clear the routine — use delete_routine_items instead; repeating this tool is capped and will be refused.",
    parameters: {
      type: "object",
      properties: {
        itemId: { type: "string", description: "The item id from list_routine" },
      },
      required: ["itemId"],
    },
  },
};

/**
 * The bulk counterpart. Without it there was no way to honour "clear my
 * routine": the single-item tool had to be called once per item, and the chat
 * agent's destructive-call cap refuses a run like that — correctly, since it
 * cannot tell a deliberate clear-out from a runaway loop. One call for one
 * intent is what makes the difference legible.
 */
export const deleteRoutineItemsTool: OpenAI.Chat.ChatCompletionFunctionTool = {
  type: "function",
  function: {
    name: "delete_routine_items",
    description:
      `Permanently delete MANY routine items in ONE call — use this whenever the student asks to clear their routine, remove a whole course's schedule, or delete more than one item. Call list_routine first to get the ids, then pass every id to remove here (up to ${MAX_BULK_ITEMS}). ALWAYS prefer this over repeating delete_routine_item, which is capped per turn. Only call it after the student has explicitly confirmed the deletion in their most recent message — say how many items will go, and wait for their answer.`,
    parameters: {
      type: "object",
      properties: {
        itemIds: {
          type: "array",
          description: `The ids to delete, from list_routine (up to ${MAX_BULK_ITEMS})`,
          items: { type: "string" },
        },
      },
      required: ["itemIds"],
    },
  },
};
