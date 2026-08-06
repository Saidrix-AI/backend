import { resolveReviewDeps, type LlmDeps } from "./call.js";
import type { SourceFile } from "./filter.js";
import { ingestFromGithub, type IngestedProject } from "./github.js";
import type { ReviewContext } from "./prompt.js";
import { countBySeverity, computeQualityScore } from "./score.js";
import type { RequirementResult, ReviewIssue } from "./schema.js";
import { applyBadges, buildFileTree, type TreeNode } from "./tree.js";
import { ingestFromZip } from "./zip.js";
import { runFileWorker, runRequirementChecker } from "./workers.js";

export type { ReviewContext } from "./prompt.js";
export type { IngestedProject } from "./github.js";
export { ingestFromGithub } from "./github.js";
export { ingestFromZip } from "./zip.js";

/** Deps-injection seam — tests pass fake clients here. */
export interface ReviewDeps {
  fileWorker?: LlmDeps;
  requirementChecker?: LlmDeps;
}

export interface ReviewedFile {
  path: string;
  language: string;
  content: string;
  errors: number;
  warnings: number;
  suggestions: number;
  issues: ReviewIssue[];
}

export interface ProjectReviewResult {
  qualityScore: number;
  requirementResults: RequirementResult[];
  fileTree: TreeNode[];
  files: ReviewedFile[];
  overallFeedback: string;
  truncated: boolean;
}

/** Files reviewed at once. Enough to be quick, few enough to stay under rate limits. */
const FILE_CONCURRENCY = 5;

/**
 * The whole pipeline: ingested source → one worker call per file (in parallel,
 * bounded) + one requirement-checker call → deterministic assembly here. There
 * is no organizer LLM: counts, the file tree and the score are plain code, so
 * the same submission always reports the same numbers.
 */
export async function reviewProject(
  ctx: ReviewContext,
  project: IngestedProject,
  deps?: ReviewDeps,
): Promise<ProjectReviewResult> {
  const fileDeps = deps?.fileWorker ?? resolveReviewDeps();
  const checkerDeps = deps?.requirementChecker ?? resolveReviewDeps();

  const [issuesByPath, report] = await Promise.all([
    reviewFiles(ctx, project.files, fileDeps),
    runRequirementChecker(ctx, project.files, project.paths, project.truncated, checkerDeps),
  ]);

  const files: ReviewedFile[] = project.files.map((file) => {
    const issues = issuesByPath.get(file.path) ?? [];
    const counts = countBySeverity(issues.map((i) => i.severity));
    return { ...file, ...counts, issues };
  });

  const totals = countBySeverity(files.flatMap((f) => f.issues.map((i) => i.severity)));
  const met = report.requirementResults.filter((r) => r.met).length;

  const tree = applyBadges(
    buildFileTree(project.paths),
    new Map(files.filter((f) => f.issues.length).map((f) => [f.path, f.issues.length])),
  );

  return {
    qualityScore: computeQualityScore(totals, met, report.requirementResults.length),
    requirementResults: report.requirementResults,
    fileTree: tree,
    files,
    overallFeedback: report.overallFeedback,
    truncated: project.truncated,
  };
}

/** Bounded-concurrency map over the files; a failed worker yields no issues. */
async function reviewFiles(
  ctx: ReviewContext,
  files: SourceFile[],
  deps: LlmDeps,
): Promise<Map<string, ReviewIssue[]>> {
  const found = new Map<string, ReviewIssue[]>();
  const queue = [...files];

  const workers = Array.from({ length: Math.min(FILE_CONCURRENCY, queue.length) }, async () => {
    for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
      const issues = await runFileWorker(ctx, file, deps);
      found.set(file.path, issues ?? []);
    }
  });
  await Promise.all(workers);

  return found;
}

/** Fetches a submission's source from wherever the student put it. */
export async function ingestSubmission(
  method: "github" | "file",
  sourceRef: string,
  zipBuffer?: Buffer,
): Promise<IngestedProject> {
  if (method === "github") return ingestFromGithub(sourceRef);
  if (!zipBuffer) throw new Error("A file submission needs an uploaded archive");
  return ingestFromZip(zipBuffer, sourceRef.replace(/\.zip$/i, "") || "project");
}
