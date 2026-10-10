import { Schema, model, type InferSchemaType } from "mongoose";

/**
 * One curriculum template, extracted once from a lesson PDF at ingest time
 * (scripts/ingest-pdfs.ts). The PDFs are Saidrix's own course designs:
 *
 *  - foundation — one language's complete foundation course (its modules);
 *  - roadmap    — a role's ordered courses (each step a course with modules);
 *  - guide      — reference material (career structure) with no courses.
 *
 * The intake writes its questions from these, a proposal's course list is
 * taken from them, and a course outline follows their modules. Global (no
 * owner): it is curriculum, not user data.
 */
const moduleSchema = new Schema(
  {
    title: { type: String, required: true, trim: true },
    topics: { type: String, default: "", trim: true },
  },
  { _id: false },
);

const courseSchema = new Schema(
  {
    title: { type: String, required: true, trim: true },
    summary: { type: String, default: "", trim: true },
    status: { type: String, default: "", trim: true },
    modules: { type: [moduleSchema], default: [] },
    tools: { type: String, default: "", trim: true },
    project: { type: String, default: "", trim: true },
  },
  { _id: false },
);

const curriculumTemplateSchema = new Schema(
  {
    sourcePath: { type: String, required: true, unique: true },
    kind: { type: String, enum: ["foundation", "roadmap", "guide"], required: true },
    skill: { type: String, required: true, trim: true },
    summary: { type: String, default: "", trim: true },
    /** Other names a student might use for it ("JS", "Android backend"). */
    aliases: { type: [String], default: [] },
    courses: { type: [courseSchema], default: [] },
  },
  { timestamps: true },
);

export type CurriculumTemplate = InferSchemaType<typeof curriculumTemplateSchema>;
export const CurriculumTemplateModel = model("CurriculumTemplate", curriculumTemplateSchema);
