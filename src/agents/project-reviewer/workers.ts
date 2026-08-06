import { formatZodIssues, runReviewToolCall, type LlmDeps } from "./call.js";
import type { SourceFile } from "./filter.js";
import {
  buildFileWorkerSystemPrompt,
  buildFileWorkerUserMessage,
  buildRequirementCheckerSystemPrompt,
  buildRequirementCheckerUserMessage,
  lineCountOf,
  type ReviewContext,
} from "./prompt.js";
import {
  emitFileReviewTool,
  emitRequirementReportTool,
  fileReviewSchemaFor,
  requirementReportSchemaFor,
  type RequirementResult,
  type ReviewIssue,
} from "./schema.js";

/**
 * One call per file. Returns null when the model cannot produce a valid review
 * — one unreviewable file must not sink a whole submission, so the caller ships
 * that file with no issues (the lecture-maker's svg workers degrade the same way).
 */
export async function runFileWorker(
  ctx: ReviewContext,
  file: SourceFile,
  deps: LlmDeps,
): Promise<ReviewIssue[] | null> {
  const schema = fileReviewSchemaFor(lineCountOf(file.content));
  try {
    const result = await runReviewToolCall({
      deps,
      tool: emitFileReviewTool,
      system: buildFileWorkerSystemPrompt(),
      user: buildFileWorkerUserMessage(ctx, file),
      parse: (raw) => {
        const r = schema.safeParse(raw);
        return r.success
          ? { success: true, data: r.data }
          : { success: false, issues: formatZodIssues(r.error) };
      },
      sizeHint: "Report only the most serious issues, with shorter explanations.",
      label: `Review of ${file.path}`,
    });
    return [...result.issues].sort((a, b) => a.line - b.line);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[project-reviewer] file skipped (${file.path}):`, err);
    return null;
  }
}

/**
 * The single call that judges the checklist. Unlike a file worker this one is
 * allowed to fail the review — a report with no verdict on the requirements is
 * not the feature.
 */
export async function runRequirementChecker(
  ctx: ReviewContext,
  files: SourceFile[],
  allPaths: string[],
  truncated: boolean,
  deps: LlmDeps,
): Promise<{ requirementResults: RequirementResult[]; overallFeedback: string }> {
  const schema = requirementReportSchemaFor(ctx.requirements);
  const result = await runReviewToolCall({
    deps,
    tool: emitRequirementReportTool,
    system: buildRequirementCheckerSystemPrompt(),
    user: buildRequirementCheckerUserMessage(ctx, files, allPaths, truncated),
    parse: (raw) => {
      const r = schema.safeParse(raw);
      return r.success
        ? { success: true, data: r.data }
        : { success: false, issues: formatZodIssues(r.error) };
    },
    sizeHint: "Keep each evidence note and the overall feedback short.",
    label: "Requirement check",
  });

  // The model echoes each requirement back; trust our own list for the text so
  // a paraphrase can never rename what the student was asked to do.
  return {
    requirementResults: result.requirementResults.map((r, i) => ({ ...r, requirement: ctx.requirements[i]! })),
    overallFeedback: result.overallFeedback,
  };
}
