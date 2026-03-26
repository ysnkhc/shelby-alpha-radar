import { prisma } from "../database/db.js";
import { alphaFeed, computePriority } from "../services/alphaFeed.js";
import type { BlobJobData } from "../types.js";

/**
 * Alpha Detection Module v4 — Behavioral + Content Intelligence
 *
 * Combines timing-based signals with content-derived intelligence:
 *
 * Timing signals:
 *   WALLET_VELOCITY, FIRST_TIME_BURST, DORMANT_REACTIVATION,
 *   CROSS_WALLET_PATTERN, RARE_FILE_TYPE
 *
 * Content signals (NEW):
 *   AI_COORDINATION, DATASET_CLUSTER, CONFIG_DEPLOYMENT
 */

const SCORE_THRESHOLD = 5;

/** Content intelligence passed from blobProcessor */
export interface ContentIntelligence {
  tags: string[];
  signals: string[];
}

export async function detectAlphaSignals(
  data: BlobJobData,
  content?: ContentIntelligence
): Promise<void> {
  try {
    const signals = await Promise.all([
      // Timing-based signals
      detectWalletVelocity(data),
      detectFirstTimeBurst(data),
      detectDormantReactivation(data),
      detectCrossWalletPattern(data),
      detectRareFileType(data),
      // Content-based signals (new)
      detectAICoordination(data, content),
      detectDatasetCluster(data, content),
      detectConfigDeployment(data, content),
    ]);

    const valid = signals.filter(
      (s): s is AlphaSignal => s !== null && s.score >= SCORE_THRESHOLD
    );

    if (valid.length > 0) {
      await prisma.alphaEvent.createMany({
        data: valid.map((s) => ({
          owner: data.accountAddress,
          blobName: data.blobName,
          signalType: s.type,
          score: s.score,
          priority: computePriority(s.score, s.type),
          explanation: s.explanation,
        })),
      });

      for (const s of valid) {
        const ownerAddr = data.accountAddress;
        const priority = computePriority(s.score, s.type);
        alphaFeed.broadcast({
          id: Date.now(),
          owner: ownerAddr,
          ownerShort: `${ownerAddr.slice(0, 8)}...${ownerAddr.slice(-4)}`,
          blobName: data.blobName,
          signalType: s.type,
          score: s.score,
          priority,
          explanation: s.explanation,
          impact: s.impact,
          context: s.context,
          timestamp: new Date().toISOString(),
        });

        console.log(`[SSE] Broadcasting: ${s.type} score=${s.score} priority=${priority}`);
      }
    }
  } catch (error) {
    console.warn(
      "⚠️  Alpha detection error:",
      error instanceof Error ? error.message : error
    );
  }
}

// ── Types ──────────────────────────────────────────────────────

interface AlphaSignal {
  type: string;
  score: number;
  explanation: string;
  impact: string;
  context: string;
}

// ═══════════════════════════════════════════════════════════════
// TIMING-BASED SIGNALS
// ═══════════════════════════════════════════════════════════════

// ── Rule 1: Wallet Velocity ────────────────────────────────────

async function detectWalletVelocity(
  data: BlobJobData
): Promise<AlphaSignal | null> {
  const now = new Date();
  const oneHourAgo = new Date(now.getTime() - 3_600_000);

  const [recentCount, totalCount] = await Promise.all([
    prisma.blob.count({
      where: { wallet: data.accountAddress, createdAt: { gte: oneHourAgo } },
    }),
    prisma.blob.count({
      where: { wallet: data.accountAddress },
    }),
  ]);

  if (totalCount < 3) return null;

  const firstBlob = await prisma.blob.findFirst({
    where: { wallet: data.accountAddress },
    orderBy: { createdAt: "asc" },
    select: { createdAt: true },
  });

  if (!firstBlob) return null;

  const historyHours = Math.max(
    1,
    (now.getTime() - firstBlob.createdAt.getTime()) / 3_600_000
  );
  const avgPerHour = totalCount / historyHours;

  if (avgPerHour > 0 && recentCount >= 3) {
    const multiplier = Math.round(recentCount / avgPerHour);
    if (multiplier >= 3) {
      const score = Math.min(10, 5 + multiplier);
      return {
        type: "WALLET_VELOCITY",
        score,
        explanation: `Wallet surged ${multiplier}x — ${recentCount} uploads in last hour`,
        impact: "Velocity spikes may indicate bots, automated pipelines, or migrations",
        context: `${recentCount}/hr vs avg ${avgPerHour.toFixed(1)}/hr · ${totalCount} all-time`,
      };
    }
  }

  return null;
}

// ── Rule 2: First-Time Burst ───────────────────────────────────

async function detectFirstTimeBurst(
  data: BlobJobData
): Promise<AlphaSignal | null> {
  const tenMinAgo = new Date(Date.now() - 10 * 60_000);

  const firstBlob = await prisma.blob.findFirst({
    where: { wallet: data.accountAddress },
    orderBy: { createdAt: "asc" },
    select: { createdAt: true },
  });

  if (!firstBlob || firstBlob.createdAt < tenMinAgo) return null;

  const totalCount = await prisma.blob.count({
    where: { wallet: data.accountAddress },
  });

  if (totalCount < 3) return null;

  const minsSinceFirst = Math.max(
    1,
    Math.round((Date.now() - firstBlob.createdAt.getTime()) / 60_000)
  );

  const score = Math.min(9, 5 + totalCount);
  return {
    type: "FIRST_TIME_BURST",
    score,
    explanation: `New wallet uploaded ${totalCount} blobs within ${minsSinceFirst} minutes`,
    impact: "First-time bursts suggest automated pipelines or programmatic uploads",
    context: `${totalCount} blobs in ${minsSinceFirst}min`,
  };
}

// ── Rule 3: Dormant Wallet Reactivation ────────────────────────

async function detectDormantReactivation(
  data: BlobJobData
): Promise<AlphaSignal | null> {
  const recentBlobs = await prisma.blob.findMany({
    where: { wallet: data.accountAddress },
    orderBy: { createdAt: "desc" },
    take: 2,
    select: { createdAt: true },
  });

  if (recentBlobs.length < 2) return null;

  const gapHours =
    (recentBlobs[0].createdAt.getTime() - recentBlobs[1].createdAt.getTime()) / 3_600_000;

  if (gapHours < 24) return null;

  const gapLabel = gapHours >= 72
    ? `${Math.round(gapHours / 24)} days`
    : `${Math.round(gapHours)} hours`;

  const score = Math.min(8, 5 + Math.floor(gapHours / 24));
  return {
    type: "DORMANT_REACTIVATION",
    score,
    explanation: `Dormant wallet reactivated after ${gapLabel} of silence`,
    impact: "Returning wallets signal renewed interest or reactivated automation",
    context: `Last upload: ${recentBlobs[1].createdAt.toISOString().slice(0, 10)} · Gap: ${gapLabel}`,
  };
}

// ── Rule 4: Cross-Wallet Pattern ───────────────────────────────

async function detectCrossWalletPattern(
  data: BlobJobData
): Promise<AlphaSignal | null> {
  const ext = extractExtension(data.blobName);
  if (!ext) return null;

  const twoMinAgo = new Date(Date.now() - 2 * 60_000);

  const recentSameType = await prisma.blob.findMany({
    where: {
      createdAt: { gte: twoMinAgo },
      metadata: { fileType: ext },
    },
    select: { wallet: true },
    distinct: ["wallet"],
  });

  const walletsIn2Min = recentSameType.length;
  if (walletsIn2Min < 3) return null;

  const score = Math.min(10, 6 + walletsIn2Min);
  return {
    type: "CROSS_WALLET_PATTERN",
    score,
    explanation: `${walletsIn2Min} wallets uploaded .${ext} files within 2 minutes`,
    impact: "Coordinated uploads indicate shared pipelines or distribution systems",
    context: `${walletsIn2Min} distinct wallets · file type: .${ext}`,
  };
}

// ── Rule 5: Rare File Type ─────────────────────────────────────

async function detectRareFileType(
  data: BlobJobData
): Promise<AlphaSignal | null> {
  const ext = extractExtension(data.blobName);
  if (!ext) return null;

  const common = new Set([
    "png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico",
    "txt", "csv", "json", "xml", "yaml", "yml", "toml",
    "pdf", "doc", "docx", "xls", "xlsx",
    "html", "css", "js", "ts", "md",
    "zip", "gz", "tar", "rar",
    "mp3", "mp4", "wav", "avi", "mov",
    "py", "rs", "go", "java", "c", "cpp", "h",
  ]);
  if (common.has(ext)) return null;

  const totalWithType = await prisma.blobMetadata.count({
    where: { fileType: ext },
  });
  if (totalWithType > 1) return null;

  return {
    type: "RARE_FILE_TYPE",
    score: 5,
    explanation: `First-ever .${ext} file uploaded on Shelby`,
    impact: "New file types may represent novel use cases or protocol experiments",
    context: `First .${ext} ever observed on network`,
  };
}

// ═══════════════════════════════════════════════════════════════
// CONTENT-BASED SIGNALS (NEW)
// ═══════════════════════════════════════════════════════════════

// ── Rule 6: AI Coordination ───────────────────────────────────

async function detectAICoordination(
  _data: BlobJobData,
  content?: ContentIntelligence
): Promise<AlphaSignal | null> {
  if (!content) return null;

  const hasAISignal = content.signals.some((s) =>
    ["ai_interaction", "model_data", "agent_config"].includes(s)
  );
  if (!hasAISignal) return null;

  // Check if multiple wallets uploaded AI-related content recently
  const fiveMinAgo = new Date(Date.now() - 5 * 60_000);

  const recentAIBlobs = await prisma.blobMetadata.findMany({
    where: {
      blob: { createdAt: { gte: fiveMinAgo } },
      signals: { hasSome: ["ai_interaction", "model_data", "agent_config"] },
    },
    include: { blob: { select: { wallet: true } } },
  });

  const uniqueWallets = new Set(recentAIBlobs.map((b) => b.blob.wallet));

  if (uniqueWallets.size < 2) return null;

  const signalTypes = [...new Set(recentAIBlobs.flatMap((b) => b.signals))];
  const score = Math.min(10, 7 + uniqueWallets.size);

  return {
    type: "AI_COORDINATION",
    score,
    explanation: `${uniqueWallets.size} wallets uploading AI content simultaneously`,
    impact: "Coordinated AI data uploads suggest multi-agent systems, shared model pipelines, or collaborative training",
    context: `${recentAIBlobs.length} AI blobs from ${uniqueWallets.size} wallets · signals: ${signalTypes.join(", ")}`,
  };
}

// ── Rule 7: Dataset Cluster ───────────────────────────────────

async function detectDatasetCluster(
  data: BlobJobData,
  content?: ContentIntelligence
): Promise<AlphaSignal | null> {
  if (!content) return null;
  if (!content.tags.includes("dataset")) return null;

  // Check for cluster of dataset uploads from same wallet
  const tenMinAgo = new Date(Date.now() - 10 * 60_000);

  const recentDatasets = await prisma.blobMetadata.count({
    where: {
      blob: {
        wallet: data.accountAddress,
        createdAt: { gte: tenMinAgo },
      },
      tags: { hasSome: ["dataset"] },
    },
  });

  if (recentDatasets < 3) return null;

  // Also check cross-wallet dataset activity
  const crossWalletDatasets = await prisma.blobMetadata.findMany({
    where: {
      blob: { createdAt: { gte: tenMinAgo } },
      tags: { hasSome: ["dataset"] },
    },
    include: { blob: { select: { wallet: true } } },
    take: 50,
  });

  const datasetWallets = new Set(crossWalletDatasets.map((b) => b.blob.wallet));

  const score = Math.min(10, 6 + recentDatasets);
  return {
    type: "DATASET_CLUSTER",
    score,
    explanation: `${recentDatasets} datasets uploaded by wallet in 10 minutes`,
    impact: "Dataset clusters indicate bulk data ingestion, training pipelines, or data migration",
    context: `${recentDatasets} datasets from this wallet · ${datasetWallets.size} wallets uploading datasets network-wide`,
  };
}

// ── Rule 8: Config Deployment ─────────────────────────────────

async function detectConfigDeployment(
  data: BlobJobData,
  content?: ContentIntelligence
): Promise<AlphaSignal | null> {
  if (!content) return null;

  const hasConfig = content.tags.includes("config") ||
    content.signals.includes("agent_config");
  if (!hasConfig) return null;

  // Check if this wallet recently uploaded related AI/trading content
  const oneHourAgo = new Date(Date.now() - 3_600_000);

  const recentWalletBlobs = await prisma.blobMetadata.findMany({
    where: {
      blob: {
        wallet: data.accountAddress,
        createdAt: { gte: oneHourAgo },
      },
    },
    select: { tags: true, signals: true },
  });

  // Config is interesting when combined with AI or trading data
  const hasAI = recentWalletBlobs.some((b) =>
    b.tags.includes("ai_data") || b.signals.some((s) => s.includes("ai"))
  );
  const hasTrading = recentWalletBlobs.some((b) =>
    b.signals.includes("trading_data")
  );

  if (!hasAI && !hasTrading) return null;

  const context = hasAI && hasTrading
    ? "AI + trading config deployment"
    : hasAI
      ? "AI system config deployment"
      : "trading config deployment";

  const score = Math.min(10, 7 + recentWalletBlobs.length);
  return {
    type: "CONFIG_DEPLOYMENT",
    score,
    explanation: `Config file deployed alongside ${hasAI ? "AI" : ""}${hasAI && hasTrading ? " + " : ""}${hasTrading ? "trading" : ""} data`,
    impact: "Config deployments with AI/trading data suggest live system launches or strategy updates",
    context: `${context} · ${recentWalletBlobs.length} related blobs in last hour`,
  };
}

// ── Helpers ────────────────────────────────────────────────────

function extractExtension(blobName: string): string | null {
  const name = blobName.startsWith("@")
    ? blobName.replace(/^@[^/]+\//, "")
    : blobName;

  const ext = name.split(".").pop()?.toLowerCase();
  if (!ext || ext === name.toLowerCase()) return null;
  return ext;
}
