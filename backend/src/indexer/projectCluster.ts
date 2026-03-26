import { prisma } from "../database/db.js";

/**
 * Project Cluster — Blob Grouping Intelligence
 *
 * Groups blobs into "projects" based on three signals:
 *  1. Filename similarity  (shared prefix / directory structure)
 *  2. Content structure     (same tags/signals pattern)
 *  3. Time proximity        (uploaded within a short window)
 *
 * A project_id is a deterministic hash:  wallet + basePrefix + fileTypeGroup
 * This allows real-time assignment without maintaining a separate entity.
 */

// ── Public API ────────────────────────────────────────────────

export interface ClusterResult {
  projectId: string;
  projectLabel: string;
  clusterSize: number;
  isNewCluster: boolean;
}

/**
 * Assign a blob to a project cluster.
 *
 * @returns ClusterResult with the project_id and cluster metadata
 */
export async function assignToCluster(
  wallet: string,
  blobName: string,
  tags: string[],
  signals: string[]
): Promise<ClusterResult> {
  // Step 1 — Derive base prefix from blob name
  const prefix = extractPrefix(blobName);

  // Step 2 — Determine content group
  const contentGroup = deriveContentGroup(tags, signals);

  // Step 3 — Build project ID: wallet-prefix combo
  const projectId = buildProjectId(wallet, prefix, contentGroup);

  // Step 4 — Check existing cluster size
  const existingCount = await prisma.blob.count({
    where: { projectId },
  });

  // Step 5 — Generate human-readable label
  const projectLabel = generateLabel(prefix, contentGroup, wallet);

  return {
    projectId,
    projectLabel,
    clusterSize: existingCount + 1, // include current blob
    isNewCluster: existingCount === 0,
  };
}

/**
 * Get cluster summary for a wallet — groups all blobs by project.
 */
export async function getWalletClusters(wallet: string): Promise<WalletCluster[]> {
  const blobs = await prisma.blob.findMany({
    where: { wallet, projectId: { not: null } },
    include: { metadata: { select: { tags: true, signals: true, fileType: true } } },
    orderBy: { createdAt: "desc" },
  });

  // Group by project_id
  const groups = new Map<string, typeof blobs>();
  for (const blob of blobs) {
    const pid = blob.projectId!;
    if (!groups.has(pid)) groups.set(pid, []);
    groups.get(pid)!.push(blob);
  }

  return [...groups.entries()].map(([projectId, members]) => {
    const tags = [...new Set(members.flatMap((m) => m.metadata?.tags ?? []))];
    const signals = [...new Set(members.flatMap((m) => m.metadata?.signals ?? []))];
    const fileTypes = [...new Set(members.map((m) => m.metadata?.fileType).filter(Boolean))] as string[];

    return {
      projectId,
      label: generateLabel(
        extractPrefix(members[0].blobId.split(":")[1] ?? ""),
        deriveContentGroup(tags, signals),
        wallet
      ),
      blobCount: members.length,
      tags,
      signals,
      fileTypes,
      firstSeen: members[members.length - 1].createdAt,
      lastSeen: members[0].createdAt,
    };
  });
}

export interface WalletCluster {
  projectId: string;
  label: string;
  blobCount: number;
  tags: string[];
  signals: string[];
  fileTypes: string[];
  firstSeen: Date;
  lastSeen: Date;
}

// ── Internal Helpers ──────────────────────────────────────────

/**
 * Extract a meaningful prefix from blob name.
 *
 * Examples:
 *   "@0xabc/data/training_v1.json"  → "data/training"
 *   "@0xabc/model_weights_v2.pt"    → "model_weights"
 *   "LiDAR_Sensor_Fusion_abc123.rosbag" → "LiDAR_Sensor_Fusion"
 *   "pexels-some-photo-12345.jpg"   → "pexels"
 */
function extractPrefix(blobName: string): string {
  // Remove the @address/ prefix
  let name = blobName.startsWith("@")
    ? blobName.replace(/^@[^/]+\//, "")
    : blobName;

  // If there's a directory structure, use it
  const parts = name.split("/");
  if (parts.length > 1) {
    // Use directory path as prefix
    const dirPath = parts.slice(0, -1).join("/");
    const filename = parts[parts.length - 1];
    const fileBase = stripSuffix(filename);
    return `${dirPath}/${fileBase}`;
  }

  // No directory — extract base from filename
  return stripSuffix(name);
}

/**
 * Strip version numbers, UUIDs, hashes, and extensions from filename.
 */
function stripSuffix(filename: string): string {
  return filename
    // Remove extension
    .replace(/\.[^.]+$/, "")
    // Remove trailing UUIDs
    .replace(/_?[0-9a-f]{8,}$/i, "")
    // Remove trailing version numbers
    .replace(/_?v\d+$/i, "")
    // Remove trailing numbers (like photo IDs)
    .replace(/_?\d{4,}$/, "")
    // Remove trailing hashes
    .replace(/_?[A-F0-9]{12,}$/i, "")
    // Clean up trailing separators
    .replace(/[-_]+$/, "")
    || "unnamed";
}

/**
 * Derive a content group from tags and signals.
 * Groups: ai, trading, data, config, media, general
 */
function deriveContentGroup(tags: string[], signals: string[]): string {
  const t = new Set(tags);
  const s = new Set(signals);

  if (t.has("ai_data") || s.has("ai_interaction") || s.has("model_data") || s.has("agent_config")) {
    return "ai";
  }
  if (s.has("trading_data")) {
    return "trading";
  }
  if (t.has("dataset")) {
    return "data";
  }
  if (t.has("config")) {
    return "config";
  }
  if (t.has("media")) {
    return "media";
  }
  return "general";
}

/**
 * Build a deterministic project ID.
 */
function buildProjectId(wallet: string, prefix: string, contentGroup: string): string {
  const walletShort = wallet.slice(0, 10);
  const cleanPrefix = prefix.replace(/[^a-zA-Z0-9_/]/g, "").toLowerCase().slice(0, 30);
  return `${walletShort}:${contentGroup}:${cleanPrefix}`;
}

/**
 * Generate a human-readable project label.
 */
function generateLabel(prefix: string, contentGroup: string, wallet: string): string {
  const walletTag = `${wallet.slice(0, 6)}...${wallet.slice(-4)}`;

  const groupLabels: Record<string, string> = {
    ai: "🤖 AI Project",
    trading: "📊 Trading System",
    data: "📦 Dataset Collection",
    config: "⚙️ Config Bundle",
    media: "🎨 Media Collection",
    general: "📁 File Group",
  };

  const groupLabel = groupLabels[contentGroup] ?? "📁 File Group";
  const cleanPrefix = prefix
    .replace(/[_-]+/g, " ")
    .replace(/\//g, " / ")
    .trim();

  if (cleanPrefix && cleanPrefix !== "unnamed") {
    return `${groupLabel}: ${cleanPrefix} (${walletTag})`;
  }
  return `${groupLabel} (${walletTag})`;
}
