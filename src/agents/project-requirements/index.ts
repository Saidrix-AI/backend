import { formatZodIssues, resolveReviewDeps, runReviewToolCall, type LlmDeps } from "../project-reviewer/call.js";
import { buildRequirementsSystemPrompt, buildRequirementsUserMessage, type ProjectContext } from "./prompt.js";
import { emitRequirementsTool, projectRequirementsSchema, type ProjectRequirements } from "./schema.js";

export type { ProjectContext } from "./prompt.js";
export type { ProjectRequirements } from "./schema.js";

/** One call: project context → the goal + requirement checklist to review against. */
export async function makeProjectRequirements(
  ctx: ProjectContext,
  deps?: LlmDeps,
): Promise<ProjectRequirements> {
  return runReviewToolCall({
    deps: deps ?? resolveReviewDeps(),
    tool: emitRequirementsTool,
    system: buildRequirementsSystemPrompt(),
    user: buildRequirementsUserMessage(ctx),
    parse: (raw) => {
      const r = projectRequirementsSchema.safeParse(raw);
      return r.success
        ? { success: true, data: r.data }
        : { success: false, issues: formatZodIssues(r.error) };
    },
    sizeHint: "Emit fewer, shorter requirements (4-6, one sentence each).",
    label: "Requirements generation",
  });
}
