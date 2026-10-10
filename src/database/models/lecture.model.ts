import { Schema, model, type InferSchemaType } from "mongoose";
import { DEFAULT_LANGUAGE } from "../../validation/language.js";

const outlineItemSchema = new Schema(
  {
    id: { type: Number, required: true },
    title: { type: String, required: true, trim: true },
    duration: { type: String, default: "" },
  },
  { _id: false },
);

/**
 * Global lecture-content collection (no userId) — the single source of truth
 * for what the Classroom renders and the voice agent narrates. `lessonId`
 * matches Course.chapters[].modules[].topics[].lessonId (the completion key).
 * Blocks are heterogeneous (see frontend lecture.schema.json for the block
 * types) — stored as Mixed and validated at authoring/seed time, not here.
 */
const lectureSchema = new Schema(
  {
    lessonId: { type: String, required: true, unique: true },
    /**
     * Format version. Only 3 (sections) is read; anything older is treated as
     * absent and regenerated on next open (scripts/migrate-lectures-v3.mjs
     * deletes them outright).
     */
    version: { type: Number, default: 3 },
    /** Open set, not an enum — see course.model.ts and validation/language.ts. */
    language: { type: String, default: DEFAULT_LANGUAGE },
    /**
     * Which lecture-maker lane wrote this — "setup" means an installation guide
     * with a downloads section and a closing checklist instead of an exam.
     * Defaulted rather than required so lectures cached before the setup lane
     * existed keep rendering as what they are.
     */
    kind: { type: String, enum: ["concept", "setup"], default: "concept" },
    course: {
      title: { type: String, default: "" },
      breadcrumb: { type: [String], default: [] },
    },
    title: { type: String, required: true, trim: true },
    outline: { type: [outlineItemSchema], default: [] },
    /**
     * The lecture itself: sections in teaching order, each tagged theory /
     * practical / canvas, holding the page blocks and the tutor's (server-only)
     * teaching instructions. Shape: agents/lecture-maker/sections.ts. Mixed
     * because zod validates the whole document at authoring time.
     */
    sections: { type: [Schema.Types.Mixed], default: [] },
  },
  { timestamps: true },
);

export type Lecture = InferSchemaType<typeof lectureSchema>;
export const LectureModel = model("Lecture", lectureSchema);
