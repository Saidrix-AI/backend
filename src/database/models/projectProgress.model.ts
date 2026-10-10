import { Schema, model, Types, type InferSchemaType } from "mongoose";

const submissionSchema = new Schema(
  {
    method: { type: String, enum: ["github", "file"], required: true },
    value: { type: String, required: true },
    submittedAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

/**
 * One row per user per project.
 *
 * No row used to mean "not started", and that state was never persisted. It
 * still means "not started" — but a row can now exist for a project the student
 * has NOT started, carrying status "unlocked" and nothing else. A submission
 * deadline needs to know WHEN the project became available, and that instant is
 * not recoverable from anything else: it is the moment they finished a
 * particular lesson, which no other record timestamps.
 *
 * Whether a project is locked stays DERIVED (services/projectGate.ts, from the
 * student's completed lessons) — this row records when the clock started, never
 * whether it should have. A missing row on an open project therefore means "no
 * deadline", which is what every project planned before this existed gets.
 */
const projectProgressSchema = new Schema(
  {
    userId: { type: Types.ObjectId, ref: "User", required: true, index: true },
    projectId: { type: String, required: true },
    status: {
      type: String,
      enum: ["unlocked", "in_progress", "completed", "archived"],
      default: "in_progress",
    },
    submissions: { type: [submissionSchema], default: [] },
    startedAt: { type: Date, default: Date.now },
    /**
     * When the unlocking lesson was finished, and when the submission is due
     * (`unlockedAt` + the project's `submitWithinDays`). Null `dueAt` means no
     * deadline — either the project has none, or it opened before this existed.
     */
    unlockedAt: { type: Date, default: null },
    dueAt: { type: Date, default: null },
  },
  { timestamps: true },
);

projectProgressSchema.index({ userId: 1, projectId: 1 }, { unique: true });

export type ProjectProgress = InferSchemaType<typeof projectProgressSchema>;
export const ProjectProgressModel = model("ProjectProgress", projectProgressSchema);
