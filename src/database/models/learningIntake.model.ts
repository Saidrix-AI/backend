import { Schema, model, Types, type InferSchemaType } from "mongoose";
import { DEFAULT_LANGUAGE } from "../../validation/language.js";
import { TOPIC_KINDS } from "../../agents/intake/schema.js";
import { OPERATING_SYSTEMS } from "./learnerProfile.model.js";

/**
 * The guided intake a student walks through before any course is built.
 *
 * It is a SLOT MACHINE, not a fixed sequence: services/intake.slots.ts holds
 * nine slots, each with a predicate saying whether this student should be asked
 * it at all, and the answer to one slot decides which of the later ones apply.
 * A student learning a non-technical subject is never asked about their
 * operating system; one who does not know what a code editor is is never asked
 * whether they understand programming theory, because they just answered that.
 *
 * The server owns the machine exactly like the knowledge check owns its rounds
 * — the chat model only starts it and reads the result, so a reload mid-intake
 * resumes rather than restarting.
 *
 * The diagnostic stage is not duplicated here: when the director decides to ask
 * one it runs as a normal KnowledgeAssessment document, referenced by
 * `assessmentId`.
 */
const answeredSchema = new Schema(
  {
    /** Which slot produced this question — lets the transcript be filtered. */
    stage: { type: String, default: "" },
    header: { type: String, required: true },
    question: { type: String, required: true },
    answer: { type: String, default: "" },
  },
  { _id: false },
);

export const INTAKE_STAGES = [
  "language",
  "goal",
  "os",
  "tools",
  "foundation",
  "background",
  "probe",
  "schedule",
  "routine",
] as const;
export type IntakeStageName = (typeof INTAKE_STAGES)[number];

/** How ready their machine is. See agents/tools/prompts/intake.ts parseTooling. */
export const TOOLING_STATES = ["ready", "none", "unknown"] as const;
/** Programming background. See parseFoundation. */
export const FOUNDATION_STATES = ["none", "some", "solid"] as const;

const learningIntakeSchema = new Schema(
  {
    userId: { type: Types.ObjectId, ref: "User", required: true, index: true },
    topic: { type: String, required: true, trim: true },
    objective: { type: String, required: true, trim: true },
    /** Which course tool should run once the intake completes. */
    scope: { type: String, enum: ["single", "multi"], default: "single" },
    stage: { type: String, enum: [...INTAKE_STAGES], default: "language" },
    status: { type: String, enum: ["in_progress", "completed"], default: "in_progress" },

    // --- What the intake plan decided (agents/intake/plan via index.ts) ---
    /** Gates the programming-foundations slot. */
    topicKind: { type: String, enum: [...TOPIC_KINDS], default: "non-technical" },
    /** Gates the operating-system and editor slots. */
    needsLocalSetup: { type: Boolean, default: false },
    /**
     * The two topic-specific questions, written by the plan call as soon as the
     * language is known and held until their own slot comes up. Stored so a
     * reload re-serves exactly what was asked rather than paying for a second
     * generation that would word it differently.
     */
    plannedQuestions: { type: Schema.Types.Mixed, default: {} },

    // --- The transcript ---
    /** Every question asked and what came back, in order. */
    answers: { type: [answeredSchema], default: [] },
    /** The questions currently on screen, so a reload can re-serve them. */
    pending: { type: [Schema.Types.Mixed], default: [] },
    /** Slots this student was never asked, for the stage rail and for debugging. */
    skipped: { type: [String], default: [] },

    // --- Typed facts read back off the answers ---
    /** Chosen once, then used by every generator downstream. Open set, not an enum. */
    language: { type: String, default: DEFAULT_LANGUAGE },
    /**
     * Which computer they will actually work on. Mirrored onto their
     * LearnerProfile (the durable home for it) and read from there by the
     * lecture-maker's setup lane.
     */
    operatingSystem: { type: String, enum: [...OPERATING_SYSTEMS, ""], default: "" },
    /** "unknown" means they do not know what an editor IS — see parseTooling. */
    tooling: { type: String, enum: [...TOOLING_STATES, ""], default: "" },
    foundation: { type: String, enum: [...FOUNDATION_STATES, ""], default: "" },
    /** Minutes a day they can study. Nothing in the app captured this before. */
    dailyMinutes: { type: Number, default: 0 },
    /** Days they want to finish inside. */
    finishByDays: { type: Number, default: 0 },
    /** Whether to build the routine automatically once the course exists. */
    autoRoutine: { type: Boolean, default: false },
    /** Clock time to schedule at, e.g. "06:00 PM". Empty when autoRoutine is false. */
    routineTime: { type: String, default: "" },

    // --- Outcome ---
    /** The diagnostic, when the director decided one was worth asking. */
    assessmentId: { type: Schema.Types.ObjectId, ref: "KnowledgeAssessment" },
    /**
     * The finished brief the course-maker builds from (agents/intake/report.ts).
     * Shaped as a KnowledgeProfile plus startFrom/skip/needsSetupLesson, which
     * is what lets latestProfile and profileLines keep working unchanged.
     */
    report: { type: Schema.Types.Mixed, default: null },
  },
  { timestamps: true },
);

learningIntakeSchema.index({ userId: 1, status: 1, updatedAt: -1 });

export type LearningIntake = InferSchemaType<typeof learningIntakeSchema>;
export const LearningIntakeModel = model("LearningIntake", learningIntakeSchema);
