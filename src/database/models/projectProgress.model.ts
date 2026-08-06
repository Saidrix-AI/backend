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
 * One row per user per project. No row for a (userId, projectId) pair means
 * "not started" — that state is never persisted.
 */
const projectProgressSchema = new Schema(
  {
    userId: { type: Types.ObjectId, ref: "User", required: true, index: true },
    projectId: { type: String, required: true },
    status: {
      type: String,
      enum: ["in_progress", "completed", "archived"],
      default: "in_progress",
    },
    submissions: { type: [submissionSchema], default: [] },
    startedAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

projectProgressSchema.index({ userId: 1, projectId: 1 }, { unique: true });

export type ProjectProgress = InferSchemaType<typeof projectProgressSchema>;
export const ProjectProgressModel = model("ProjectProgress", projectProgressSchema);
