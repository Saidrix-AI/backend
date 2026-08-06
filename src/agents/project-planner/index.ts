import { formatZodIssues, resolveCourseDeps, runForcedToolCall, type LlmDeps } from "../course-maker/call.js";
import { buildProjectPlanSystemPrompt, buildProjectPlanUserMessage, type ProjectPlanContext } from "./prompt.js";
import {
  emitProjectPlanTool,
  MIN_ACCEPTABLE_PROJECTS,
  projectPlanSchema,
  TARGET_PROJECTS,
  type PlannedProject,
  type ProjectTier,
} from "./schema.js";

export type { ProjectPlanContext } from "./prompt.js";
export { PROJECT_TIERS, type ProjectTier } from "./schema.js";

/** A planned project with its position in the course resolved. */
export interface OrderedProject extends Omit<PlannedProject, "chapterNumber"> {
  /** 0-based index into the course's chapters, or -1 when unmapped. */
  chapterIndex: number;
  /** 1-based position in the recommended build order. */
  order: number;
}

const TIER_RANK: Record<ProjectTier, number> = { starter: 0, practice: 1, capstone: 2 };

/**
 * Build order: capstones last, otherwise by the chapter they apply. Keeps the
 * model's relative order within a tie so its own easiest-to-hardest intent survives.
 */
function order(projects: PlannedProject[], chapterCount: number): OrderedProject[] {
  return projects
    .map((p, i) => ({
      p,
      i,
      // The model counts chapters from 1; anything out of range is unmapped.
      chapterIndex: p.chapterNumber >= 1 && p.chapterNumber <= chapterCount ? p.chapterNumber - 1 : -1,
    }))
    .sort((a, b) => {
      const tier = TIER_RANK[a.p.difficulty] - TIER_RANK[b.p.difficulty];
      if (tier !== 0) return tier;
      if (a.chapterIndex !== b.chapterIndex) return a.chapterIndex - b.chapterIndex;
      return a.i - b.i;
    })
    .map(({ p, chapterIndex }, n) => {
      const { chapterNumber: _chapterNumber, ...rest } = p;
      return { ...rest, chapterIndex, order: n + 1 };
    });
}

/**
 * One forced call: curriculum → the course's hands-on projects, mapped to
 * chapters and ordered. Throws on a hard failure; the Course-maker degrades
 * that into "course created, projects missing" rather than losing the course.
 */
export async function planProjects(
  ctx: ProjectPlanContext,
  deps?: LlmDeps,
): Promise<OrderedProject[]> {
  const plan = await runForcedToolCall({
    deps: deps ?? resolveCourseDeps("projects"),
    tool: emitProjectPlanTool,
    system: buildProjectPlanSystemPrompt(),
    user: buildProjectPlanUserMessage(ctx),
    parse: (raw) => {
      const r = projectPlanSchema.safeParse(raw);
      if (!r.success) return { success: false, issues: formatZodIssues(r.error) };
      if (r.data.projects.length < MIN_ACCEPTABLE_PROJECTS) {
        return {
          success: false,
          issues: `only ${r.data.projects.length} projects — emit ${TARGET_PROJECTS.min}-${TARGET_PROJECTS.max}`,
        };
      }
      return { success: true, data: r.data };
    },
    sizeHint: `Keep each desc and goal to one short sentence, but still emit ${TARGET_PROJECTS.min}-${TARGET_PROJECTS.max} projects.`,
  });

  return order(plan.projects.slice(0, TARGET_PROJECTS.max), ctx.chapters.length);
}
