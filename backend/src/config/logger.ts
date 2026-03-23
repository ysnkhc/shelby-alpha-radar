import pino from "pino";
import { env } from "./env.js";

/**
 * Structured Logger
 *
 * Centralized pino logger for the entire application.
 * - Development: pretty-printed, colorized, debug level
 * - Production: JSON output, info level (for log aggregators)
 *
 * Usage:
 *   import { logger } from "./config/logger.js";
 *   logger.info({ blobId }, "Processing blob");
 *   logger.error({ err }, "Failed to process blob");
 */
export const logger = pino({
  level: env.NODE_ENV === "production" ? "info" : "debug",
  transport:
    env.NODE_ENV !== "production"
      ? { target: "pino-pretty", options: { colorize: true } }
      : undefined,
  // Base fields included in every log line
  base: { service: "shelby-indexer" },
  // Redact sensitive fields
  redact: ["req.headers.authorization", "req.headers.cookie"],
});

/**
 * Create a child logger scoped to a specific module.
 * Adds a `module` field to every log line from this child.
 */
export function createModuleLogger(moduleName: string) {
  return logger.child({ module: moduleName });
}
