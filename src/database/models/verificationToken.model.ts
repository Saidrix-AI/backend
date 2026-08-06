import { Schema, model, Types, type InferSchemaType } from "mongoose";

export const VERIFICATION_TYPES = ["email_verify", "password_reset"] as const;
export type VerificationType = (typeof VERIFICATION_TYPES)[number];

/**
 * Short-lived codes for email verification (6-digit OTP) and password reset
 * (opaque token). Only the sha256 hash of the code/token is stored. The TTL
 * index purges expired rows automatically.
 */
const verificationTokenSchema = new Schema(
  {
    userId: { type: Types.ObjectId, ref: "User", required: true, index: true },
    type: { type: String, enum: VERIFICATION_TYPES, required: true },
    codeHash: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    attempts: { type: Number, default: 0 },
  },
  { timestamps: true },
);

verificationTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
verificationTokenSchema.index({ userId: 1, type: 1 });

export type VerificationToken = InferSchemaType<typeof verificationTokenSchema>;
export const VerificationTokenModel = model("VerificationToken", verificationTokenSchema);
