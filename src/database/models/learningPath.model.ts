import { Schema, model, Types, type InferSchemaType } from "mongoose";

/**
 * One proposed multi-course path. Authored in a single `propose_courses` call
 * (so its per-course `covers` scopes are coordinated and non-overlapping) and
 * then used as the authoritative plan when each chosen course is generated:
 * `order` fixes the sequence and the sibling `covers` become each course's
 * prerequisite/deferral boundaries. See agents/tools/course-maker-tools.ts.
 */
const pathCourseSchema = new Schema(
  {
    title: { type: String, required: true, trim: true },
    objective: { type: String, required: true, trim: true },
    level: { type: String, enum: ["Beginner", "Intermediate", "Advanced"] },
    // 1-2 lines of the concrete topics this course teaches.
    covers: { type: String, trim: true, default: "" },
    /**
     * 1-3 words naming what this step is *about* ("Language basics",
     * "Logic & loops") — the label the Courses page lists down the side of a
     * path so the shape of the journey reads at a glance. Deliberately not the
     * course title: the titles are long and repeat the subject, which is
     * exactly what makes a stacked list of them unreadable.
     */
    theme: { type: String, trim: true, default: "" },
    /**
     * The curriculum template course this step was taken from
     * ({sourcePath, courseIndex}), or null for a step the model wrote. The
     * course outline then follows that course's modules.
     */
    template: { type: Schema.Types.Mixed, default: null },
  },
  { _id: false },
);

const learningPathSchema = new Schema(
  {
    userId: { type: Types.ObjectId, ref: "User", required: true, index: true },
    goal: { type: String, required: true, trim: true },
    /** One plain sentence on what this path gives the student, shown under the
     *  goal on the Courses page. Empty on paths proposed before this existed —
     *  callers fall back rather than showing a blank line. */
    summary: { type: String, trim: true, default: "" },
    courses: { type: [pathCourseSchema], default: [] }, // ordered, foundational → advanced

    // --- Activation lock (see services/activeSelection.service.ts) ---
    // One field covers both directions, because which one applies is decided by
    // whether this path is the user's active one: while it is active the lock
    // stops it being switched OFF, and while it is inactive the same lock stops
    // it being switched back ON. Both windows are COOLDOWN_DAYS long.
    lockedUntil: { type: Date, default: null },
    /** When it was last activated — shown as "active since" in the panel. */
    activatedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

export type LearningPath = InferSchemaType<typeof learningPathSchema>;
export const LearningPathModel = model("LearningPath", learningPathSchema);
