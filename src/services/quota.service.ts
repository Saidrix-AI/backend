import { Types } from "mongoose";
import { isBillingEnabled } from "../config/env.js";
import { entitlementsFor } from "../config/entitlements.js";
import type { PlanId } from "../config/plans.js";
import { ProjectReviewModel } from "../database/models/projectReview.model.js";
import { UsageEventModel } from "../database/models/usageEvent.model.js";
import { UserModel } from "../database/models/user.model.js";
import { ApiError } from "../utils/apiError.js";
import { currentPeriod } from "./subscription.service.js";

/**
 * The metered limits: how much of an expensive thing a tier may do.
 *
 * Separate from the "how many things may be active at once" rules in
 * activeSelection.service.ts, which are about commitment rather than cost.
 * These two are about cost: generating a course is 10-20+ LLM calls, and a
 * project review is one call per file. Uncapped, either one lets a single
 * account spend more than its subscription is worth.
 *
 * Every check no-ops when billing is disabled, so a deployment without
 * LemonSqueezy keys (local development, CI) behaves as it did before.
 */

async function planOf(userId: string): Promise<PlanId | null> {
  const user = await UserModel.findById(userId).select("plan").lean();
  return (user?.plan ?? null) as PlanId | null;
}

export interface CourseUsage {
  used: number;
  limit: number;
  remaining: number;
  /** When the allowance refills. */
  resetsAt: string;
}

/** What the billing page shows: "2 of 8 courses generated this period". */
export async function courseUsage(userId: string): Promise<CourseUsage> {
  const [plan, period] = await Promise.all([planOf(userId), currentPeriod(userId)]);
  const limit = entitlementsFor(plan).coursesPerMonth;
  const used = await UsageEventModel.countDocuments({
    userId: new Types.ObjectId(userId),
    kind: "course_generated",
    createdAt: { $gte: period.start },
  });
  return {
    used,
    limit,
    remaining: Math.max(0, limit - used),
    resetsAt: period.end.toISOString(),
  };
}

function formatDay(date: Date): string {
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "long", timeZone: "UTC" });
}

/**
 * Refuses a course generation that would exceed the monthly allowance.
 *
 * Called before the first LLM call, not after: the whole point is to not spend
 * the tokens. The message names the limit and the reset date because it is
 * surfaced to the student verbatim by the chat agent, which reports a failed
 * tool call in its own words otherwise.
 */
export async function assertCanGenerateCourse(userId: string): Promise<void> {
  if (!isBillingEnabled()) return;
  const usage = await courseUsage(userId);
  if (usage.remaining > 0) return;
  throw new ApiError(
    403,
    `You have used all ${usage.limit} course generations on your plan this month. ` +
      `Your allowance refills on ${formatDay(new Date(usage.resetsAt))} — ` +
      `upgrade from Account » Plans for more.`,
  );
}

/** Records a generation. Append-only: nothing ever deletes from this ledger. */
export async function recordCourseGenerated(userId: string, courseId: string): Promise<void> {
  await UsageEventModel.create({
    userId: new Types.ObjectId(userId),
    kind: "course_generated",
    ref: courseId,
  });
}

export interface ReviewUsage {
  used: number;
  limit: number;
  remaining: number;
}

/**
 * Review submissions already spent on one project.
 *
 * Counted per project for the project's lifetime, not per month — the plans
 * advertise "N free submissions per project", and a monthly reset would make
 * the number meaningless.
 */
export async function reviewUsage(userId: string, projectId: string): Promise<ReviewUsage> {
  const plan = await planOf(userId);
  const limit = entitlementsFor(plan).reviewsPerProject;
  const used = await ProjectReviewModel.countDocuments({
    userId: new Types.ObjectId(userId),
    projectId,
  });
  return { used, limit, remaining: Math.max(0, limit - used) };
}

export async function assertCanReview(userId: string, projectId: string): Promise<void> {
  if (!isBillingEnabled()) return;
  const usage = await reviewUsage(userId, projectId);
  if (usage.remaining > 0) return;
  throw new ApiError(
    403,
    `You have used all ${usage.limit} review submissions for this project on your plan. ` +
      `Upgrade from Account » Plans to submit more.`,
  );
}
