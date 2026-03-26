import { prisma } from "../database/db.js";
import { alphaFeed, computePriority } from "../services/alphaFeed.js";
import type { BlobJobData } from "../types.js";

/**
 * Alpha Detection Module v5 — Project Discovery Intelligence
 *
 * Shift from "event detection" → "project discovery"
 *
 * Scoring philosophy:
 *   - HIGH (8-10): Only truly rare, coordinated, or multi-signal events
 *   - MEDIUM (6-7): Interesting patterns worth watching
 *   - LOW (5): Routine observations
 *
 * Signal groups:
 *   Timing:   WALLET_VELOCITY, DORMANT_REACTIVATION
 *   Content:  AI_COORDINATION, CONFIG_DEPLOYMENT
 *   Project:  PROJECT_CLUSTER_DETECTED, AI_PROJECT_ACTIVITY, DATASET_FORMATION
 *   Rare:     RARE_FILE_TYPE
 */

const SCORE_THRESHOLD = 5;

/** Content + cluster intelligence passed from blobProcessor */
export interface ContentIntelligence {
  tags: string[];
  signals: string[];
  projectId: string | null;
  clusterSize: number;
  isNewCluster: boolean;
  projectLabel: string;
}

export async function detectAlphaSignals(
  data: BlobJobData,
  content?: ContentIntelligence
): Promise<void> {
  try {
    const signals = await Promise.all([
      // Timing-based (rebalanced)
      detectWalletVelocity(data),
      detectDormantReactivation(data),
      // Content-based
      detectAICoordination(data, content),
      detectConfigDeployment(data, content),
      // Project-based (NEW)
      detectProjectCluster(data, content),
      detectAIProjectActivity(data, content),
      detectDatasetFormation(data, content),
      // Rare (kept)
      detectRareFileType(data),
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

        console.log(`[Alpha] ${s.type} score=${s.score} → ${priority}: ${s.explanation}`);
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
// TIMING SIGNALS (rebalanced — harder to trigger HIGH)
// ═══════════════════════════════════════════════════════════════

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

  if (totalCount < 5) return null; // raised from 3 → 5

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

  if (avgPerHour > 0 && recentCount >= 5) { // raised from 3 → 5
    const multiplier = Math.round(recentCount / avgPerHour);
    if (multiplier >= 5) { // raised from 3 → 5
      // Score: 5-8 max (was 5-10)
      const score = Math.min(8, 4 + Math.floor(multiplier / 2));
      return {
        type: "WALLET_VELOCITY",
        score,
        explanation: `Wallet ${data.accountAddress.slice(0, 8)}... is uploading ${multiplier}x faster than usual — ${recentCount} files in the last hour, suggesting an automated pipeline or bulk migration`,
        impact: "Sustained velocity spikes often precede project launches or large-scale data operations",
        context: `${recentCount}/hr vs avg ${avgPerHour.toFixed(1)}/hr · ${totalCount} total blobs`,
      };
    }
  }

  return null;
}

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

  if (gapHours < 48) return null; // raised from 24h → 48h

  const gapLabel = gapHours >= 72
    ? `${Math.round(gapHours / 24)} days`
    : `${Math.round(gapHours)} hours`;

  // Score: 5-7 max (was 5-8)
  const score = Math.min(7, 5 + Math.floor(gapHours / 48));
  return {
    type: "DORMANT_REACTIVATION",
    score,
    explanation: `A wallet that was silent for ${gapLabel} just uploaded "${data.blobName.split("/").pop()}" — this could signal a returning project or reactivated automation`,
    impact: "Dormant wallets returning to activity often indicate renewed development or delayed project milestones",
    context: `Last seen: ${recentBlobs[1].createdAt.toISOString().slice(0, 10)} · Silent for ${gapLabel}`,
  };
}

// ═══════════════════════════════════════════════════════════════
// CONTENT SIGNALS (rebalanced)
// ═══════════════════════════════════════════════════════════════

async function detectAICoordination(
  _data: BlobJobData,
  content?: ContentIntelligence
): Promise<AlphaSignal | null> {
  if (!content) return null;

  const hasAISignal = content.signals.some((s) =>
    ["ai_interaction", "model_data", "agent_config"].includes(s)
  );
  if (!hasAISignal) return null;

  const fiveMinAgo = new Date(Date.now() - 5 * 60_000);

  const recentAIBlobs = await prisma.blobMetadata.findMany({
    where: {
      blob: { createdAt: { gte: fiveMinAgo } },
      signals: { hasSome: ["ai_interaction", "model_data", "agent_config"] },
    },
    include: { blob: { select: { wallet: true } } },
  });

  const uniqueWallets = new Set(recentAIBlobs.map((b) => b.blob.wallet));
  if (uniqueWallets.size < 3) return null; // raised from 2 → 3

  const signalTypes = [...new Set(recentAIBlobs.flatMap((b) => b.signals))];
  // Score: 7-9 (high value — truly coordinated AI)
  const score = Math.min(9, 6 + uniqueWallets.size);

  return {
    type: "AI_COORDINATION",
    score,
    explanation: `${uniqueWallets.size} different wallets are uploading AI-related content simultaneously — possible multi-agent coordination, shared model training, or collaborative AI infrastructure`,
    impact: "Cross-wallet AI activity is rare and high-signal, suggesting organized AI development on Shelby",
    context: `${recentAIBlobs.length} AI blobs from ${uniqueWallets.size} wallets in 5min · signals: ${signalTypes.join(", ")}`,
  };
}

async function detectConfigDeployment(
  data: BlobJobData,
  content?: ContentIntelligence
): Promise<AlphaSignal | null> {
  if (!content) return null;

  const hasConfig = content.tags.includes("config") || content.signals.includes("agent_config");
  if (!hasConfig) return null;

  const oneHourAgo = new Date(Date.now() - 3_600_000);

  const recentWalletBlobs = await prisma.blobMetadata.findMany({
    where: {
      blob: { wallet: data.accountAddress, createdAt: { gte: oneHourAgo } },
    },
    select: { tags: true, signals: true },
  });

  const hasAI = recentWalletBlobs.some((b) =>
    b.tags.includes("ai_data") || b.signals.some((s: string) => s.includes("ai"))
  );
  const hasTrading = recentWalletBlobs.some((b) =>
    b.signals.includes("trading_data")
  );

  if (!hasAI && !hasTrading) return null;

  const domain = hasAI && hasTrading ? "AI + trading" : hasAI ? "AI" : "trading";
  // Score: 6-7 (MEDIUM — interesting but needs cluster confirmation)
  const score = Math.min(7, 5 + recentWalletBlobs.length);

  return {
    type: "CONFIG_DEPLOYMENT",
    score,
    explanation: `A ${domain} configuration file was deployed alongside ${recentWalletBlobs.length} related data uploads — this looks like a live system launch or strategy update`,
    impact: "Config files paired with domain-specific data often mark deployment milestones or strategy pivots",
    context: `${domain} config deployment · ${recentWalletBlobs.length} related blobs in last hour`,
  };
}

// ═══════════════════════════════════════════════════════════════
// PROJECT SIGNALS (NEW — highest value)
// ═══════════════════════════════════════════════════════════════

async function detectProjectCluster(
  _data: BlobJobData,
  content?: ContentIntelligence
): Promise<AlphaSignal | null> {
  if (!content?.projectId) return null;

  // Only fire when cluster reaches meaningful sizes
  const milestones = [3, 5, 10, 20, 50];
  const size = content.clusterSize;
  if (!milestones.includes(size)) return null;

  // Check if we already fired for this milestone
  const alreadyFired = await prisma.alphaEvent.findFirst({
    where: {
      signalType: "PROJECT_CLUSTER_DETECTED",
      explanation: { contains: `${size} files` },
      owner: _data.accountAddress,
    },
  });
  if (alreadyFired) return null;

  // Score scales with cluster size: 5 (3 files) → 9 (50 files)
  const scoreMap: Record<number, number> = { 3: 5, 5: 6, 10: 7, 20: 8, 50: 9 };
  const score = scoreMap[size] ?? 5;

  return {
    type: "PROJECT_CLUSTER_DETECTED",
    score,
    explanation: `${content.projectLabel} now has ${size} files — a structured project is forming on-chain with consistent naming and content patterns`,
    impact: "Clusters of related files indicate organized development projects, not random uploads",
    context: `Project: ${content.projectLabel} · ${size} files clustered`,
  };
}

async function detectAIProjectActivity(
  _data: BlobJobData,
  content?: ContentIntelligence
): Promise<AlphaSignal | null> {
  if (!content?.projectId) return null;
  if (!content.tags.some((t) => t === "ai_data")) return null;

  // Need at least 3 AI files in the project
  if (content.clusterSize < 3) return null;

  // Check for multiple AI signal types within the project
  const projectBlobs = await prisma.blobMetadata.findMany({
    where: {
      blob: { projectId: content.projectId },
      tags: { hasSome: ["ai_data"] },
    },
    select: { signals: true, fileType: true },
  });

  const allSignals = new Set(projectBlobs.flatMap((b) => b.signals));
  const allTypes = new Set(projectBlobs.map((b) => b.fileType).filter(Boolean));

  // Needs diversity — multiple signal types or file types
  if (allSignals.size < 2 && allTypes.size < 2) return null;

  // Deduplicate — only fire once per project
  const existing = await prisma.alphaEvent.findFirst({
    where: {
      signalType: "AI_PROJECT_ACTIVITY",
      owner: _data.accountAddress,
      explanation: { contains: content.projectId ?? "" },
    },
  });
  if (existing) return null;

  // Score: 7-9 (high value — confirmed AI project)
  const score = Math.min(9, 6 + allSignals.size);

  const signalList = [...allSignals].join(", ");
  const typeList = [...allTypes].join(", ");

  return {
    type: "AI_PROJECT_ACTIVITY",
    score,
    explanation: `An AI project is actively developing: ${content.projectLabel} contains ${projectBlobs.length} AI-related files with ${allSignals.size} different signal types (${signalList}), spanning file types: ${typeList}`,
    impact: "Multi-file AI projects with diverse signals indicate active model development, agent deployment, or training infrastructure",
    context: `Project: ${content.projectId} · ${projectBlobs.length} AI files · signals: ${signalList}`,
  };
}

async function detectDatasetFormation(
  data: BlobJobData,
  content?: ContentIntelligence
): Promise<AlphaSignal | null> {
  if (!content?.projectId) return null;
  if (!content.tags.includes("dataset")) return null;
  if (content.clusterSize < 3) return null;

  // Count dataset files in this project
  const datasetCount = await prisma.blobMetadata.count({
    where: {
      blob: { projectId: content.projectId },
      tags: { hasSome: ["dataset"] },
    },
  });

  if (datasetCount < 3) return null;

  // Only fire at milestones
  const milestones = [3, 5, 10, 25];
  if (!milestones.includes(datasetCount)) return null;

  // Deduplicate
  const existing = await prisma.alphaEvent.findFirst({
    where: {
      signalType: "DATASET_FORMATION",
      owner: data.accountAddress,
      explanation: { contains: `${datasetCount} dataset` },
    },
  });
  if (existing) return null;

  // Score: 6-8 (structured data accumulation)
  const scoreMap: Record<number, number> = { 3: 6, 5: 7, 10: 8, 25: 9 };
  const score = scoreMap[datasetCount] ?? 6;

  return {
    type: "DATASET_FORMATION",
    score,
    explanation: `A dataset is forming: ${content.projectLabel} now contains ${datasetCount} data files — this wallet is building a structured data collection on Shelby`,
    impact: "Systematic dataset accumulation suggests training data preparation, market analysis, or research data archiving",
    context: `Project: ${content.projectId} · ${datasetCount} dataset files`,
  };
}

// ═══════════════════════════════════════════════════════════════
// RARE SIGNALS (kept, slightly boosted)
// ═══════════════════════════════════════════════════════════════

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

  // Higher value for specialized file types
  const highValue = new Set(["ckpt", "safetensors", "onnx", "pt", "h5", "rosbag", "fastq", "parquet", "arrow"]);
  const score = highValue.has(ext) ? 7 : 5;

  const description = highValue.has(ext)
    ? `A specialized .${ext} file appeared on Shelby for the first time — this is a high-value format used in ${getFormatDomain(ext)}`
    : `First-ever .${ext} file uploaded to Shelby — a new file format is entering the ecosystem`;

  return {
    type: "RARE_FILE_TYPE",
    score,
    explanation: description,
    impact: "Novel file types expand the Shelby ecosystem and may indicate new use cases or specialized workflows",
    context: `First .${ext} ever observed · format: ${getFormatDomain(ext)}`,
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

function getFormatDomain(ext: string): string {
  const domains: Record<string, string> = {
    ckpt: "ML model checkpoints",
    safetensors: "ML model weights (HuggingFace)",
    onnx: "ML inference models",
    pt: "PyTorch models",
    h5: "Keras/HDF5 models",
    rosbag: "robotics sensor data (ROS)",
    fastq: "genomics sequencing data",
    parquet: "columnar analytics data",
    arrow: "Apache Arrow columnar data",
    tfrecord: "TensorFlow training data",
    npy: "NumPy arrays",
    feather: "fast dataframe storage",
  };
  return domains[ext] ?? "specialized data";
}
