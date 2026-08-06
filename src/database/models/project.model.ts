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
    order: { type: Number, default: 0 },
    difficulty: { type: String, enum: ["starter", "practice", "capstone", ""], default: "" },
    estimatedHours: { type: Number, default: 0 },
  },
  { timestamps: true },
);

export type Project = InferSchemaType<typeof projectSchema>;
export const ProjectModel = model("Project", projectSchema);
