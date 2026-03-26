import { prisma } from "../database/db.js";
import { alphaFeed, computePriority } from "../services/alphaFeed.js";
import type { BlobJobData } from "../types.js";

/**
 * Alpha Detection Module v3 — Behavioral Signal Layer + Context
 *
 * Each signal now includes:
 *   - explanation: what happened
 *   - impact: why it matters
 *   - context: supporting metrics
 */

const SCORE_THRESHOLD = 5;

export async function detectAlphaSignals(data: BlobJobData): Promise<void> {
  try {
    const signals = await Promise.all([
      detectWalletVelocity(data),
      detectFirstTimeBurst(data),
      detectDormantReactivation(data),
      detectCrossWalletPattern(data),
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

        console.log(`[SSE] Broadcasting event: ${s.type} score=${s.score} priority=${priority}`);
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

// ── Rule 1: Wallet Velocity ────────────────────────────────────

async function detectWalletVelocity(
  data: BlobJobData
): Promise<AlphaSignal | null> {
  const now = new Date();
  const oneHourAgo = new Date(now.getTime() - 3_600_000);
  const oneDayAgo = new Date(now.getTime() - 86_400_000);

  const [recentCount, dayCount, totalCount] = await Promise.all([
    prisma.blob.count({
      where: { wallet: data.accountAddress, createdAt: { gte: oneHourAgo } },
    }),
    prisma.blob.count({
      where: { wallet: data.accountAddress, createdAt: { gte: oneDayAgo } },
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
        explanation:
          `Wallet activity surged ${multiplier}x vs average — ` +
          `${recentCount} uploads in last hour`,
        impact:
          "Sudden velocity spikes may indicate automated scripts, " +
          "bot activity, or large-scale data migration",
        context:
          `${recentCount} uploads/hr vs avg ${avgPerHour.toFixed(1)}/hr · ` +
          `${dayCount} in 24h · ${totalCount} all-time`,
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

  if (!firstBlob) return null;
  if (firstBlob.createdAt < tenMinAgo) return null;

  const totalCount = await prisma.blob.count({
    where: { wallet: data.accountAddress },
  });

  if (totalCount < 3) return null;

  const minsSinceFirst = Math.max(
    1,
    Math.round((Date.now() - firstBlob.createdAt.getTime()) / 60_000)
  );

  // Get avg first-session blobs across all wallets for context
  const uniqueWallets = await prisma.blob.groupBy({
    by: ["wallet"],
    _count: { _all: true },
  });
  const avgBlobsPerWallet =
    uniqueWallets.length > 0
      ? uniqueWallets.reduce((s, w) => s + w._count._all, 0) /
        uniqueWallets.length
      : 1;

  const score = Math.min(9, 5 + totalCount);
  return {
    type: "FIRST_TIME_BURST",
    score,
    explanation:
      `New wallet uploaded ${totalCount} blobs within ${minsSinceFirst} minutes`,
    impact:
      "First-time burst activity suggests automated pipelines, " +
      "airdrop claims, or programmatic data uploads",
    context:
      `${totalCount} blobs in ${minsSinceFirst}min · ` +
      `network avg: ${avgBlobsPerWallet.toFixed(1)} blobs/wallet`,
  };
}

// ── Rule 3: Dormant Wallet Reactivation ────────────────────────

async function detectDormantReactivation(
  data: BlobJobData
): Promise<AlphaSignal | null> {
  const DORMANT_THRESHOLD_HOURS = 24;

  const recentBlobs = await prisma.blob.findMany({
    where: { wallet: data.accountAddress },
    orderBy: { createdAt: "desc" },
    take: 2,
    select: { createdAt: true },
  });

  if (recentBlobs.length < 2) return null;

  const current = recentBlobs[0];
  const previous = recentBlobs[1];

  const gapHours =
    (current.createdAt.getTime() - previous.createdAt.getTime()) / 3_600_000;

  if (gapHours < DORMANT_THRESHOLD_HOURS) return null;

  const gapLabel =
    gapHours >= 72
      ? `${Math.round(gapHours / 24)} days`
      : `${Math.round(gapHours)} hours`;

  const score = Math.min(8, 5 + Math.floor(gapHours / 24));
  return {
    type: "DORMANT_REACTIVATION",
    score,
    explanation:
      `Dormant wallet reactivated after ${gapLabel} of silence`,
    impact:
      "Returning wallets may indicate renewed interest, " +
      "delayed workflows, or reactivated automation",
    context:
      `Last upload: ${previous.createdAt.toISOString().slice(0, 10)} · ` +
      `Gap: ${gapLabel}`,
  };
}

// ── Rule 4: Cross-Wallet Pattern ───────────────────────────────

async function detectCrossWalletPattern(
  data: BlobJobData
): Promise<AlphaSignal | null> {
  const ext = extractExtension(data.blobName);
  if (!ext) return null;

  const twoMinAgo = new Date(Date.now() - 2 * 60_000);
  const fiveMinAgo = new Date(Date.now() - 5 * 60_000);

  const [recentSameType, widerWindow] = await Promise.all([
    prisma.blob.findMany({
      where: {
        createdAt: { gte: twoMinAgo },
        metadata: { fileType: ext },
      },
      select: { wallet: true },
      distinct: ["wallet"],
    }),
    prisma.blob.findMany({
      where: {
        createdAt: { gte: fiveMinAgo },
        metadata: { fileType: ext },
      },
      select: { wallet: true },
      distinct: ["wallet"],
    }),
  ]);

  const walletsIn2Min = recentSameType.length;
  const walletsIn5Min = widerWindow.length;

  if (walletsIn2Min < 3) return null;

  // Get historical average for this file type
  const oneDayAgo = new Date(Date.now() - 86_400_000);
  const dayTotal = await prisma.blob.count({
    where: {
      createdAt: { gte: oneDayAgo },
      metadata: { fileType: ext },
    },
  });
  const avgPer2Min = (dayTotal / (24 * 30)).toFixed(1); // 24h * 30 two-min windows

  const score = Math.min(10, 6 + walletsIn2Min);
  const trend = walletsIn5Min > walletsIn2Min ? "↑ increasing" : "→ steady";

  return {
    type: "CROSS_WALLET_PATTERN",
    score,
    explanation:
      `${walletsIn2Min} wallets uploaded .${ext} files within 2 minutes`,
    impact:
      "Multiple wallets acting together may indicate shared pipelines, " +
      "coordinated uploads, or automated distribution systems",
    context:
      `${walletsIn2Min} wallets/2min · ${walletsIn5Min} wallets/5min ${trend} · ` +
      `avg: ${avgPer2Min} .${ext}/2min`,
  };
}

// ── Rule 5: Rare File Type (downranked) ────────────────────────

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

  const totalBlobs = await prisma.blob.count();

  return {
    type: "RARE_FILE_TYPE",
    score: 5,
    explanation:
      `First-ever .${ext} file uploaded on Shelby`,
    impact:
      "New file types may represent new use cases, " +
      "protocol experiments, or novel data formats",
    context:
      `1 of ${totalBlobs} total blobs · first .${ext} ever observed`,
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
