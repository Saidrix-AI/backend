import { Types } from "mongoose";
import { ingestSubmission, reviewProject, type ReviewContext } from "../agents/project-reviewer/index.js";
import { ProjectModel } from "../database/models/project.model.js";
import { ProjectProgressModel } from "../database/models/projectProgress.model.js";
import { ProjectReviewModel } from "../database/models/projectReview.model.js";
import { ApiError } from "../utils/apiError.js";
import { logActivity } from "./activity.service.js";
import { evaluateAchievements } from "./progress.service.js";
import { submitProject } from "./projectProgress.service.js";
import { assertCanReview } from "./quota.service.js";

function oid(userId: string): Types.ObjectId {
  return new Types.ObjectId(userId);
}

/**
 * Records the submission, opens a "running" review and starts the pipeline
 * WITHOUT awaiting it — reviewing 100 files takes minutes, far past any
 * request's life. The client polls getReview until it settles.
 */
export async function startReview(
  userId: string,
  projectId: string,
  method: "github" | "file",
  sourceRef: string,
  zipBuffer?: Buffer,
): Promise<{ reviewId: string; attempt: number }> {
  if (!Types.ObjectId.isValid(projectId)) throw new ApiError(400, "Invalid project id");
  const project = await ProjectModel.findOne({ _id: projectId, userId: oid(userId) }).lean();
  if (!project) throw new ApiError(404, "Project not found");

  // The plan's submission allowance for THIS project (2/5/8, for the project's
  // lifetime). Checked before the submission is recorded and before the
  // reviewer starts, because a review is one LLM call per file in the repo.
  await assertCanReview(userId, projectId);

  await submitProject(userId, projectId, method, sourceRef);

  const progress = await ProjectProgressModel.findOne({ userId: oid(userId), projectId }).lean();
  const attempt = progress?.submissions?.length ?? 1;

  const review = await ProjectReviewModel.create({
    userId: oid(userId),
    projectId,
    attempt,
    method,
    sourceRef,
    status: "running",
  });

  const ctx: ReviewContext = {
    title: project.title,
    desc: project.desc ?? "",
    goal: project.goal ?? "",
    requirements: project.requirements ?? [],
  };
  void runReviewJob(String(review._id), userId, projectId, ctx, method, sourceRef, zipBuffer);

  return { reviewId: String(review._id), attempt };
}

/** The detached job. It owns the review row's fate: every path writes an end state. */
async function runReviewJob(
  reviewId: string,
  userId: string,
  projectId: string,
  ctx: ReviewContext,
  method: "github" | "file",
  sourceRef: string,
  zipBuffer?: Buffer,
): Promise<void> {
  try {
    const ingested = await ingestSubmission(method, sourceRef, zipBuffer);
    const result = await reviewProject(ctx, ingested);

    await ProjectReviewModel.updateOne(
      { _id: reviewId },
      {
        $set: {
          status: "completed",
          qualityScore: result.qualityScore,
          requirementResults: result.requirementResults,
          fileTree: result.fileTree,
          files: result.files,
          overallFeedback: result.overallFeedback,
          truncated: result.truncated,
        },
      },
    );

    await evaluateAchievements(userId);
    await logActivity(userId, "project", `Review completed for ${ctx.title}`, "");
  } catch (err) {
    const message =
      err instanceof ApiError ? err.message : "Something went wrong while reviewing this submission.";
    // eslint-disable-next-line no-console
    console.warn(`[project-reviewer] review ${reviewId} failed (project ${projectId}):`, err);
    await ProjectReviewModel.updateOne(
      { _id: reviewId },
      { $set: { status: "failed", errorMessage: message } },
    ).catch(() => {
      // Nothing left to do — the row stays "running" and the client's poll times out.
    });
  }
}

export async function getReview(userId: string, reviewId: string) {
  if (!Types.ObjectId.isValid(reviewId)) throw new ApiError(400, "Invalid review id");
  const review = await ProjectReviewModel.findOne({ _id: reviewId, userId: oid(userId) }).lean();
  if (!review) throw new ApiError(404, "Review not found");
  return review;
}

/** The attempt's review, for deep links like /projects/:id/review/2. */
export async function getReviewByAttempt(userId: string, projectId: string, attempt: number) {
  const review = await ProjectReviewModel.findOne({ userId: oid(userId), projectId, attempt }).lean();
  if (!review) throw new ApiError(404, "Review not found");
  return review;
}

/**
 * Every attempt's review, newest first — without the file bodies, which are far
 * too large for a list the history table only shows a status in.
 */
export async function listReviews(userId: string, projectId: string) {
  return ProjectReviewModel.find({ userId: oid(userId), projectId })
    .select("-files -fileTree -requirementResults")
    .sort({ attempt: -1 })
    .lean();
}
