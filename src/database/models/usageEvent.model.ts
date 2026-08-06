import { Schema, model, Types, type InferSchemaType } from "mongoose";

/** Metered actions. Only course generation is metered today. */
export const USAGE_KINDS = ["course_generated"] as const;
export type UsageKind = (typeof USAGE_KINDS)[number];

/**
 * An append-only record of a metered action.
 *
 * Deliberately a separate ledger rather than a count of Course documents:
 * counting the courses themselves would let a student delete a course to win
 * their quota back, and generating it is what costs money, not keeping it.
 * Nothing in the app ever deletes from this collection.
 */
const usageEventSchema = new Schema({
  userId: { type: Types.ObjectId, ref: "User", required: true },
  kind: { type: String, enum: USAGE_KINDS, required: true },
  /** What was produced, for support questions. Not read by the quota check. */
  ref: { type: String, default: "" },
  createdAt: { type: Date, default: Date.now },
});

// The only query: "how many of `kind` has this user done since `periodStart`".
usageEventSchema.index({ userId: 1, kind: 1, createdAt: -1 });

export type UsageEvent = InferSchemaType<typeof usageEventSchema>;
export const UsageEventModel = model("UsageEvent", usageEventSchema);
