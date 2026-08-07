import { Schema, model, Types, type InferSchemaType } from "mongoose";
import { DEFAULT_LANGUAGE } from "../../validation/language.js";

/**
 * One question that was put to the student. `correctIndex` and `concept` are
 * server-only: assessment.service strips them before anything reaches the
 * client, so the answer to a diagnostic can never be read out of the payload.
 */
const askedQuestionSchema = new Schema(
  {
    round: { type: Number, required: true },
    header: { type: String, required: true },
    question: { type: String, required: true },
    options: { type: [String], required: true },
    multiSelect: { type: Boolean, default: false },
    kind: { type: String, enum: ["self_report", "diagnostic"], required: true },
    correctIndex: { type: Number },
    concept: { type: String },
  },
  { _id: false },
);

const answerSchema = new Schema(
  {
    round: { type: Number, required: true },
    header: { type: String, required: true },
    answer: { type: String, required: true },
    /** Only set for diagnostics — whether the picked option was the right one. */
    correct: { type: Boolean },
  },
  { _id: false },
);

const profileSchema = new Schema(
  {
    level: { type: String, enum: ["Beginner", "Intermediate", "Advanced"], required: true },
    knownConcepts: { type: [String], default: [] },
    gapConcepts: { type: [String], default: [] },
    goal: { type: String, default: "" },
    weeklyHours: { type: Number, default: 0 },
    styleNotes: { type: String, default: "" },
    summary: { type: String, default: "" },
    /** Measured, not inferred: percentage of diagnostics answered correctly. */
    diagnosticScore: { type: Number, default: null },
  },
  { _id: false },
);

/** A multi-round knowledge check. The server owns the round state, not the chat model. */
const knowledgeAssessmentSchema = new Schema(
  {
    userId: { type: Types.ObjectId, ref: "User", required: true, index: true },
    topic: { type: String, required: true, trim: true },
    objective: { type: String, required: true, trim: true },
    /** Which course tool should run once the check completes. */
    scope: { type: String, enum: ["single", "multi"], default: "single" },
    /**
     * Language the questions are written in — chosen in the intake, never
     * guessed. Open set, not an enum (validation/language.ts).
     */
    language: { type: String, default: DEFAULT_LANGUAGE },
    status: { type: String, enum: ["in_progress", "completed"], default: "in_progress" },
    /** The round currently awaiting answers (1-based). */
    round: { type: Number, default: 1 },
    asked: { type: [askedQuestionSchema], default: [] },
    answers: { type: [answerSchema], default: [] },
    profile: { type: profileSchema, default: undefined },
  },
  { timestamps: true },
);

knowledgeAssessmentSchema.index({ userId: 1, status: 1, updatedAt: -1 });

export type KnowledgeAssessment = InferSchemaType<typeof knowledgeAssessmentSchema>;
export const KnowledgeAssessmentModel = model("KnowledgeAssessment", knowledgeAssessmentSchema);
