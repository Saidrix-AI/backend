import { Types } from "mongoose";
import { ProjectProgressModel } from "../database/models/projectProgress.model.js";
import { ProjectModel } from "../database/models/project.model.js";
import { evaluateAchievements } from "./progress.service.js";
import { logActivity } from "./activity.service.js";
import { lockForProject } from "./projectGate.js";
import { ApiError } from "../utils/apiError.js";

function oid(userId: string): Types.ObjectId {
  return new Types.ObjectId(userId);
}

/**
 * The student's own project, or null when the id resolves to nothing.
 *
 * Null is not an error here: progress rows are keyed by a plain string and
 * predate per-user project documents, so an id with no document behind it must
 * keep working exactly as before. A project that cannot be found also cannot be
 * gated — the gate only ever applies to projects we can actually read.
 */
async function ownedProject(userId: string, projectId: string) {
  if (!Types.ObjectId.isValid(projectId)) return null;
  return ProjectModel.findOne({ _id: projectId, userId: oid(userId) }).lean();
}

/**
 * Marks a project as started. No-op (idempotent) if a row already exists, and
 * also a no-op while the project is still locked — the detail page is reachable
 * for a locked project (so the student can see what unlocks it), and opening it
 * must not silently move the project into "In Progress".
 */
export async function startProject(userId: string, projectId: string): Promise<void> {
  const project = await ownedProject(userId, projectId);
  if (project && (await lockForProject(userId, project)).locked) return;

  await ProjectProgressModel.updateOne(
    { userId: oid(userId), projectId },
    { $setOnInsert: { startedAt: new Date(), status: "in_progress" } },
    { upsert: true },
  );
}

/**
 * Records a submission and marks the project completed. MVP rule: submitting
 * IS completing — there is no review/grading step in this pass.
 */
export async function submitProject(
  userId: string,
  projectId: string,
  method: "github" | "file",
  value: string,
): Promise<void> {
  // The single chokepoint for "the student did the project": the review flow
  // routes its submission through here too, so gating once covers both. The UI
  // lock must never be the only thing stopping a locked submission.
  const proj = await ownedProject(userId, projectId);
  if (proj) {
    const lock = await lockForProject(userId, proj);
    if (lock.locked) throw new ApiError(403, lock.lockReason);
  }

  await ProjectProgressModel.updateOne(
    { userId: oid(userId), projectId },
    {
      $push: { submissions: { method, value, submittedAt: new Date() } },
      $set: { status: "completed" },
      $setOnInsert: { startedAt: new Date() },
    },
    { upsert: true },
  );
  await evaluateAchievements(userId);
  await logActivity(userId, "project", `Submitted ${proj?.title ?? "a project"}`, proj?.courseId ?? "");
}

/** Archives a project (upserts a row so a not-started project can be archived). */
export async function archiveProject(userId: string, projectId: string): Promise<void> {
  await ProjectProgressModel.updateOne(
    { userId: oid(userId), projectId },
    { $set: { status: "archived" }, $setOnInsert: { startedAt: new Date() } },
    { upsert: true },
  );
}

/**
 * Restores an archived project — back to "completed" if it was ever submitted,
 * otherwise "in_progress". Submissions are the source of truth for prior
 * completion (see submitProject: submitting IS completing), so no separate
 * "status before archiving" field is needed. Returns the restored status.
 */
export async function unarchiveProject(
  userId: string,
  projectId: string,
): Promise<"in_progress" | "completed"> {
  const row = await ProjectProgressModel.findOne({ userId: oid(userId), projectId }).lean();
  const status = row?.submissions?.length ? "completed" : "in_progress";
  await ProjectProgressModel.updateOne({ userId: oid(userId), projectId }, { $set: { status } });
  return status;
}

export async function listMyProjects(userId: string) {
  return ProjectProgressModel.find({ userId: oid(userId) }).lean();
}
