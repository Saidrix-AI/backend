import { Schema, model, Types, type InferSchemaType } from "mongoose";

/**
 * Where a student had got to inside one lecture — the durable record behind
 * "carry on where I left off".
 *
 * The voice agent already keeps this in Redis under the room name, but that key
 * lives for hours, not days: leaving mid-lecture and coming back the next
 * morning silently restarted the lesson from block 0. Redis stays the hot path;
 * this is the floor it falls back to.
 *
 * `mode` is stored so a finished lecture is not resumed into its last block —
 * a completed lesson should open fresh.
 */
const lecturePositionSchema = new Schema(
  {
    userId: { type: Types.ObjectId, ref: "User", required: true, index: true },
    lessonId: { type: String, required: true },
    courseId: { type: String, default: "" },
    blockIndex: { type: Number, default: 0, min: 0 },
    mode: { type: String, default: "lecture" },
  },
  { timestamps: true },
);

lecturePositionSchema.index({ userId: 1, lessonId: 1 }, { unique: true });

export type LecturePosition = InferSchemaType<typeof lecturePositionSchema>;
export const LecturePositionModel = model("LecturePosition", lecturePositionSchema);
