import { Schema, model, Types, type InferSchemaType } from "mongoose";

const issueSchema = new Schema(
  {
    line: { type: Number, required: true },
    severity: { type: String, enum: ["error", "warning", "suggestion"], required: true },
    text: { type: String, required: true },
    why: { type: String, default: "" },
    fix: { type: String, default: "" },
    learn: { type: String, default: "" },
  },
  { _id: false },
);

const reviewedFileSchema = new Schema(
  {
    path: { type: String, required: true },
    language: { type: String, default: "" },
    // The exact source the issues' line numbers refer to — the reviewer reads a
    // snapshot (a repo moves on, an upload is gone), so the report carries it.
    content: { type: String, default: "" },
    errors: { type: Number, default: 0 },
    warnings: { type: Number, default: 0 },
    suggestions: { type: Number, default: 0 },
    issues: { type: [issueSchema], default: [] },
  },
  { _id: false },
);

const requirementResultSchema = new Schema(
  {
    requirement: { type: String, required: true },
    met: { type: Boolean, default: false },
    evidence: { type: String, default: "" },
  },
  { _id: false },
);

/**
 * One review per submission attempt. `attempt` is the 1-based index into the
 * matching ProjectProgress.submissions array — that array stays the record of
 * what was submitted; this is the record of what the reviewer made of it.
 *
 * fileTree is an opaque nested {name, type, children?} payload for the Files
 * panel — Mixed because mongoose has no clean self-referential schema, and the
 * pipeline validates the whole document with zod before it is persisted.
 */
const projectReviewSchema = new Schema(
  {
    userId: { type: Types.ObjectId, ref: "User", required: true, index: true },
    projectId: { type: String, required: true },
    attempt: { type: Number, required: true },
    method: { type: String, enum: ["github", "file"], required: true },
    sourceRef: { type: String, default: "" },
    status: { type: String, enum: ["running", "completed", "failed"], default: "running" },
    errorMessage: { type: String, default: "" },
    qualityScore: { type: Number, default: 0 },
    requirementResults: { type: [requirementResultSchema], default: [] },
    fileTree: { type: Schema.Types.Mixed, default: [] },
    files: { type: [reviewedFileSchema], default: [] },
    overallFeedback: { type: String, default: "" },
    // True when the smart filter's caps dropped source before review.
    truncated: { type: Boolean, default: false },
  },
  { timestamps: true },
);

projectReviewSchema.index({ userId: 1, projectId: 1, attempt: 1 }, { unique: true });

export type ProjectReview = InferSchemaType<typeof projectReviewSchema>;
export const ProjectReviewModel = model("ProjectReview", projectReviewSchema);
