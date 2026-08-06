import { Schema, model, Types, type InferSchemaType } from "mongoose";

/** One row per quiz submission. Score is a percentage 0-100. */
const quizAttemptSchema = new Schema(
  {
    userId: { type: Types.ObjectId, ref: "User", required: true, index: true },
    quizId: { type: String, required: true },
    courseId: { type: String },
    score: { type: Number, required: true, min: 0, max: 100 },

    /**
     * Whether this attempt counts towards the recorded score.
     *
     * Grading returns the answer key, because reviewing what you got wrong is
     * the point of the exam. That also means a second attempt is taken with the
     * answers already in hand — so only the FIRST attempt at a lesson is
     * graded, and every retake is recorded as practice. Without this, "submit
     * garbage, read the key, resubmit" scored 100 on anything.
     *
     * Defaults true so rows written before this existed keep counting.
     */
    graded: { type: Boolean, default: true },
  },
  { timestamps: true },
);

// The "have they sat this one before?" lookup, run on every submission.
quizAttemptSchema.index({ userId: 1, quizId: 1 });

export type QuizAttempt = InferSchemaType<typeof quizAttemptSchema>;
export const QuizAttemptModel = model("QuizAttempt", quizAttemptSchema);
