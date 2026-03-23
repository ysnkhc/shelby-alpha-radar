import Fastify from "fastify";
import cors from "@fastify/cors";
import { env } from "../config/env.js";
import { logger } from "../config/logger.js";
import { blobRoutes } from "./routes/blobs.js";
import { statsRoutes } from "./routes/stats.js";
import { searchRoutes } from "./routes/search.js";
import { intelligenceRoutes } from "./routes/intelligence.js";
import { alphaRoutes } from "./routes/alpha.js";
import { liveRoutes } from "./routes/live.js";
import { errorHandler } from "./plugins/errorHandler.js";
import { rateLimiter } from "./plugins/rateLimiter.js";

/**
 * API Server
 *
 * Creates and configures the Fastify HTTP server.
 * Registers error handling, rate limiting, CORS, and all route plugins.
 */
export async function createServer() {
  const app = Fastify({
    logger: {
      level: process.env.NODE_ENV === "production" ? "info" : "debug",
      transport:
        process.env.NODE_ENV !== "production"
          ? { target: "pino-pretty", options: { colorize: true } }
          : undefined,
    },
  });

  // ── Plugins ─────────────────────────────────────────────────
  await app.register(cors, { origin: true });
  await app.register(errorHandler);
  await app.register(rateLimiter, { max: 100, windowMs: 60_000 });

  // ── Health check ────────────────────────────────────────────
  app.get("/health", async () => ({
    status: "ok",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  }));

  // ── Route modules ──────────────────────────────────────────
  await app.register(blobRoutes);
  await app.register(statsRoutes);
  await app.register(searchRoutes);
  await app.register(intelligenceRoutes);
  await app.register(alphaRoutes);
  await app.register(liveRoutes);

  return app;
}

/**
 * Start the Fastify server.
 */
export async function startServer() {
  const app = await createServer();

  await app.listen({ port: env.PORT, host: "0.0.0.0" });
  logger.info({ port: env.PORT }, "🌐 API server listening");

  return app;
}
