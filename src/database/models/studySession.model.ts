import { Schema, model, Types, type InferSchemaType } from "mongoose";

/** Append-only study-time log. `day` (YYYY-MM-DD) buckets the weekly chart. */
const studySessionSchema = new Schema(
  {
    userId: { type: Types.ObjectId, ref: "User", required: true, index: true },
    courseId: { type: String, default: "", index: true },
    seconds: { type: Number, required: true, min: 0 },
    day: { type: String, required: true }, // YYYY-MM-DD (user-local not needed for MVP)
  },
  { timestamps: true },
);

studySessionSchema.index({ userId: 1, day: 1 });

export type StudySession = InferSchemaType<typeof studySessionSchema>;
export const StudySessionModel = model("StudySession", studySessionSchema);
