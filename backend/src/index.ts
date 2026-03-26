import { env } from "./config/env.js";
import { logger } from "./config/logger.js";
import { startServer } from "./api/server.js";
import { CrawlerService } from "./crawler/crawler.js";
import { processBlob } from "./indexer/blobProcessor.js";
import { prisma } from "./database/db.js";
import { disconnectDatabase } from "./database/db.js";
import { pipelineState, recordError } from "./debugState.js";
import type { BlobJobData } from "./types.js";

/**
 * Ensure the database schema has the content intelligence columns.
 * Uses ALTER TABLE IF NOT EXISTS pattern to safely add missing columns.
 */
async function ensureContentIntelligenceSchema(): Promise<void> {
  try {
    // Add 'signals' column (text array)
    await prisma.$executeRawUnsafe(`
      ALTER TABLE blob_metadata
      ADD COLUMN IF NOT EXISTS signals TEXT[] DEFAULT '{}'
    `);

    // Add 'analysis_status' column
    await prisma.$executeRawUnsafe(`
      ALTER TABLE blob_metadata
      ADD COLUMN IF NOT EXISTS analysis_status TEXT DEFAULT 'pending'
    `);

    // Add 'content_preview' column
    await prisma.$executeRawUnsafe(`
      ALTER TABLE blob_metadata
      ADD COLUMN IF NOT EXISTS content_preview TEXT
    `);

    // Add 'project_id' column to blobs
    await prisma.$executeRawUnsafe(`
      ALTER TABLE blobs
      ADD COLUMN IF NOT EXISTS project_id TEXT
    `);

    // Add index on project_id
    await prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS blobs_project_id_idx ON blobs(project_id)
    `);

    // Create projects table for global project intelligence
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS projects (
        project_id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'general',
        wallets TEXT[] DEFAULT '{}',
        tags TEXT[] DEFAULT '{}',
        signals TEXT[] DEFAULT '{}',
        file_types TEXT[] DEFAULT '{}',
        blob_count INTEGER DEFAULT 0,
        wallet_count INTEGER DEFAULT 0,
        growth_rate DOUBLE PRECISION DEFAULT 0,
        first_seen TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
        last_active TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Indexes on projects
    await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS projects_category_idx ON projects(category)`);
    await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS projects_wallet_count_idx ON projects(wallet_count)`);
    await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS projects_blob_count_idx ON projects(blob_count)`);
    await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS projects_last_active_idx ON projects(last_active)`);

    console.log("[DB] ✅ Schema verified (content intelligence + global project clustering)");
  } catch (error) {
    console.error(
      "[DB] ⚠️ Schema migration warning:",
      error instanceof Error ? error.message : error
    );
  }
}

/**
 * Shelby Indexer — Main Entry Point
 *
 * Direct processing: Crawler → processBlob → DB → alphaDetector → SSE
 */
async function main(): Promise<void> {
  logger.info("🚀 Shelby Indexer starting...");
  logger.info({ env: env.NODE_ENV, port: env.PORT, rpc: env.APTOS_RPC_URL }, "Configuration loaded");

  // ── 0. Ensure DB schema is up to date ───────────────────────
  await ensureContentIntelligenceSchema();

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
