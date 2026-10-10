import { Schema, model, Types, type InferSchemaType } from "mongoose";

/**
 * A student's whiteboard for one lesson — the snapshot the voice agent keeps
 * current during a class (debounced, a few seconds behind its own copy).
 *
 * The agent owns the board; this is the durable copy the student's browser
 * loads on entry and after a reconnect, and the one that outlives Redis.
 * `elements` is stored as-is: the shape of an element is the board protocol
 * (docs/board-protocol.md), validated by the agent that wrote it.
 *
 * `rev` is the agent's message counter. A save never moves it backwards — see
 * board.service.ts — so a delayed write cannot roll the board back.
 */
const boardSchema = new Schema(
  {
    userId: { type: Types.ObjectId, ref: "User", required: true },
    lessonId: { type: String, required: true },
    rev: { type: Number, default: 0, min: 0 },
    elements: { type: [Schema.Types.Mixed], default: [] },
  },
  { timestamps: true, minimize: false },
);

boardSchema.index({ userId: 1, lessonId: 1 }, { unique: true });

export type Board = InferSchemaType<typeof boardSchema>;
export const BoardModel = model("Board", boardSchema);
