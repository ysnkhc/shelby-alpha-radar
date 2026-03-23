import { Worker } from "bullmq";
import { redisConnection, BLOB_QUEUE_NAME } from "./queue.js";
import { processBlob } from "../indexer/blobProcessor.js";
import type { BlobJobData } from "../types.js";

/**
 * Blob Processing Worker
 *
 * Consumes jobs from the blob-processing queue and runs them through
 * the full indexing pipeline (fetch details → extract metadata → save to DB).
 *
 * BullMQ handles:
 * - Automatic retries with exponential backoff (configured in queue.ts)
 * - Concurrency control
 * - Job lifecycle events
 */
export function createBlobWorker(concurrency = 5): Worker<BlobJobData> {
  const worker = new Worker<BlobJobData>(
    BLOB_QUEUE_NAME,
    async (job) => {
      console.log(`🔧 Worker picked up job ${job.id} (tx: ${job.data.txHash})`);
      await processBlob(job.data);
    },
    {
      connection: redisConnection,
      concurrency, // Process N jobs in parallel
    }
  );

  // ── Event handlers for observability ────────────────────────

  worker.on("completed", (job) => {
    console.log(`✅ Job ${job?.id} completed.`);
  });

  worker.on("failed", (job, error) => {
    console.error(
      `❌ Job ${job?.id} failed (attempt ${job?.attemptsMade}):`,
      error.message
    );
  });

  worker.on("error", (error) => {
    // Worker-level errors (e.g., Redis connection issues)
    console.error("⚠️  Worker error:", error.message);
  });

  console.log(`🏭 Blob worker started (concurrency: ${concurrency}).`);
  return worker;
}

/**
 * Gracefully shut down a worker.
 * Waits for in-progress jobs to finish before closing.
 */
export async function closeWorker(worker: Worker): Promise<void> {
  await worker.close();
  console.log("🛑 Worker shut down gracefully.");
}
