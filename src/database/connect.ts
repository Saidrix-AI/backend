import mongoose from "mongoose";
import { env } from "../config/env.js";
import { UserModel } from "./models/user.model.js";
import { logger } from "../utils/logger.js";

/**
 * The unique indexes on `username` / `email` are what actually prevent
 * duplicate accounts — the check inside register() is only there to produce a
 * friendly message, and two concurrent signups can both pass it. Mongoose does
 * build these from the schema, but in the background and *silently*: if the
 * collection already holds duplicates the build fails and nothing says so, and
 * the app then runs with no protection at all. Build them here so that failure
 * is loud.
 */
async function ensureUserIndexes(): Promise<void> {
  try {
    await UserModel.createIndexes();
  } catch (err) {
    logger.error(
      err,
      "Could not build the unique user indexes — duplicate usernames/emails are NOT being blocked. " +
        "Most likely the collection already contains duplicates; de-duplicate it and restart.",
    );
  }
}

export async function connectDatabase(): Promise<void> {
  mongoose.connection.on("disconnected", () => {
    logger.warn("MongoDB disconnected");
  });

  await mongoose.connect(env.MONGODB_URI);
  logger.info("MongoDB connected");
  await ensureUserIndexes();
}

export async function disconnectDatabase(): Promise<void> {
  await mongoose.disconnect();
  logger.info("MongoDB disconnected gracefully");
}
