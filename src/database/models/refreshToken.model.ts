import { Schema, model, Types, type InferSchemaType } from "mongoose";

/**
 * One row per issued refresh token. The raw token is never stored — only its
 * sha256 hash. Rotated on every use; the TTL index auto-purges expired rows.
 */
const refreshTokenSchema = new Schema(
  {
    userId: { type: Types.ObjectId, ref: "User", required: true, index: true },
    tokenHash: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true },
    userAgent: { type: String },
    ip: { type: String },
  },
  { timestamps: true },
);

// TTL index: MongoDB removes the document once expiresAt passes.
refreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export type RefreshToken = InferSchemaType<typeof refreshTokenSchema>;
export const RefreshTokenModel = model("RefreshToken", refreshTokenSchema);
