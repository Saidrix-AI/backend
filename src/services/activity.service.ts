import { Types } from "mongoose";
import { ActivityLogModel } from "../database/models/activityLog.model.js";

export async function logActivity(
  userId: string,
  type: string,
  text: string,
  courseId = "",
): Promise<void> {
  await ActivityLogModel.create({
    userId: new Types.ObjectId(userId),
    type,
    text,
    courseId,
  });
}

export async function recentForCourse(userId: string, courseId: string, limit = 8) {
  return ActivityLogModel.find({ userId: new Types.ObjectId(userId), courseId })
    .sort({ at: -1 })
    .limit(limit)
    .lean();
}
