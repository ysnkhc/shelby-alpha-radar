import { env } from "./config/env.js";
import { logger } from "./config/logger.js";
import { startServer } from "./api/server.js";
import { CrawlerService } from "./crawler/crawler.js";
import { enqueueBlobJob, closeQueue } from "./worker/queue.js";
import { createBlobWorker, closeWorker } from "./worker/worker.js";
import { disconnectDatabase } from "./database/db.js";

/**
 * Shelby Indexer — Main Entry Point
 *
 * Orchestrates all subsystems:
 * 1. API server   — serves search endpoints
 * 2. Crawler      — polls Shelby RPC for new blobs
 * 3. Worker       — processes queued blobs (metadata extraction + DB storage)
 *
 * Handles graceful shutdown on SIGINT/SIGTERM.
 */
async function main(): Promise<void> {
  logger.info("🚀 Shelby Indexer starting...");
  logger.info({ env: env.NODE_ENV, port: env.PORT, rpc: env.SHELBY_RPC_URL }, "Configuration loaded");

  // ── 1. Start API server ─────────────────────────────────────
  const server = await startServer();

  // ── 2. Start blob processing worker ─────────────────────────
  const worker = createBlobWorker();

  // ── 3. Start crawler (scans transactions for blob activity) ──
  const crawler = new CrawlerService(enqueueBlobJob);
  await crawler.start();

  logger.info("✅ All systems operational.");

  // ── Graceful shutdown ───────────────────────────────────────
  const shutdown = async (signal: string) => {
    logger.info({ signal }, "Shutting down gracefully...");

    crawler.stop();
    await closeWorker(worker);
    await closeQueue();
    await server.close();
    await disconnectDatabase();

    logger.info("👋 Shelby Indexer stopped. Goodbye!");
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error: unknown) => {
  logger.fatal({ err: error }, "Fatal error during startup");
  process.exit(1);
});
