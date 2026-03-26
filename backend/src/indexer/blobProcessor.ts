import { prisma } from "../database/db.js";
import { ShelbyRpcClient } from "../crawler/rpcClient.js";
import { extractMetadata } from "./metadataExtractor.js";
import { analyzeContent } from "./contentAnalyzer.js";
import { assignToCluster } from "./projectCluster.js";
import { detectAlphaSignals } from "./alphaDetector.js";
import type { BlobJobData } from "../types.js";

/** Shared RPC client instance for all blob processing */
const rpcClient = new ShelbyRpcClient();

/**
 * Blob Processor — with Content + Project Intelligence
 *
 * Pipeline:
 * 1. Dedup by owner+blobName
 * 2. Fetch blob content from Shelby RPC (best-effort, capped 300KB)
 * 3. Run content analyzer → tags, signals, preview
 * 4. Assign to project cluster
 * 5. Extract filename metadata
 * 6. Persist blob + enriched metadata + project_id to DB
 * 7. Trigger alpha signal detection (with cluster context)
 *
 * Content analysis + clustering never block indexing — failures are swallowed.
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
  const mergedTags = [...new Set([...metadata.tags, ...tags])];

  // Step 5 — Project Clustering (never blocks)
  let projectId: string | null = null;
  let clusterSize = 1;
  let isNewCluster = true;
  let projectLabel = "";

  try {
    const cluster = await assignToCluster(
      data.accountAddress,
      data.blobName,
      mergedTags,
      signals
    );
    projectId = cluster.projectId;
    clusterSize = cluster.clusterSize;
    isNewCluster = cluster.isNewCluster;
    projectLabel = cluster.projectLabel;

    if (clusterSize > 1) {
      console.log(`[Cluster] ${projectLabel}: ${clusterSize} blobs`);
    }
  } catch (error) {
    console.warn(
      `[Cluster] ⚠️ Clustering failed for ${blobId}:`,
      error instanceof Error ? error.message : error
    );
  }

  // Step 6 — Parse timestamp (Aptos timestamps are in microseconds)
  const createdAt =
    data.timestamp && data.timestamp !== "0"
      ? new Date(Number(data.timestamp) / 1000)
      : new Date();

  // Step 7 — Persist blob + enriched metadata + project_id
  await prisma.$transaction(async (tx) => {
    const blob = await tx.blob.create({
      data: {
        blobId,
        wallet: data.accountAddress,
        size,
        contentType,
        projectId,
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

  // Step 8 — Alpha signal detection (enriched with content + cluster data)
  await detectAlphaSignals(data, {
    tags: mergedTags,
    signals,
    projectId,
    clusterSize,
    isNewCluster,
    projectLabel,
  });
}
