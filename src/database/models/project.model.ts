import { Schema, model, Types, type InferSchemaType } from "mongoose";

/** A per-user project catalog record (the card metadata only). */
const projectSchema = new Schema(
  {
    userId: { type: Types.ObjectId, ref: "User", required: true, index: true },
    courseId: { type: String, default: "", index: true },
    title: { type: String, required: true, trim: true },
    desc: { type: String, trim: true, default: "" },
    // What the finished project should achieve, and the checkable statements a
    // submission is reviewed against. Both are AI-authored (project-requirements
    // agent) — empty on projects created before the reviewer existed, which the
    // read path backfills lazily.
    goal: { type: String, trim: true, default: "" },
    requirements: { type: [String], default: [] },
    tags: { type: [String], default: [] },
    icon: { type: String, default: "robot" },
    thumb: { type: String, default: "dark" },
    featured: { type: Boolean, default: false },
    // Where this project sits in its course, written by the project planner.
    // -1 / 0 / "" mean "not planned" (manually created or pre-planner projects).
    chapterIndex: { type: Number, default: -1 },
    /**
     * The exact lesson that opens this project, when the planner knows it.
     *
     * A chapter gate is the blunt version of the same idea: "finish all nine
     * lessons of chapter 2" when the project only needs the three that taught
     * the skill. A lessonId gate lets a project open the moment the student can
     * actually do it. Empty falls back to the chapter rule, so nothing planned
     * before this field existed changes behaviour — see services/projectGate.ts.
     */
    unlockLessonId: { type: String, default: "" },
    /**
     * Days from unlock to submission. 0 means no deadline.
     *
     * Stored as a duration rather than a date because the clock starts when the
     * student reaches the unlocking lesson, which is different for every
     * student. The absolute date is stamped on their ProjectProgress row.
     */
    submitWithinDays: { type: Number, default: 0, min: 0 },
    order: { type: Number, default: 0 },
    difficulty: { type: String, enum: ["starter", "practice", "capstone", ""], default: "" },
    estimatedHours: { type: Number, default: 0 },
  },
  { timestamps: true },
);

export type Project = InferSchemaType<typeof projectSchema>;
export const ProjectModel = model("Project", projectSchema);
