import { Schema, model, Types, type InferSchemaType } from "mongoose";
import { DEFAULT_LANGUAGE } from "../../validation/language.js";

// The `summary` / `outcomes` / duration fields are written by the Course-maker's
// enrichment pass (agents/course-maker/enrich.ts). They are optional on purpose:
// courses created before enrichment existed — and chapters whose worker call
// failed — keep working with titles only, and the UI hides what is missing.
const topicSchema = new Schema(
  {
    title: { type: String, required: true, trim: true },
    lessonId: { type: String, required: true }, // stable completion key
    summary: { type: String, trim: true, default: "" },
    // The Course-maker's instruction to the lecture writer for this one lesson —
    // what to cover, the example to build, the boundary not to cross. Consumed by
    // the lecture planner (services/lecture.service.ts) and stripped before the
    // wire (services/course.projection.ts); never shown to the student.
    brief: { type: String, trim: true, default: "" },
    durationMin: { type: Number, default: 0 },
  },
  { _id: false },
);

const moduleSchema = new Schema(
  {
    title: { type: String, required: true, trim: true },
    summary: { type: String, trim: true, default: "" },
    topics: { type: [topicSchema], default: [] },
  },
  { _id: false },
);

const chapterSchema = new Schema(
  {
    title: { type: String, required: true, trim: true },
    summary: { type: String, trim: true, default: "" },
    outcomes: { type: [String], default: [] },
    estimatedHours: { type: Number, default: 0 },
    difficulty: {
      type: String,
      enum: ["Beginner", "Intermediate", "Advanced"],
      default: "Beginner",
    },
    modules: { type: [moduleSchema], default: [] },
  },
  { _id: false },
);

const quizSchema = new Schema(
  {
    quizId: { type: String, required: true },
    title: { type: String, required: true, trim: true },
  },
  { _id: false },
);

/** A per-user course catalog record with an optional full curriculum. */
const courseSchema = new Schema(
  {
    userId: { type: Types.ObjectId, ref: "User", required: true, index: true },
    title: { type: String, required: true, trim: true },
    desc: { type: String, trim: true, default: "" },
    /**
     * Why a student would take this course at all — the problem it solves for
     * them, not a restatement of the syllabus.
     *
     * Separate from `desc` because they answer different questions and get read
     * in different places: `desc` is the one-line card blurb, this is the "is
     * this for me?" paragraph on the course page. Blending them gave cards a
     * paragraph and the page a blurb.
     */
    whyTake: { type: String, trim: true, default: "" },
    /**
     * What the student can DO at the end — one line per capability, phrased as
     * an action. Chapters already carry their own `outcomes`; these are the
     * course-level few that survive a chapter being reordered or rewritten.
     */
    outcomes: { type: [String], default: [] },
    level: {
      type: String,
      enum: ["Beginner", "Intermediate", "Advanced"],
      default: "Beginner",
    },
    // The language its curriculum text is written in, chosen in the guided
    // intake — lectures for this course are then generated in it too. Not an
    // enum: the language set is open (validation/language.ts), so a student can
    // type a language we have no entry for and still get a course in it.
    language: { type: String, default: DEFAULT_LANGUAGE },
    // Derived from chapters (total topic count) on create/update.
    lessons: { type: Number, default: 0 },
    estimatedHours: { type: Number, default: 0 },
    icon: { type: String, default: "book" },
    thumb: { type: String, default: "dark" },
    chapters: { type: [chapterSchema], default: [] },
    quizzes: { type: [quizSchema], default: [] },
    // Multi-course learning path linkage (optional — standalone courses have none).
    // Set when a course is generated as part of a proposed LearningPath, so the
    // Courses page can group siblings and show them in order (Step `order`/`pathTotal`).
    pathId: { type: Types.ObjectId, ref: "LearningPath", index: true },
    pathTitle: { type: String, trim: true }, // denormalized path goal, for grouping without a join
    order: { type: Number }, // 1-based position within the path
    pathTotal: { type: Number }, // number of courses in the path

    // --- Activation lock, for STANDALONE courses only ---
    // A course inside a path is governed by its path's lock, never its own:
    // the path is the unit a student commits to. Same two-sided meaning as
    // LearningPath.lockedUntil — see services/activeSelection.service.ts.
    lockedUntil: { type: Date, default: null },
    activatedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

export type Course = InferSchemaType<typeof courseSchema>;
export const CourseModel = model("Course", courseSchema);
