import type { FastifyInstance, FastifyError } from "fastify";
import { createModuleLogger } from "../../config/logger.js";

const log = createModuleLogger("api");

/**
 * Global Error Handler Plugin
 *
 * Registers a centralized error handler on the Fastify instance.
 * - Known errors (with statusCode) return structured JSON
 * - Unknown errors return 500 with a safe message (no stack leak)
 * - All errors are logged with context
 */
export async function errorHandler(app: FastifyInstance): Promise<void> {
  app.setErrorHandler((error: FastifyError, request, reply) => {
    const statusCode = error.statusCode ?? 500;

    // Log at appropriate level
    if (statusCode >= 500) {
      log.error(
        { err: error, method: request.method, url: request.url },
        "Internal server error"
      );
    } else {
      log.warn(
        { statusCode, method: request.method, url: request.url },
        error.message
      );
    }

    // Send structured error response
    void reply.status(statusCode).send({
      error: statusCode >= 500 ? "Internal Server Error" : error.message,
      statusCode,
      ...(statusCode < 500 && { detail: error.message }),
    });
  });

  // 404 handler for unmatched routes
  app.setNotFoundHandler((request, reply) => {
    log.debug({ method: request.method, url: request.url }, "Route not found");

    void reply.status(404).send({
      error: "Not Found",
      statusCode: 404,
      detail: `Route ${request.method} ${request.url} does not exist`,
    });
  });
}
