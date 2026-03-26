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
 * Blob Processor — Global Project Intelligence
 *
 * Pipeline:
 * 1. Dedup by owner+blobName
 * 2. Fetch blob content (best-effort, ≤300KB, text-only)
 * 3. Content analysis → tags, signals, preview
 * 4. Global project clustering (cross-wallet)
 * 5. Filename metadata extraction
 * 6. Persist blob + metadata + project_id
 * 7. Alpha signal detection (with full project context)
 */
export async function processBlob(data: BlobJobData): Promise<void> {
  const blobId = `${data.accountAddress}:${data.blobName}`;

  // 1 — Dedup
  const existing = await prisma.blob.findUnique({ where: { blobId } });
  if (existing) return;

  // 2 — Fetch content
  let size = BigInt(0);
  let contentType: string | null = null;
  let contentBuffer: Buffer | null = null;

  try {
    const result = await rpcClient.fetchBlobContent(data.accountAddress, data.blobName);
    if (result) {
      size = BigInt(result.size ?? 0);
      contentType = result.contentType ?? null;
      contentBuffer = result.buffer;
    }
  } catch (error) {
    console.warn(`[RPC] ⚠️ ${blobId}:`, error instanceof Error ? error.message : error);
  }

  // 3 — Content intelligence
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
  } catch (error) {
    analysisStatus = "error";
    console.warn(`[Content] ⚠️ ${blobId}:`, error instanceof Error ? error.message : error);
  }

  // 4 — Filename metadata
  const metadata = extractMetadata(data);
  const mergedTags = [...new Set([...metadata.tags, ...tags])];

  // 5 — Global project clustering
  let projectId: string | null = null;
  let clusterSize = 1;
  let walletCount = 1;
  let isNewCluster = true;
  let isNewWallet = true;
  let growthRate = 0;
  let projectLabel = "";

  try {
    const cluster = await assignToCluster(
      data.accountAddress,
      data.blobName,
      mergedTags,
      signals,
      metadata.fileType
    );
    projectId = cluster.projectId;
    clusterSize = cluster.clusterSize;
    walletCount = cluster.walletCount;
    isNewCluster = cluster.isNewCluster;
    isNewWallet = cluster.isNewWallet;
    growthRate = cluster.growthRate;
    projectLabel = cluster.projectLabel;

    if (clusterSize > 1 || walletCount > 1) {
      console.log(`[Project] ${projectLabel}: ${clusterSize} blobs, ${walletCount} wallets`);
    }
  } catch (error) {
    console.warn(`[Cluster] ⚠️ ${blobId}:`, error instanceof Error ? error.message : error);
  }

  // 6 — Persist
  const createdAt = data.timestamp && data.timestamp !== "0"
    ? new Date(Number(data.timestamp) / 1000)
    : new Date();

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
    `[DB] ✅ ${data.accountAddress.slice(0, 8)}.../${data.blobName.split("/").pop()} (block ${data.blockHeight})`
  );

  // 7 — Alpha signals
  await detectAlphaSignals(data, {
    tags: mergedTags,
    signals,
    projectId,
    clusterSize,
    walletCount,
    isNewCluster,
    isNewWallet,
    growthRate,
    projectLabel,
  });
}
