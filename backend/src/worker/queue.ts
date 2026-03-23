import { Queue } from "bullmq";
import type { ConnectionOptions } from "bullmq";
import { env } from "../config/env.js";
import type { BlobJobData } from "../types.js";

/**
 * Redis connection config shared across queue producer and workers.
 * BullMQ accepts a ConnectionOptions object which it uses internally.
 */
function parseRedisUrl(url: string): ConnectionOptions {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: Number(parsed.port) || 6379,
    password: parsed.password || undefined,
    maxRetriesPerRequest: null, // Required by BullMQ
  };
}

export const redisConnection: ConnectionOptions = parseRedisUrl(env.REDIS_URL);

/** Queue name constant — used by both producer and consumer */
export const BLOB_QUEUE_NAME = "blob-processing";

/**
 * BullMQ Queue for blob processing jobs.
 *
 * The crawler pushes jobs here; workers consume them.
 * Each job carries a BlobJobData payload with the blob's core info.
 */
export const blobQueue = new Queue<BlobJobData>(BLOB_QUEUE_NAME, {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 5, // Retry up to 5 times (blob may not be immediately available via RPC)
    backoff: {
      type: "exponential",
      delay: 5_000, // 5s → 10s → 20s → 40s → 80s
    },
    removeOnComplete: {
      count: 1000, // Keep last 1000 completed jobs for debugging
    },
    removeOnFail: {
      count: 5000, // Keep last 5000 failed jobs for inspection
    },
  },
});

/**
 * Add a blob processing job to the queue.
 *
 * Uses owner+blobName as the job ID to prevent duplicate processing.
 * If a job with the same identity already exists, BullMQ skips it.
 *
 * @param data - The blob job payload from the crawler
 */
export async function enqueueBlobJob(data: BlobJobData): Promise<void> {
  // Derive a stable blob identity for dedup
  const blobId = `${data.accountAddress}:${data.blobName}`;
  await blobQueue.add("process-blob", data, {
    jobId: `blob-${Buffer.from(blobId).toString("base64url")}`, // Deduplicate by blob identity
  });
}

/**
 * Gracefully close the queue.
 */
export async function closeQueue(): Promise<void> {
  await blobQueue.close();
  console.log("📭 Queue closed.");
}
