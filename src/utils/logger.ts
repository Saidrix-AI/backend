import { createRequire } from "node:module";
import { pino } from "pino";

const isDev =
  process.env.NODE_ENV !== "production" && process.env.NODE_ENV !== "test";

/**
 * `pino-pretty` is a devDependency, so a production install (`npm ci
 * --omit=dev`) does not have it. That is fine while NODE_ENV=production — but
 * when it is unset the check above reads as "dev" and pino would try to load a
 * module that is not installed, killing the process on its first log line.
 *
 * Resolving it up front turns that startup crash into plain JSON logs.
 */
function prettyAvailable(): boolean {
  try {
    createRequire(import.meta.url).resolve("pino-pretty");
    return true;
  } catch {
    return false;
  }
}

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  // In dev: clean, colorized one-line output. In prod: raw JSON (for aggregators).
  ...(isDev &&
    prettyAvailable() && {
      transport: {
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "SYS:HH:MM:ss",
          ignore: "pid,hostname,req,res,responseTime,reqId",
          singleLine: true,
        },
      },
    }),
});
