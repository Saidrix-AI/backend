import { Schema, model, Types, type InferSchemaType } from "mongoose";

/**
 * What the tutor remembers about talking to this student, across conversations.
 *
 * The other three things an agent knows about a student are each derived from
 * something the platform already stores, so none of them needed a home:
 *
 *   identity  — LearnerProfile        (self-reported, stable)
 *   mastery   — KnowledgeAssessment   (measured, updated by every lecture exam)
 *   state     — getStats()            (computed on read, never stored)
 *
 * This is the fourth, and the only one with nowhere else to live. Conversations
 * hold raw messages; nothing distilled them, so every new chat started blank.
 *
 * ONE ROLLING NARRATIVE, NOT A LOG. `narrative` is rewritten in full each time
 * (agents/memory-distiller reads the old one plus the new messages and returns
 * the successor), which is what keeps it bounded: an append-only history would
 * grow without limit and eventually dominate the prompt it is meant to inform.
 * Detail fading with age is the intended behaviour, not a shortcoming.
 *
 * UNTRUSTED. This text is model-written from what the student typed, and it is
 * injected into a system prompt. It is rendered under its own header telling the
 * agent these are notes and not instructions — see renderNarrativeSlice in
 * services/studentMemory.service.ts. Treat any change here as security-relevant.
 */

/**
 * Hard ceiling on the narrative, enforced here and in the distiller's zod
 * schema. Roughly 300 tokens — enough for a dozen lines about the student,
 * small enough that it can never crowd out the actual conversation.
 */
export const NARRATIVE_MAX_CHARS = 1200;

const studentMemorySchema = new Schema(
  {
    userId: { type: Types.ObjectId, ref: "User", required: true, unique: true, index: true },

    /** Third-person notes about the student. "" until the first distillation. */
    narrative: { type: String, default: "", maxlength: NARRATIVE_MAX_CHARS },
    /** When the narrative was last rewritten — "" narratives keep this null. */
    narrativeAt: { type: Date, default: null },
    /** How many times it has been rewritten. Ops visibility only; nothing reads it. */
    distillCount: { type: Number, default: 0 },
  },
  { timestamps: true },
);

export type StudentMemory = InferSchemaType<typeof studentMemorySchema>;
export const StudentMemoryModel = model("StudentMemory", studentMemorySchema);
