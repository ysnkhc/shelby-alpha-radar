import { prisma } from "../database/db.js";
import { alphaFeed, computePriority } from "../services/alphaFeed.js";
import type { BlobJobData } from "../types.js";

/**
 * Alpha Detection Module v6 — Global Project Intelligence
 *
 * "project intelligence" — not just events, but understanding.
 *
 * SCORE_THRESHOLD raised to 7: only high-value signals surface.
 * Priority: multi-wallet + structured content >> single-wallet noise.
 *
 * Signal groups:
 *   Project:  MULTI_WALLET_PROJECT, PROJECT_GROWTH
 *   AI:       AI_TRAINING, AI_INFERENCE, AGENT_DEPLOYMENT
 *   Data:     DATA_PIPELINE, DATASET_FORMATION
 *   Rare:     RARE_FILE_TYPE (specialized formats only)
 */

const SCORE_THRESHOLD = 7;

/** Full project context from blobProcessor */
export interface ContentIntelligence {
  tags: string[];
  signals: string[];
  projectId: string | null;
  clusterSize: number;
  walletCount: number;
  isNewCluster: boolean;
  isNewWallet: boolean;
  growthRate: number;
  projectLabel: string;
}

export async function detectAlphaSignals(
  data: BlobJobData,
  content?: ContentIntelligence
): Promise<void> {
  try {
    const signals = await Promise.all([
      // Project signals (highest value)
      detectMultiWalletProject(data, content),
      detectProjectGrowth(data, content),
      // AI signals
      detectAITraining(data, content),
      detectAIInference(data, content),
      detectAgentDeployment(data, content),
      // Data signals
      detectDataPipeline(data, content),
      detectDatasetFormation(data, content),
      // Rare
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
        const owner = data.accountAddress;
        const priority = computePriority(s.score, s.type);
        alphaFeed.broadcast({
          id: Date.now(),
          owner,
          ownerShort: `${owner.slice(0, 8)}...${owner.slice(-4)}`,
          blobName: data.blobName,
          signalType: s.type,
          score: s.score,
          priority,
          explanation: s.explanation,
          impact: s.impact,
          context: s.context,
          timestamp: new Date().toISOString(),
        });

        console.log(`[Alpha] ${priority} ${s.type}: ${s.explanation.slice(0, 100)}`);
      }
    }
  } catch (error) {
    console.warn("⚠️ Alpha detection error:", error instanceof Error ? error.message : error);
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
// PROJECT SIGNALS — multi-wallet intelligence
// ═══════════════════════════════════════════════════════════════

/**
 * MULTI_WALLET_PROJECT: fires when a second+ wallet joins a project.
 * This is THE highest signal — two unrelated wallets converging on
 * the same naming pattern + content type is extremely meaningful.
 */
async function detectMultiWalletProject(
  _data: BlobJobData,
  content?: ContentIntelligence
): Promise<AlphaSignal | null> {
  if (!content?.projectId) return null;
  if (content.walletCount < 2) return null;
  if (!content.isNewWallet) return null; // only fire once per new wallet joining

  // Score scales: 8 (2 wallets) → 10 (4+ wallets)
  const score = Math.min(10, 7 + content.walletCount);

  return {
    type: "MULTI_WALLET_PROJECT",
    score,
    explanation: `${content.projectLabel} — a new wallet joined this project, making it a ${content.walletCount}-wallet collaborative effort with ${content.clusterSize} total files`,
    impact: "Multiple wallets contributing to the same project indicates coordinated development, shared infrastructure, or collaborative workflows",
    context: `${content.walletCount} wallets · ${content.clusterSize} files · growth: ${content.growthRate}/hr`,
  };
}

/**
 * PROJECT_GROWTH: fires when a project reaches size milestones with high growth.
 */
async function detectProjectGrowth(
  data: BlobJobData,
  content?: ContentIntelligence
): Promise<AlphaSignal | null> {
  if (!content?.projectId) return null;

  const milestones = [5, 10, 25, 50, 100];
  if (!milestones.includes(content.clusterSize)) return null;

  // Dedup per milestone
  const exists = await prisma.alphaEvent.findFirst({
    where: {
      signalType: "PROJECT_GROWTH",
      owner: data.accountAddress,
      explanation: { contains: `${content.clusterSize} files` },
    },
  });
  if (exists) return null;

  // Score: 7 (5 files) → 10 (100 files)
  const scoreMap: Record<number, number> = { 5: 7, 10: 8, 25: 9, 50: 9, 100: 10 };
  const score = scoreMap[content.clusterSize] ?? 7;

  const multiWallet = content.walletCount > 1
    ? ` across ${content.walletCount} wallets`
    : "";

  return {
    type: "PROJECT_GROWTH",
    score,
    explanation: `${content.projectLabel} reached ${content.clusterSize} files${multiWallet} — this is an actively growing project with ${content.growthRate} uploads/hour`,
    impact: "Large, growing projects represent significant on-chain activity and sustained development effort",
    context: `${content.clusterSize} files · ${content.walletCount} wallets · ${content.growthRate}/hr`,
  };
}

// ═══════════════════════════════════════════════════════════════
// AI SIGNALS — specialized intelligence detection
// ═══════════════════════════════════════════════════════════════

/**
 * AI_TRAINING: detects model training data/weights being uploaded.
 */
async function detectAITraining(
  _data: BlobJobData,
  content?: ContentIntelligence
): Promise<AlphaSignal | null> {
  if (!content?.projectId) return null;

  const trainingSignals = content.signals.filter((s) =>
    ["model_data"].includes(s)
  );
  if (trainingSignals.length === 0) return null;
  if (content.clusterSize < 2) return null;

  // Check project has training-related file types
  const project = await prisma.project.findUnique({
    where: { id: content.projectId },
  });
  if (!project) return null;

  const trainingTypes = new Set(["ckpt", "pt", "h5", "safetensors", "onnx", "npy", "tfrecord"]);
  const hasTrainingFiles = project.fileTypes.some((t) => trainingTypes.has(t));
  const hasDataFiles = project.tags.includes("dataset");

  if (!hasTrainingFiles && !hasDataFiles) return null;

  // Dedup per project
  const exists = await prisma.alphaEvent.findFirst({
    where: { signalType: "AI_TRAINING", explanation: { contains: content.projectId ?? "" } },
  });
  if (exists) return null;

  const score = hasTrainingFiles ? 9 : 8;

  return {
    type: "AI_TRAINING",
    score,
    explanation: `Active AI training detected in ${content.projectLabel} — ${hasTrainingFiles ? "model weights" : "training datasets"} are being uploaded alongside ${project.blobCount} related files`,
    impact: "AI model training on-chain represents advanced usage of decentralized storage for ML workflows",
    context: `Project: ${content.projectId} · types: ${project.fileTypes.join(", ")} · ${project.blobCount} files`,
  };
}

/**
 * AI_INFERENCE: detects inference/prediction data patterns.
 */
async function detectAIInference(
  _data: BlobJobData,
  content?: ContentIntelligence
): Promise<AlphaSignal | null> {
  if (!content?.projectId) return null;
  if (!content.signals.includes("ai_interaction")) return null;
  if (content.clusterSize < 3) return null;

  // Look for rapid succession of AI interaction files (inference pattern)
  const fiveMinAgo = new Date(Date.now() - 5 * 60_000);
  const recentAIBlobs = await prisma.blobMetadata.count({
    where: {
      blob: { projectId: content.projectId, createdAt: { gte: fiveMinAgo } },
      signals: { hasSome: ["ai_interaction"] },
    },
  });

  if (recentAIBlobs < 3) return null;

  // Dedup
  const exists = await prisma.alphaEvent.findFirst({
    where: { signalType: "AI_INFERENCE", createdAt: { gte: fiveMinAgo } },
  });
  if (exists) return null;

  const score = Math.min(9, 7 + Math.floor(recentAIBlobs / 3));

  return {
    type: "AI_INFERENCE",
    score,
    explanation: `AI inference pipeline active — ${recentAIBlobs} AI interaction results uploaded to ${content.projectLabel} in the last 5 minutes, suggesting real-time model predictions`,
    impact: "Rapid AI inference outputs indicate a live AI system processing data through on-chain storage",
    context: `${recentAIBlobs} AI blobs in 5min · project: ${content.projectId}`,
  };
}

/**
 * AGENT_DEPLOYMENT: detects autonomous agent configuration uploads.
 */
async function detectAgentDeployment(
  _data: BlobJobData,
  content?: ContentIntelligence
): Promise<AlphaSignal | null> {
  if (!content?.projectId) return null;
  if (!content.signals.includes("agent_config")) return null;

  // An agent deployment is config + at least one other signal type
  const project = await prisma.project.findUnique({
    where: { id: content.projectId },
  });
  if (!project) return null;

  const hasAI = project.signals.includes("ai_interaction") || project.signals.includes("model_data");
  const hasTrading = project.signals.includes("trading_data");

  if (!hasAI && !hasTrading) return null;

  // Dedup per project
  const exists = await prisma.alphaEvent.findFirst({
    where: { signalType: "AGENT_DEPLOYMENT", explanation: { contains: content.projectId ?? "" } },
  });
  if (exists) return null;

  const domain = hasAI && hasTrading ? "AI + trading" : hasAI ? "AI" : "trading";
  const score = content.walletCount > 1 ? 9 : 8;

  return {
    type: "AGENT_DEPLOYMENT",
    score,
    explanation: `Autonomous ${domain} agent deployed — ${content.projectLabel} contains agent configs alongside ${domain} data, indicating a self-operating system launch`,
    impact: "Agent deployments with domain-specific data represent sophisticated automated systems on Shelby",
    context: `${domain} agent · project: ${content.projectId} · ${project.blobCount} files`,
  };
}

// ═══════════════════════════════════════════════════════════════
// DATA SIGNALS
// ═══════════════════════════════════════════════════════════════

/**
 * DATA_PIPELINE: detects structured data flows (multiple datasets in sequence).
 */
async function detectDataPipeline(
  data: BlobJobData,
  content?: ContentIntelligence
): Promise<AlphaSignal | null> {
  if (!content?.projectId) return null;
  if (!content.tags.includes("dataset")) return null;
  if (content.growthRate < 2) return null; // needs sustained upload rate

  // Multiple dataset files uploading rapidly = data pipeline
  const tenMinAgo = new Date(Date.now() - 10 * 60_000);
  const recentDatasets = await prisma.blobMetadata.count({
    where: {
      blob: { projectId: content.projectId, createdAt: { gte: tenMinAgo } },
      tags: { hasSome: ["dataset"] },
    },
  });

  if (recentDatasets < 3) return null;

  // Dedup per 10min window
  const exists = await prisma.alphaEvent.findFirst({
    where: {
      signalType: "DATA_PIPELINE",
      owner: data.accountAddress,
      createdAt: { gte: tenMinAgo },
    },
  });
  if (exists) return null;

  const multiWallet = content.walletCount > 1
    ? ` from ${content.walletCount} wallets`
    : "";

  const score = Math.min(9, 7 + Math.floor(recentDatasets / 3));

  return {
    type: "DATA_PIPELINE",
    score,
    explanation: `Active data pipeline detected — ${recentDatasets} datasets uploaded to ${content.projectLabel}${multiWallet} in 10 minutes at ${content.growthRate} files/hour`,
    impact: "Sustained data upload rates indicate ETL pipelines, data ingestion systems, or automated archiving",
    context: `${recentDatasets} datasets in 10min · ${content.growthRate}/hr · project: ${content.projectId}`,
  };
}

/**
 * DATASET_FORMATION: fires at dataset size milestones.
 */
async function detectDatasetFormation(
  data: BlobJobData,
  content?: ContentIntelligence
): Promise<AlphaSignal | null> {
  if (!content?.projectId) return null;
  if (!content.tags.includes("dataset")) return null;

  const milestones = [5, 10, 25, 50];
  const datasetCount = await prisma.blobMetadata.count({
    where: {
      blob: { projectId: content.projectId },
      tags: { hasSome: ["dataset"] },
    },
  });

  if (!milestones.includes(datasetCount)) return null;

  // Dedup
  const exists = await prisma.alphaEvent.findFirst({
    where: {
      signalType: "DATASET_FORMATION",
      owner: data.accountAddress,
      explanation: { contains: `${datasetCount} data files` },
    },
  });
  if (exists) return null;

  const scoreMap: Record<number, number> = { 5: 7, 10: 8, 25: 9, 50: 10 };
  const score = scoreMap[datasetCount] ?? 7;

  return {
    type: "DATASET_FORMATION",
    score,
    explanation: `Large dataset forming — ${content.projectLabel} now contains ${datasetCount} data files, indicating systematic data collection or training preparation`,
    impact: "Structured dataset accumulation at scale suggests ML training data, analytics pipelines, or research archives",
    context: `${datasetCount} dataset files · project: ${content.projectId}`,
  };
}

// ═══════════════════════════════════════════════════════════════
// RARE SIGNALS — specialized format detection
// ═══════════════════════════════════════════════════════════════

async function detectRareFileType(
  data: BlobJobData
): Promise<AlphaSignal | null> {
  const ext = extractExtension(data.blobName);
  if (!ext) return null;

  // Only fire for genuinely rare, high-value formats
  const highValue: Record<string, string> = {
    ckpt: "ML model checkpoints",
    safetensors: "ML model weights (HuggingFace format)",
    onnx: "ML inference models (ONNX runtime)",
    pt: "PyTorch model weights",
    h5: "Keras/HDF5 trained models",
    rosbag: "robotics sensor data (ROS)",
    fastq: "genomics sequencing data",
    parquet: "columnar analytics data (Apache Parquet)",
    arrow: "columnar data (Apache Arrow)",
    tfrecord: "TensorFlow training records",
    npy: "NumPy binary arrays",
    feather: "fast dataframe storage",
  };

  if (!highValue[ext]) return null;

  const totalWithType = await prisma.blobMetadata.count({
    where: { fileType: ext },
  });
  if (totalWithType > 1) return null;

  return {
    type: "RARE_FILE_TYPE",
    score: 7,
    explanation: `First-ever .${ext} file on Shelby — ${highValue[ext]}. This specialized format indicates advanced ${ext.match(/ckpt|safetensors|onnx|pt|h5|tfrecord|npy/) ? "AI/ML" : "data engineering"} workflows`,
    impact: "Specialized file formats represent new capability frontiers on Shelby's decentralized storage",
    context: `Format: .${ext} · domain: ${highValue[ext]}`,
  };
}

// ── Helpers ────────────────────────────────────────────────────

function extractExtension(blobName: string): string | null {
  const name = blobName.startsWith("@") ? blobName.replace(/^@[^/]+\//, "") : blobName;
  const ext = name.split(".").pop()?.toLowerCase();
  if (!ext || ext === name.toLowerCase()) return null;
  return ext;
}
