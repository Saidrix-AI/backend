import { z } from "zod";
import * as courseService from "../../services/course.service.js";
import * as routineService from "../../services/routine.service.js";
import {
  askRoutineSetupTool,
  buildRoutineSetupQuestions,
  createRoutineItemsTool,
  createRoutineItemTool,
  deleteRoutineItemTool,
  listRoutineTool,
  MAX_BULK_ITEMS,
  ROUTINE_SETUP_MAX_COURSE_OPTIONS,
  ROUTINE_SETUP_NO_COURSES,
  ROUTINE_SETUP_SHOWN,
  ROUTINE_TYPES as TYPES,
  updateRoutineItemTool,
} from "./prompts/routine.js";
import { invalidArgs, failure, type RegisteredTool } from "./types.js";

const dateString = z
  .string()
  .refine((s) => !Number.isNaN(Date.parse(s)), { message: "Use YYYY-MM-DD format" });

const createArgs = z.object({
  type: z.enum(TYPES),
  title: z.string().min(1).max(120),
  date: dateString,
  time: z.string().max(20).optional(),
  durationMin: z.number().int().positive().max(1440).optional(),
  subtitle: z.string().max(200).optional(),
  tag: z.string().max(40).optional(),
  deadline: dateString.optional(),
});

const updateArgs = z
  .object({
    itemId: z.string().min(1),
    type: z.enum(TYPES).optional(),
    title: z.string().min(1).max(120).optional(),
    date: dateString.optional(),
    time: z.string().max(20).optional(),
    durationMin: z.number().int().positive().max(1440).optional(),
    subtitle: z.string().max(200).optional(),
    tag: z.string().max(40).optional(),
    deadline: dateString.optional(),
    completed: z.boolean().optional(),
  })
  .refine((a) => Object.keys(a).some((k) => k !== "itemId" && a[k as keyof typeof a] !== undefined), {
    message: "Provide at least one field to change",
  });

const deleteArgs = z.object({ itemId: z.string().min(1) });

function itemLine(i: {
  _id: unknown;
  type: string;
  title: string;
  date: Date;
  time?: string | null;
  completed?: boolean | null;
}): string {
  const date = i.date.toISOString().slice(0, 10);
  const time = i.time ? ` ${i.time}` : "";
  const done = i.completed ? ", completed" : "";
  return `- [${i.type}] "${i.title}" on ${date}${time} (id: ${String(i._id)}${done})`;
}

const listRoutine: RegisteredTool = {
  schema: listRoutineTool,
  runningLabel: () => "Looking up routine",
  run: async (ctx) => {
    try {
      const items = await routineService.listRoutineItems(ctx.userId);
      const lines = items.slice(0, 60).map((i) => itemLine(i));
      return {
        ok: true,
        label: "Routine loaded",
        modelText: lines.length ? lines.join("\n") : "The routine is empty.",
      };
    } catch (err) {
      return failure("Couldn't load routine", err);
    }
  },
};

const createRoutineItem: RegisteredTool = {
  schema: createRoutineItemTool,
  runningLabel: (a) => `Adding "${String(a.title ?? "…")}" to routine`,
  run: async (ctx, args) => {
    const parsed = createArgs.safeParse(args);
    if (!parsed.success) return invalidArgs("Couldn't add routine item", parsed.error);
    try {
      const item = await routineService.createRoutineItem(ctx.userId, parsed.data);
      const date = item.date.toISOString().slice(0, 10);
      return {
        ok: true,
        changed: "routine",
        label: `"${item.title}" added to routine`,
        modelText: `Added ${item.type} "${item.title}" on ${date}${item.time ? ` at ${item.time}` : ""} (id: ${String(item._id)}).`,
      };
    } catch (err) {
      return failure("Couldn't add routine item", err);
    }
  },
};

const bulkArgs = z.object({
  items: z.array(createArgs).min(1).max(MAX_BULK_ITEMS),
});

/** Yesterday, as YYYY-MM-DD — one day of slack for timezone drift. */
function earliestAllowedDate(): { limit: Date; today: string } {
  const now = new Date();
  const limit = new Date(now);
  limit.setUTCDate(limit.getUTCDate() - 1);
  limit.setUTCHours(0, 0, 0, 0);
  return { limit, today: now.toISOString().slice(0, 10) };
}

const createRoutineItems: RegisteredTool = {
  schema: createRoutineItemsTool,
  runningLabel: (a) => {
    const n = Array.isArray(a.items) ? a.items.length : 0;
    return `Adding ${n} item${n === 1 ? "" : "s"} to routine`;
  },
  run: async (ctx, args) => {
    const parsed = bulkArgs.safeParse(args);
    if (!parsed.success) return invalidArgs("Couldn't add routine items", parsed.error);

    // Models date study plans from whatever "now" they believe in — gpt-4o-mini
    // scheduled a 2026 plan across 2023 — and a plan in the past never appears
    // on the student's routine. The server knows today; make it retry rather
    // than silently saving a useless schedule. (Single items are exempt: a
    // student may legitimately log something that already happened.)
    const { limit, today } = earliestAllowedDate();
    const stale = parsed.data.items
      .map((i) => new Date(i.date))
      .filter((d) => d.getTime() < limit.getTime())
      .sort((a, b) => a.getTime() - b.getTime())[0];
    if (stale) {
      return {
        ok: false,
        label: "Couldn't add routine items",
        modelText:
          `Those dates are in the past — the earliest was ${stale.toISOString().slice(0, 10)}. ` +
          `TODAY IS ${today}. A study plan must start today or later. Call create_routine_items ` +
          `again with the same items, re-dated from ${today} onward (keep the same day-to-day spacing).`,
      };
    }

    try {
      const items = await routineService.createRoutineItems(ctx.userId, parsed.data.items);
      const dates = items.map((i) => i.date.toISOString().slice(0, 10)).sort();
      const span = dates.length ? ` (${dates[0]} → ${dates[dates.length - 1]})` : "";
      return {
        ok: true,
        changed: "routine",
        label: `${items.length} item${items.length === 1 ? "" : "s"} added to routine`,
        modelText: `Added ${items.length} routine item${items.length === 1 ? "" : "s"}${span}.`,
      };
    } catch (err) {
      return failure("Couldn't add routine items", err);
    }
  },
};

const updateRoutineItem: RegisteredTool = {
  schema: updateRoutineItemTool,
  runningLabel: () => "Updating routine item",
  run: async (ctx, args) => {
    const parsed = updateArgs.safeParse(args);
    if (!parsed.success) return invalidArgs("Couldn't update routine item", parsed.error);
    try {
      const { itemId, ...patch } = parsed.data;
      const item = await routineService.updateRoutineItem(ctx.userId, itemId, patch);
      const date = item.date.toISOString().slice(0, 10);
      return {
        ok: true,
        changed: "routine",
        label: `"${item.title}" updated`,
        modelText: `Updated ${item.type} "${item.title}" — now on ${date}${item.time ? ` at ${item.time}` : ""}${item.completed ? ", completed" : ""}.`,
      };
    } catch (err) {
      return failure("Couldn't update routine item", err);
    }
  },
};

const deleteRoutineItem: RegisteredTool = {
  schema: deleteRoutineItemTool,
  runningLabel: () => "Deleting routine item",
  run: async (ctx, args) => {
    const parsed = deleteArgs.safeParse(args);
    if (!parsed.success) return invalidArgs("Couldn't delete routine item", parsed.error);
    try {
      const items = await routineService.listRoutineItems(ctx.userId);
      const target = items.find((i) => String(i._id) === parsed.data.itemId);
      await routineService.deleteRoutineItem(ctx.userId, parsed.data.itemId);
      return {
        ok: true,
        changed: "routine",
        label: target ? `"${target.title}" removed from routine` : "Routine item deleted",
        modelText: target
          ? `Deleted ${target.type} "${target.title}" from the routine.`
          : "Deleted the routine item.",
      };
    } catch (err) {
      return failure("Couldn't delete routine item", err);
    }
  },
};

const setupArgs = z.object({ courseTitle: z.string().max(120).optional() });

/**
 * Interviews the student before a study plan is written. The cards are built
 * here from their real courses instead of by the model, so the scheduler always
 * gets course + finish-by + days + time back in a fixed shape. The chat turn
 * ends with the cards; the answers arrive as the next user message.
 */
const askRoutineSetup: RegisteredTool = {
  schema: askRoutineSetupTool,
  runningLabel: () => "Setting up your routine",
  run: async (ctx, args) => {
    const parsed = setupArgs.safeParse(args);
    const hint = parsed.success ? parsed.data.courseTitle?.trim() : undefined;
    try {
      const courses = await courseService.listCourses(ctx.userId);
      if (courses.length === 0) {
        return { ok: true, label: "No courses to schedule", modelText: ROUTINE_SETUP_NO_COURSES };
      }

      const titles = courses.map((c) => c.title);
      // A named course (or the only course they own) is already decided — don't
      // ask them what they just told us.
      const chosen =
        titles.length === 1
          ? titles[0]
          : hint
            ? titles.find((t) => t.toLowerCase() === hint.toLowerCase())
            : undefined;
      const questions = buildRoutineSetupQuestions(titles, chosen);

      const inventory = courses
        .slice(0, ROUTINE_SETUP_MAX_COURSE_OPTIONS)
        .map((c) => `- "${c.title}" (${c.lessons} lessons)`)
        .join("\n");
      return {
        ok: true,
        label: `Asked ${questions.length} routine question${questions.length === 1 ? "" : "s"}`,
        modelText: `${ROUTINE_SETUP_SHOWN}\n\nThe student's courses:\n${inventory}`,
        questions,
      };
    } catch (err) {
      return failure("Couldn't prepare the routine questions", err);
    }
  },
};

export const routineTools = [
  listRoutine,
  createRoutineItem,
  createRoutineItems,
  updateRoutineItem,
  deleteRoutineItem,
  askRoutineSetup,
];
