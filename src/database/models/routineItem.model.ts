import { Schema, model, type InferSchemaType } from "mongoose";

const routineItemSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    type: { type: String, enum: ["class", "task", "project"], required: true },
    title: { type: String, required: true, trim: true },
    // Chapter (classes), or a longer description (projects). Optional for tasks.
    subtitle: { type: String, trim: true },
    // The day this item is scheduled on — used to bucket into Today/Tomorrow/…
    date: { type: Date, required: true, index: true },
    // Display time e.g. "09:00 AM". Optional (tasks may carry it in `deadline`).
    time: { type: String },
    // Classes and tasks show an estimated duration in minutes.
    durationMin: { type: Number },
    // Task category chip: "Study" | "Practice" | etc.
    tag: { type: String },
    // Projects (and dated tasks) carry a hard deadline.
    deadline: { type: Date },
    // Tasks can be checked off.
    completed: { type: Boolean, default: false },
  },
  { timestamps: true },
);

export type RoutineItem = InferSchemaType<typeof routineItemSchema>;
export const RoutineItemModel = model("RoutineItem", routineItemSchema);
