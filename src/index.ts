import { env } from "./config/env.js";
import { app } from "./app.js";
import { connectDatabase, disconnectDatabase } from "./database/connect.js";
import { logger } from "./utils/logger.js";

async function main(): Promise<void> {
  await connectDatabase();

  const server = app.listen(env.PORT, () => {
    logger.info(`Server listening on http://localhost:${env.PORT}`);
  });

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
