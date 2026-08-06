import { formatZodIssues, resolveLectureDeps, runForcedToolCall, type LlmDeps } from "./call.js";
import {
  buildPlannerSystemPrompt,
  buildPlannerUserMessage,
  buildSetupPlannerSystemPrompt,
  buildSetupPlannerUserMessage,
  type LessonContext,
} from "./prompt.js";
import {
  emitLecturePlanTool,
  emitSetupLecturePlanTool,
  lecturePlanSchema,
  setupLecturePlanSchema,
  type LecturePlan,
  type LessonBlueprint,
  type SetupBlueprint,
  type SetupLecturePlan,
} from "./schema.js";

/**
 * One planner call: the analyst's blueprint → lecture title + outline + block
 * briefs. The planner no longer reads the raw curriculum brief or the RAG
 * grounding — both are digested into the blueprint by analyze.ts, so this call
 * only has to shape one authoritative reading into the teaching arc.
 */
export async function buildLecturePlan(
  ctx: LessonContext,
  blueprint: LessonBlueprint,
  deps?: LlmDeps,
): Promise<LecturePlan> {
  return runForcedToolCall({
    deps: deps ?? resolveLectureDeps("planner"),
    tool: emitLecturePlanTool,
    system: buildPlannerSystemPrompt(),
    user: buildPlannerUserMessage(ctx, blueprint),
    parse: (raw) => {
      const r = lecturePlanSchema.safeParse(raw);
      if (r.success) return { success: true, data: r.data };
      // A planner that exhausts its attempts sinks the lecture with a bare 502
      // naming no cause; the plan carries several structural rules now, so log
      // which one it missed.
      const issues = formatZodIssues(r.error);
      console.warn(`[lecture-maker] plan rejected: ${issues}`);
      return { success: false, issues };
    },
    // Shorten the briefs, not the teaching — the briefs are one line each and
    // the content itself is written by separate per-topic calls, so dropping
    // blocks here would lose material for no token saving worth having.
    sizeHint: "Keep every outline topic and block, but cut each brief to a few words.",
  });
}

/**
 * The setup lane's planner. Its schema carries four rules the prompt alone will
 * not hold on a cheap model — one downloads block in the first half, one
 * closing checklist, at least one troubleshooting table, and no quiz — so each
 * is a parse failure the repair round fixes, exactly as the concept lane does
 * with its single-quiz rule.
 */
export async function buildSetupPlan(
  ctx: LessonContext,
  blueprint: SetupBlueprint,
  deps?: LlmDeps,
): Promise<SetupLecturePlan> {
  return runForcedToolCall({
    deps: deps ?? resolveLectureDeps("planner"),
    tool: emitSetupLecturePlanTool,
    system: buildSetupPlannerSystemPrompt(),
    user: buildSetupPlannerUserMessage(ctx, blueprint),
    parse: (raw) => {
      const r = setupLecturePlanSchema.safeParse(raw);
      if (r.success) return { success: true, data: r.data };
      const issues = formatZodIssues(r.error);
      console.warn(`[lecture-maker] setup plan rejected: ${issues}`);
      return { success: false, issues };
    },
    sizeHint: "Keep every outline topic and block, but cut each brief to a few words.",
  });
}
