import { z } from "zod";
import * as projectService from "../../services/project.service.js";
import {
  createProjectTool,
  deleteProjectTool,
  deleteProjectsTool,
  listProjectsTool,
  updateProjectTool,
} from "./prompts/project.js";
import { invalidArgs, failure, type RegisteredTool } from "./types.js";

const createArgs = z.object({
  title: z.string().min(1).max(120),
  desc: z.string().max(500).optional(),
  tags: z.array(z.string().min(1).max(30)).max(10).optional(),
});

const updateArgs = z
  .object({
    projectId: z.string().min(1),
    title: z.string().min(1).max(120).optional(),
    desc: z.string().max(500).optional(),
    tags: z.array(z.string().min(1).max(30)).max(10).optional(),
  })
  .refine((a) => a.title !== undefined || a.desc !== undefined || a.tags !== undefined, {
    message: "Provide at least one field to change (title, desc or tags)",
  });

const deleteArgs = z.object({ projectId: z.string().min(1) });

const listProjects: RegisteredTool = {
  schema: listProjectsTool,
  runningLabel: () => "Looking up projects",
  run: async (ctx) => {
    try {
      const projects = await projectService.listProjects(ctx.userId);
      const lines = projects
        .slice(0, 50)
        .map(
          (p) =>
            `- "${p.title}" (id: ${String(p._id)}${p.tags?.length ? `, tags: ${p.tags.join(", ")}` : ""})`,
        );
      return {
        ok: true,
        label: "Projects loaded",
        modelText: lines.length ? lines.join("\n") : "The student has no projects yet.",
      };
    } catch (err) {
      return failure("Couldn't load projects", err);
    }
  },
};

const createProject: RegisteredTool = {
  schema: createProjectTool,
  runningLabel: (a) => `Creating project "${String(a.title ?? "…")}"`,
  run: async (ctx, args) => {
    const parsed = createArgs.safeParse(args);
    if (!parsed.success) return invalidArgs("Couldn't create project", parsed.error);
    try {
      const p = await projectService.createProject(ctx.userId, parsed.data);
      return {
        ok: true,
        changed: "project",
        label: `Project "${p.title}" created`,
        modelText: `Created project "${p.title}" (id: ${String(p._id)}${p.tags?.length ? `, tags: ${p.tags.join(", ")}` : ""}).`,
      };
    } catch (err) {
      return failure("Couldn't create project", err);
    }
  },
};

const updateProject: RegisteredTool = {
  schema: updateProjectTool,
  runningLabel: () => "Updating project",
  run: async (ctx, args) => {
    const parsed = updateArgs.safeParse(args);
    if (!parsed.success) return invalidArgs("Couldn't update project", parsed.error);
    try {
      const { projectId, ...patch } = parsed.data;
      const p = await projectService.updateProject(ctx.userId, projectId, patch);
      return {
        ok: true,
        changed: "project",
        label: `Project "${p.title}" updated`,
        modelText: `Updated project "${p.title}" (tags: ${p.tags?.join(", ") || "—"}, desc: ${p.desc || "—"}).`,
      };
    } catch (err) {
      return failure("Couldn't update project", err);
    }
  },
};

const deleteProject: RegisteredTool = {
  schema: deleteProjectTool,
  runningLabel: () => "Deleting project",
  run: async (ctx, args) => {
    const parsed = deleteArgs.safeParse(args);
    if (!parsed.success) return invalidArgs("Couldn't delete project", parsed.error);
    try {
      const p = await projectService.getProject(ctx.userId, parsed.data.projectId);
      await projectService.deleteProject(ctx.userId, parsed.data.projectId);
      return {
        ok: true,
        changed: "project",
        label: `Project "${p.title}" deleted`,
        modelText: `Deleted project "${p.title}".`,
      };
    } catch (err) {
      return failure("Couldn't delete project", err);
    }
  },
};

/** Cap on one bulk call. Matches the routine bulk tools; well past any real library. */
const MAX_BULK_DELETE = 150;

const deleteManyArgs = z.object({
  projectIds: z.array(z.string().min(1)).min(1).max(MAX_BULK_DELETE),
});

const deleteProjects: RegisteredTool = {
  schema: deleteProjectsTool,
  runningLabel: (a) => {
    const n = Array.isArray(a.projectIds) ? a.projectIds.length : 0;
    return `Deleting ${n || "several"} project${n === 1 ? "" : "s"}`;
  },
  run: async (ctx, args) => {
    const parsed = deleteManyArgs.safeParse(args);
    if (!parsed.success) return invalidArgs("Couldn't delete projects", parsed.error);
    try {
      // Counted from what the database removed, not from the id list: ids the
      // student no longer owns are skipped, and reporting the requested number
      // would overstate what happened.
      const removed = await projectService.deleteProjects(ctx.userId, parsed.data.projectIds);
      const asked = parsed.data.projectIds.length;
      return {
        ok: true,
        changed: "project",
        label: removed === 0 ? "Nothing to delete" : `${removed} project${removed === 1 ? "" : "s"} deleted`,
        modelText:
          removed === asked
            ? `Deleted ${removed} project${removed === 1 ? "" : "s"}. Confirm to the student what went.`
            : `Deleted ${removed} of the ${asked} ids given — the rest were already gone. Tell the student what actually went.`,
      };
    } catch (err) {
      return failure("Couldn't delete projects", err);
    }
  },
};

export const projectTools = [
  listProjects,
  createProject,
  updateProject,
  deleteProject,
  deleteProjects,
];
