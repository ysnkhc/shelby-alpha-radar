import { env } from "./config/env.js";
import { logger } from "./config/logger.js";
import { startServer } from "./api/server.js";
import { CrawlerService } from "./crawler/crawler.js";
import { processBlob } from "./indexer/blobProcessor.js";
import { disconnectDatabase } from "./database/db.js";
import { pipelineState, recordError } from "./debugState.js";
import type { BlobJobData } from "./types.js";

/**
 * Shelby Indexer — Main Entry Point
 *
 * Direct processing: Crawler → processBlob → DB → alphaDetector → SSE
 * No BullMQ/Redis queue (was failing silently on Railway).
 */
async function main(): Promise<void> {
  logger.info("🚀 Shelby Indexer starting...");
  logger.info({ env: env.NODE_ENV, port: env.PORT, rpc: env.APTOS_RPC_URL }, "Configuration loaded");

  // ── 1. Start API server ─────────────────────────────────────
  const server = await startServer();

  // ── 2. Start crawler — directly processes blobs ──────────────
  const onBlobDiscovered = async (data: BlobJobData): Promise<void> => {
    pipelineState.blobEventsFound++;
    try {
      await processBlob(data);
      pipelineState.blobsInserted++;
    } catch (error) {
      pipelineState.blobInsertErrors++;
      recordError("processBlob", error);
      console.error(
        `[Pipeline] ❌ Failed to process blob ${data.blobName}:`,
        error instanceof Error ? error.message : error
      );
    }
  };

  const crawler = new CrawlerService(onBlobDiscovered);
  pipelineState.crawlerStartedAt = new Date().toISOString();
  await crawler.start();

  logger.info("✅ All systems operational (direct processing, no queue).");

  // ── Graceful shutdown ───────────────────────────────────────
  const shutdown = async (signal: string) => {
    logger.info({ signal }, "Shutting down gracefully...");
    crawler.stop();
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
