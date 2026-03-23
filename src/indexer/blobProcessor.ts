import { prisma } from "../database/db.js";
import { ShelbyRpcClient } from "../crawler/rpcClient.js";
import { extractMetadata } from "./metadataExtractor.js";
import { detectAlphaSignals } from "./alphaDetector.js";
import type { BlobJobData } from "../types.js";

/** Shared RPC client instance for all blob processing */
const rpcClient = new ShelbyRpcClient();

/**
 * Blob Processor
 *
 * Handles a single blob indexing job:
 * 1. Skip if already indexed (dedup by owner+blobName)
 * 2. Attempt to fetch blob details from Shelby RPC
 * 3. Extract metadata from the event data + RPC response
 * 4. Persist blob + metadata to the database
 *
 * Called by the BullMQ worker for each queued job.
 */
export async function processBlob(data: BlobJobData): Promise<void> {
  const blobId = `${data.accountAddress}:${data.blobName}`;

  console.log(`📦 Processing blob: ${blobId}`);

  // Step 1 — Deduplicate
  const existing = await prisma.blob.findUnique({
    where: { blobId },
  });

  if (existing) {
    console.log(`⏭️  Blob ${blobId} already indexed. Skipping.`);
    return;
  }

  // Step 2 — Attempt to fetch blob info from Shelby RPC
  let size = BigInt(0);
  let contentType: string | null = null;

  try {
    const blobInfo = await rpcClient.fetchBlobInfo(
      data.accountAddress,
      data.blobName
    );

    if (blobInfo) {
      size = blobInfo.size ? BigInt(blobInfo.size) : BigInt(0);
      contentType = blobInfo.contentType ?? null;
      console.log(`  📡 RPC returned: size=${size}, type=${contentType}`);
    } else {
      console.log(`  📡 RPC: blob not available yet (will index from event data)`);
    }
  } catch (error) {
    // RPC fetch is best-effort — don't fail the job for this
    console.warn(
      `  ⚠️  RPC fetch failed (indexing from event data):`,
      error instanceof Error ? error.message : error
    );
  }

  // Step 3 — Extract metadata from the discovery data
  const metadata = extractMetadata(data);

  // Step 4 — Parse timestamp (Aptos timestamps are in microseconds)
  const createdAt =
    data.timestamp && data.timestamp !== "0"
      ? new Date(Number(data.timestamp) / 1000)
      : new Date();

  // Step 5 — Persist blob + metadata in a single transaction
  await prisma.$transaction(async (tx) => {
    const blob = await tx.blob.create({
      data: {
        blobId,
        wallet: data.accountAddress,
        size,
        contentType,
        createdAt,
        indexedAt: new Date(),
      },
    });

    await tx.blobMetadata.create({
      data: {
        blobId: blob.blobId,
        title: metadata.title,
        description: metadata.description,
        tags: metadata.tags,
        fileType: metadata.fileType,
      },
    });
  });

  console.log(`✅ Blob ${blobId} indexed (block ${data.blockHeight}).`);

  // Run alpha signal detection (non-blocking, best-effort)
  await detectAlphaSignals(data);
}
