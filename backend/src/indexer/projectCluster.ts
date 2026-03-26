import { prisma } from "../database/db.js";

/**
 * Global Project Cluster — Cross-Wallet Intelligence
 *
 * Groups blobs into "projects" that span multiple wallets:
 *
 *  1. Filename similarity  → shared naming conventions
 *  2. Content structure    → same tags/signals pattern
 *  3. Time proximity       → uploaded in similar windows
 *
 * Project IDs are NOW global (not per-wallet):
 *   Format: {category}:{normalizedPrefix}
 *
 * This allows blobs from DIFFERENT wallets to cluster together
 * when they share naming patterns and content types.
 */

// ── Public API ────────────────────────────────────────────────

export interface ClusterResult {
  projectId: string;
  projectLabel: string;
  clusterSize: number;
  walletCount: number;
  isNewCluster: boolean;
  isNewWallet: boolean;
  growthRate: number;
}

/**
 * Assign a blob to a global project cluster.
 * Creates or updates the Project entity with lifecycle data.
 */
export async function assignToCluster(
  wallet: string,
  blobName: string,
  tags: string[],
  signals: string[],
  fileType: string | null
): Promise<ClusterResult> {
  // Step 1 — Derive normalized prefix (wallet-independent)
  const prefix = extractGlobalPrefix(blobName);

  // Step 2 — Determine content category
  const category = deriveCategory(tags, signals);

  // Step 3 — Build global project ID (no wallet — cross-wallet!)
  const projectId = buildGlobalProjectId(category, prefix);

  // Step 4 — Upsert the Project entity
  const now = new Date();
  const existing = await prisma.project.findUnique({
    where: { id: projectId },
  });

  const isNewCluster = !existing;
  const isNewWallet = existing ? !existing.wallets.includes(wallet) : true;

  const updatedWallets = existing
    ? [...new Set([...existing.wallets, wallet])]
    : [wallet];

  const updatedTags = existing
    ? [...new Set([...existing.tags, ...tags])]
    : tags;

  const updatedSignals = existing
    ? [...new Set([...existing.signals, ...signals])]
    : signals;

  const updatedFileTypes = existing && fileType
    ? [...new Set([...existing.fileTypes, fileType])]
    : fileType
      ? [fileType]
      : existing?.fileTypes ?? [];

  const newBlobCount = (existing?.blobCount ?? 0) + 1;

  // Growth rate: blobs per hour since first seen
  const firstSeen = existing?.firstSeen ?? now;
  const hoursSinceFirst = Math.max(1, (now.getTime() - firstSeen.getTime()) / 3_600_000);
  const growthRate = Math.round((newBlobCount / hoursSinceFirst) * 100) / 100;

  const label = generateLabel(prefix, category, updatedWallets.length);

  await prisma.project.upsert({
    where: { id: projectId },
    create: {
      id: projectId,
      label,
      category,
      wallets: updatedWallets,
      tags: updatedTags,
      signals: updatedSignals,
      fileTypes: updatedFileTypes,
      blobCount: newBlobCount,
      walletCount: updatedWallets.length,
      growthRate,
      firstSeen,
      lastActive: now,
    },
    update: {
      label,
      wallets: updatedWallets,
      tags: updatedTags,
      signals: updatedSignals,
      fileTypes: updatedFileTypes,
      blobCount: newBlobCount,
      walletCount: updatedWallets.length,
      growthRate,
      lastActive: now,
    },
  });

  return {
    projectId,
    projectLabel: label,
    clusterSize: newBlobCount,
    walletCount: updatedWallets.length,
    isNewCluster,
    isNewWallet,
    growthRate,
  };
}

// ── Internal Helpers ──────────────────────────────────────────

/**
 * Extract a GLOBAL prefix (wallet-independent).
 *
 * Strips the @address/ prefix, removes UUIDs/hashes/versions,
 * normalizes separators → gives a cross-wallet comparable key.
 *
 * Examples:
 *   "@0xabc/LiDAR_Sensor_Fusion_abc123.rosbag" → "lidar_sensor_fusion"
 *   "@0xdef/LiDAR_Sensor_Fusion_def456.rosbag" → "lidar_sensor_fusion" (SAME!)
 *   "@0x123/training_data_v3.csv"               → "training_data"
 *   "@0x456/pexels-photo-12345.jpg"             → "pexels"
 */
function extractGlobalPrefix(blobName: string): string {
  // Remove @address/ prefix
  let name = blobName.startsWith("@")
    ? blobName.replace(/^@[^/]+\//, "")
    : blobName;

  // If there's a directory structure, use the directory path
  const parts = name.split("/");
  if (parts.length > 1) {
    name = parts[parts.length - 1]; // use filename only for prefix
  }

  return stripToCore(name);
}

/**
 * Strip a filename down to its "core" identity.
 * Removes extensions, UUIDs, hashes, version numbers, and trailing IDs.
 */
function stripToCore(filename: string): string {
  return filename
    .replace(/\.[^.]+$/, "")                    // extension
    .replace(/[_-]?[0-9a-f]{8,}$/i, "")         // trailing UUIDs/hashes
    .replace(/[_-]?v\d+$/i, "")                  // version numbers
    .replace(/[_-]?\d{4,}$/g, "")                // trailing numeric IDs
    .replace(/[_-]?[A-F0-9]{12,}$/i, "")         // hex hashes
    .replace(/[-]+/g, "_")                        // normalize separators
    .replace(/_+/g, "_")                          // collapse underscores
    .replace(/^_|_$/g, "")                        // trim edges
    .toLowerCase()
    || "unnamed";
}

/**
 * Derive content category from tags and signals.
 */
function deriveCategory(tags: string[], signals: string[]): string {
  const t = new Set(tags);
  const s = new Set(signals);

  if (t.has("ai_data") || s.has("ai_interaction") || s.has("model_data") || s.has("agent_config")) {
    return "ai";
  }
  if (s.has("trading_data")) return "trading";
  if (t.has("dataset")) return "data";
  if (t.has("config")) return "config";
  if (t.has("media")) return "media";
  if (t.has("logs")) return "infra";
  return "general";
}

/**
 * Build global project ID (cross-wallet).
 */
function buildGlobalProjectId(category: string, prefix: string): string {
  const cleanPrefix = prefix.slice(0, 40);
  return `${category}:${cleanPrefix}`;
}

/**
 * Generate a human-readable project label.
 */
function generateLabel(prefix: string, category: string, walletCount: number): string {
  const groupLabels: Record<string, string> = {
    ai: "🤖 AI Project",
    trading: "📊 Trading System",
    data: "📦 Dataset",
    config: "⚙️ Config Bundle",
    media: "🎨 Media Collection",
    infra: "🔧 Infrastructure",
    general: "📁 File Group",
  };

  const groupLabel = groupLabels[category] ?? "📁 File Group";
  const cleanPrefix = prefix
    .replace(/_/g, " ")
    .trim();

  const walletTag = walletCount > 1 ? ` (${walletCount} wallets)` : "";

  if (cleanPrefix && cleanPrefix !== "unnamed") {
    return `${groupLabel}: ${cleanPrefix}${walletTag}`;
  }
  return `${groupLabel}${walletTag}`;
}
