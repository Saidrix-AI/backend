import { Schema, model, Types, type InferSchemaType } from "mongoose";
import { DEFAULT_LANGUAGE, LANGUAGES } from "../../validation/language.js";
import { OPERATING_SYSTEMS } from "./learnerProfile.model.js";

/**
 * The guided intake a student walks through before any course is built:
 * goal & target → language → their computer → knowledge check → timetable. The server owns the
 * stage machine (see services/intake.service.ts) exactly like the knowledge
 * check owns its rounds — the chat model only starts it and reads the result,
 * so a reload mid-intake resumes rather than restarting.
 *
 * The knowledge-check stage is not duplicated here: it runs as a normal
 * KnowledgeAssessment document, referenced by `assessmentId`.
 */
const answeredSchema = new Schema(
  {
    header: { type: String, required: true },
    question: { type: String, required: true },
    answer: { type: String, required: true },
  },
  { _id: false },
);

export const INTAKE_STAGES = ["goal", "language", "device", "test", "timetable"] as const;

const learningIntakeSchema = new Schema(
  {
    userId: { type: Types.ObjectId, ref: "User", required: true, index: true },
    topic: { type: String, required: true, trim: true },
    objective: { type: String, required: true, trim: true },
    /** Which course tool should run once the intake completes. */
    scope: { type: String, enum: ["single", "multi"], default: "single" },
    stage: { type: String, enum: [...INTAKE_STAGES], default: "goal" },
    status: { type: String, enum: ["in_progress", "completed"], default: "in_progress" },

    /** Stage 1 — what they want to achieve and by when, in their own words. */
    goal: { type: [answeredSchema], default: [] },
    /** The stage-1 questions currently on screen, so a reload can re-serve them. */
    pending: { type: [Schema.Types.Mixed], default: [] },
    /** Stage 2 — chosen once, then used by every generator downstream. */
    language: { type: String, enum: [...LANGUAGES], default: DEFAULT_LANGUAGE },
    /**
     * Stage 3 — which computer they will actually work on. Mirrored onto their
     * LearnerProfile (the durable home for it) and read from there by the
     * lecture-maker's setup lane; kept here too so a reload mid-intake can
     * re-serve the answered stage without a second collection read.
     */
    operatingSystem: { type: String, enum: [...OPERATING_SYSTEMS, ""], default: "" },
    /** Stage 4 — the knowledge check document driving the test stage. */
    assessmentId: { type: Schema.Types.ObjectId, ref: "KnowledgeAssessment" },
    profileSummary: { type: String, default: "" },
    /** Stage 5 — answers the routine is built from after the courses exist. */
    timetable: { type: [answeredSchema], default: [] },
  },
  { timestamps: true },
);

learningIntakeSchema.index({ userId: 1, status: 1, updatedAt: -1 });

export type LearningIntake = InferSchemaType<typeof learningIntakeSchema>;
export const LearningIntakeModel = model("LearningIntake", learningIntakeSchema);
