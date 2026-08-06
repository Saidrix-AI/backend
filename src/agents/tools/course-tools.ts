import { z } from "zod";
import { getActiveCommitments } from "../../services/activeSelection.service.js";
import * as courseService from "../../services/course.service.js";
import { createLearningPath } from "../../services/learningPath.service.js";
import { LEVELS } from "../../validation/course.schema.js";
import {
  createCourseTool,
  deleteCourseTool,
  listCoursesTool,
  organizeLearningPathTool,
  updateCourseTool,
} from "./prompts/course.js";
import { invalidArgs, failure, type RegisteredTool } from "./types.js";

const createArgs = z.object({
  title: z.string().min(1).max(120),
  desc: z.string().max(500).optional(),
  level: z.enum(LEVELS).optional(),
  lessons: z.number().int().min(0).max(500).optional(),
});

const updateArgs = z
  .object({
    courseId: z.string().min(1),
    title: z.string().min(1).max(120).optional(),
    desc: z.string().max(500).optional(),
    level: z.enum(LEVELS).optional(),
    lessons: z.number().int().min(0).max(500).optional(),
  })
  .refine((a) => a.title !== undefined || a.desc !== undefined || a.level !== undefined || a.lessons !== undefined, {
    message: "Provide at least one field to change (title, desc, level or lessons)",
  });

const deleteArgs = z.object({ courseId: z.string().min(1) });

const organizeArgs = z.object({
  goal: z.string().min(1).max(200),
  courseIds: z.array(z.string().min(1)).min(2).max(6),
});

const listCourses: RegisteredTool = {
  schema: listCoursesTool,
  runningLabel: () => "Looking up courses",
  run: async (ctx) => {
    try {
      const [courses, active] = await Promise.all([
        courseService.listCourses(ctx.userId),
        getActiveCommitments(ctx.userId),
      ]);
      // Flattened once rather than searched per course: with up to three active
      // paths this is scanned fifty times below.
      const currentIds = new Set(
        active.map((c) => c.currentCourseId).filter((id): id is string => Boolean(id)),
      );
      const inPathIds = new Set(
        active.filter((c) => c.kind === "path").flatMap((c) => c.steps.map((s) => s.courseId)),
      );

      const lines = courses.slice(0, 50).map((c) => {
        // Marked inline so a plan built straight off this listing targets the
        // course the student is actually up to — see the scheduling section of
        // chat-agent/prompt.ts. Inside a path that is the current step, which
        // moves on its own as they finish courses.
        const id = String(c._id);
        const tag = currentIds.has(id)
          ? " [ACTIVE COURSE — study this one now]"
          : inPathIds.has(id)
            ? " [in an active path, not yet unlocked]"
            : "";
        return `- "${c.title}" (id: ${id}, level: ${c.level}, lessons: ${c.lessons})${tag}`;
      });

      // Every active path is named: the tutor plans across all of them, and
      // mentioning only one would make it schedule around a path the student
      // is not actually free to study.
      const goals = active
        .filter((c) => c.kind === "path")
        .map((c) => `"${c.goal}"`)
        .join(", ");
      const header = goals
        ? `Active learning path${active.filter((c) => c.kind === "path").length > 1 ? "s" : ""}: ${goals}.\n`
        : "";
      return {
        ok: true,
        label: "Courses loaded",
        modelText: lines.length
          ? header + lines.join("\n")
          : "The student has no courses yet.",
      };
    } catch (err) {
      return failure("Couldn't load courses", err);
    }
  },
};

const createCourse: RegisteredTool = {
  schema: createCourseTool,
  runningLabel: (a) => `Creating course "${String(a.title ?? "…")}"`,
  run: async (ctx, args) => {
    const parsed = createArgs.safeParse(args);
    if (!parsed.success) return invalidArgs("Couldn't create course", parsed.error);
    try {
      const c = await courseService.createCourse(ctx.userId, parsed.data);
      return {
        ok: true,
        changed: "course",
        label: `Course "${c.title}" created`,
        modelText: `Created course "${c.title}" (id: ${String(c._id)}, level: ${c.level}, lessons: ${c.lessons}).`,
      };
    } catch (err) {
      return failure("Couldn't create course", err);
    }
  },
};

const updateCourse: RegisteredTool = {
  schema: updateCourseTool,
  runningLabel: () => "Updating course",
  run: async (ctx, args) => {
    const parsed = updateArgs.safeParse(args);
    if (!parsed.success) return invalidArgs("Couldn't update course", parsed.error);
    try {
      const { courseId, ...patch } = parsed.data;
      const c = await courseService.updateCourse(ctx.userId, courseId, patch);
      return {
        ok: true,
        changed: "course",
        label: `Course "${c.title}" updated`,
        modelText: `Updated course "${c.title}" (level: ${c.level}, lessons: ${c.lessons}, desc: ${c.desc || "—"}).`,
      };
    } catch (err) {
      return failure("Couldn't update course", err);
    }
  },
};

const deleteCourse: RegisteredTool = {
  schema: deleteCourseTool,
  runningLabel: () => "Deleting course",
  run: async (ctx, args) => {
    const parsed = deleteArgs.safeParse(args);
    if (!parsed.success) return invalidArgs("Couldn't delete course", parsed.error);
    try {
      const c = await courseService.getCourse(ctx.userId, parsed.data.courseId);
      await courseService.deleteCourse(ctx.userId, parsed.data.courseId);
      return {
        ok: true,
        changed: "course",
        label: `Course "${c.title}" deleted`,
        modelText: `Deleted course "${c.title}".`,
      };
    } catch (err) {
      return failure("Couldn't delete course", err);
    }
  },
};

const organizeLearningPath: RegisteredTool = {
  schema: organizeLearningPathTool,
  runningLabel: () => "Organizing your learning path",
  run: async (ctx, args) => {
    const parsed = organizeArgs.safeParse(args);
    if (!parsed.success) return invalidArgs("Couldn't organize the path", parsed.error);
    try {
      const all = await courseService.listCourses(ctx.userId);
      const byId = new Map(all.map((c) => [String(c._id), c]));
      const ordered = parsed.data.courseIds
        .map((id) => byId.get(id))
        .filter((c): c is NonNullable<typeof c> => Boolean(c));
      if (ordered.length < 2) {
        return {
          ok: false,
          label: "Couldn't organize the path",
          modelText:
            "I couldn't find at least two of those courses among the student's courses. Call list_courses and use the exact ids.",
        };
      }

      const path = await createLearningPath(
        ctx.userId,
        parsed.data.goal,
        ordered.map((c) => ({
          title: c.title,
          objective: c.desc || c.title,
          level: c.level,
          covers: (c.chapters ?? [])
            .map((ch) => ch.title)
            .slice(0, 12)
            .join(", "),
        })),
      );
      const updated = await courseService.assignCoursesToPath(
        ctx.userId,
        String(path._id),
        parsed.data.goal,
        ordered.map((c) => String(c._id)),
      );

      return {
        ok: true,
        changed: "course",
        label: `Learning path "${parsed.data.goal}" organized (${updated} courses)`,
        modelText:
          `Organized ${updated} courses into the path "${parsed.data.goal}" in this order: ` +
          `${ordered.map((c, i) => `${i + 1}. ${c.title}`).join("; ")}. ` +
          "They now show on the Courses page as a step-by-step roadmap — step 1 is unlocked and each later " +
          "step unlocks when the previous one is completed.",
      };
    } catch (err) {
      return failure("Couldn't organize the path", err);
    }
  },
};

export const courseTools = [listCourses, createCourse, updateCourse, deleteCourse, organizeLearningPath];
