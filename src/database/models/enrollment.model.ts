import { Schema, model, Types, type InferSchemaType } from "mongoose";

/** One row per user per course. Lessons completed are tracked as an id array. */
const enrollmentSchema = new Schema(
  {
    userId: { type: Types.ObjectId, ref: "User", required: true, index: true },
    courseId: { type: String, required: true },
    completedLessonIds: { type: [String], default: [] },
    enrolledAt: { type: Date, default: Date.now },
    lastAccessedAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

enrollmentSchema.index({ userId: 1, courseId: 1 }, { unique: true });

export type Enrollment = InferSchemaType<typeof enrollmentSchema>;
export const EnrollmentModel = model("Enrollment", enrollmentSchema);
