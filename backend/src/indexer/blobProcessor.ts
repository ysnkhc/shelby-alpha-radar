import { prisma } from "../database/db.js";
import { ShelbyRpcClient } from "../crawler/rpcClient.js";
import { extractMetadata } from "./metadataExtractor.js";
import { analyzeContent } from "./contentAnalyzer.js";
import { detectAlphaSignals } from "./alphaDetector.js";
import type { BlobJobData } from "../types.js";

/** Shared RPC client instance for all blob processing */
const rpcClient = new ShelbyRpcClient();

/**
 * Blob Processor — with Content Intelligence
 *
 * Pipeline:
 * 1. Dedup by owner+blobName
 * 2. Fetch blob content from Shelby RPC (best-effort, capped 300KB)
 * 3. Run content analyzer → tags, signals, preview
 * 4. Extract filename metadata
 * 5. Persist blob + enriched metadata to DB
 * 6. Trigger alpha signal detection
 *
 * Content analysis never blocks indexing — failures are swallowed.
 */
export async function processBlob(data: BlobJobData): Promise<void> {
  const blobId = `${data.accountAddress}:${data.blobName}`;

  // Step 1 — Deduplicate
  const existing = await prisma.blob.findUnique({ where: { blobId } });
  if (existing) return;

  // Step 2 — Fetch blob content from Shelby RPC
  let size = BigInt(0);
  let contentType: string | null = null;
  let contentBuffer: Buffer | null = null;

  try {
    const blobContent = await rpcClient.fetchBlobContent(
      data.accountAddress,
      data.blobName
    );

    if (blobContent) {
      size = BigInt(blobContent.size ?? 0);
      contentType = blobContent.contentType ?? null;
      contentBuffer = blobContent.buffer;
    }
  } catch (error) {
    // RPC fetch is best-effort
    console.warn(
      `[RPC] ⚠️ Fetch failed for ${blobId}:`,
      error instanceof Error ? error.message : error
    );
  }

  // Step 3 — Content Intelligence (never blocks)
  let tags: string[] = [];
  let signals: string[] = [];
  let contentPreview: string | null = null;
  let analysisStatus = "pending";

  try {
    const analysis = analyzeContent(data.blobName, contentBuffer, contentType ?? undefined);
    tags = analysis.tags;
    signals = analysis.signals;
    contentPreview = analysis.contentPreview;
    analysisStatus = analysis.analysisStatus;

    if (tags.length > 0 || signals.length > 0) {
      console.log(
        `[Content] ${blobId}: type=${analysis.detectedType} tags=[${tags.join(",")}] signals=[${signals.join(",")}] status=${analysisStatus}`
      );
    }
  } catch (error) {
    analysisStatus = "error";
    console.warn(
      `[Content] ⚠️ Analysis failed for ${blobId}:`,
      error instanceof Error ? error.message : error
    );
  }

  // Step 4 — Extract filename metadata
  const metadata = extractMetadata(data);

  // Merge content-derived tags with filename-derived tags
  const mergedTags = [...new Set([...metadata.tags, ...tags])];

  // Step 5 — Parse timestamp (Aptos timestamps are in microseconds)
  const createdAt =
    data.timestamp && data.timestamp !== "0"
      ? new Date(Number(data.timestamp) / 1000)
      : new Date();

  // Step 6 — Persist blob + enriched metadata
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
        tags: mergedTags,
        fileType: metadata.fileType,
        signals,
        analysisStatus,
        contentPreview,
      },
    });
  });

  console.log(
    `[DB] ✅ Blob inserted: ${data.accountAddress.slice(0, 10)}.../${data.blobName.split("/").pop()} (block ${data.blockHeight})`
  );

  // Step 7 — Run alpha signal detection (enriched with content data)
  await detectAlphaSignals(data, { tags: mergedTags, signals });
}
