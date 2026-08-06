import { Schema, model, Types, type InferSchemaType } from "mongoose";

/** Awarded achievements. Unique per (userId, key, courseId) — account-level rows use courseId "". */
const achievementSchema = new Schema(
  {
    userId: { type: Types.ObjectId, ref: "User", required: true, index: true },
    key: { type: String, required: true },
    courseId: { type: String, default: "" },
    name: { type: String, required: true },
    desc: { type: String, required: true },
    tone: { type: String, default: "purple" },
    awardedAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

achievementSchema.index({ userId: 1, key: 1, courseId: 1 }, { unique: true });

export type Achievement = InferSchemaType<typeof achievementSchema>;
export const AchievementModel = model("Achievement", achievementSchema);
