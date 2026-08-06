import { Schema, model, Types, type InferSchemaType } from "mongoose";

/** A lightweight per-user event feed. Filtered by courseId for a course page. */
const activityLogSchema = new Schema({
  userId: { type: Types.ObjectId, ref: "User", required: true, index: true },
  courseId: { type: String, default: "", index: true },
  type: { type: String, required: true }, // enroll | lesson | quiz | project | achievement
  text: { type: String, required: true },
  at: { type: Date, default: Date.now },
});

export type ActivityLog = InferSchemaType<typeof activityLogSchema>;
export const ActivityLogModel = model("ActivityLog", activityLogSchema);
