import { env } from "./config/env.js";
import { app } from "./app.js";
import { connectDatabase, disconnectDatabase } from "./database/connect.js";
import { AchievementModel } from "./database/models/achievement.model.js";
import { attachChatSocket, CHAT_WS_PATH } from "./realtime/socket.js";
import { logger } from "./utils/logger.js";

async function main(): Promise<void> {
  await connectDatabase();

  // The achievement unique index moved from (userId,key) to (userId,key,courseId).
  // Drop the stale index if present so the new one can build. Idempotent.
  try {
    await AchievementModel.collection.dropIndex("userId_1_key_1");
  } catch {
    // index already absent (fresh DB or already migrated) — fine
  }
  await AchievementModel.syncIndexes();

  const server = app.listen(env.PORT, () => {
    logger.info(`Server listening on http://localhost:${env.PORT}`);
  });

  // Chat streams over this socket; the SSE route stays as the fallback.
  attachChatSocket(server);
  logger.info(`Chat socket listening on ws://localhost:${env.PORT}${CHAT_WS_PATH}`);

  const shutdown = (signal: string) => {
    logger.info(`${signal} received, shutting down`);
    server.close(async () => {
      await disconnectDatabase();
      process.exit(0);
    });
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  logger.error(err, "Failed to start server");
  process.exit(1);
});
