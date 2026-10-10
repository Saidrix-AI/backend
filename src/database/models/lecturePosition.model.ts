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
    /**
     * Where they were in the TEACHING spine, for a v2 lecture: which concept,
     * and how far through it.
     *
     * `blockIndex` alone cannot resume a conversational class. Coming back to
     * the block the tutor happened to be showing loses whether that concept had
     * been probed, explained or checked — so the student gets asked "do you know
     * this?" about something they were mid-way through understanding. Both are
     * stored: `blockIndex` still drives the page, and a v1 lecture leaves these
     * empty and resumes exactly as it always did.
     */
    beatId: { type: String, default: "" },
    beatPhase: { type: String, default: "" },
    /**
     * The current topic's opening-question result: concepts (beat ids) the
     * student already knew / half knew. Without it a class resumed mid-topic
     * would re-teach what they had just said they know.
     */
    knownBeats: { type: [String], default: [] },
    partlyBeats: { type: [String], default: [] },
    /**
     * The tutor's own running notes on this class: what was taught, where the
     * student struggled, what is still open. Written by the voice agent as the
     * class goes and read back when the student returns to this lesson.
     */
    classNotes: { type: String, default: "", maxlength: 2000 },
  },
  { timestamps: true },
);

lecturePositionSchema.index({ userId: 1, lessonId: 1 }, { unique: true });

export type LecturePosition = InferSchemaType<typeof lecturePositionSchema>;
export const LecturePositionModel = model("LecturePosition", lecturePositionSchema);
