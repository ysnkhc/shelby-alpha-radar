import { prisma } from "../../database/db.js";
import type { FastifyInstance } from "fastify";

/**
 * Intelligence Routes — Analytics & Insights
 *
 *   GET /owners/:owner      — owner profile (stats, activity, top file type)
 *   GET /leaders            — top 10 owners by blob count
 *   GET /trends/files       — trending file types (1h / 24h)
 *   GET /activity           — real-time activity feed
 *   GET /ranking            — scored owner ranking
 */
export async function intelligenceRoutes(app: FastifyInstance): Promise<void> {

  // ── Owner Profile ───────────────────────────────────────────
  app.get<{
    Params: { owner: string };
  }>("/owners/:owner", async (request, reply) => {
    const { owner } = request.params;

    const blobs = await prisma.blob.findMany({
      where: { wallet: owner },
      include: { metadata: true },
      orderBy: { createdAt: "asc" },
    });

    if (blobs.length === 0) {
      return reply.status(404).send({
        error: "Owner not found",
        owner,
      });
    }

    // Compute file type distribution
    const fileTypeCounts = new Map<string, number>();
    for (const b of blobs) {
      const ft = b.metadata?.fileType ?? "unknown";
      fileTypeCounts.set(ft, (fileTypeCounts.get(ft) ?? 0) + 1);
    }

    // Find most common file type
    let topFileType = "unknown";
    let topCount = 0;
    for (const [ft, count] of fileTypeCounts) {
      if (count > topCount) {
        topFileType = ft;
        topCount = count;
      }
    }

    const fileTypes = [...fileTypeCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([type, count]) => ({ type, count }));

    return reply.send({
      owner,
      totalBlobs: blobs.length,
      firstSeen: blobs[0].createdAt.toISOString(),
      lastActive: blobs[blobs.length - 1].createdAt.toISOString(),
      topFileType,
      fileTypes,
      score: computeScore(blobs),
    });
  });

  // ── Top Owners / Leaders ────────────────────────────────────
  app.get("/leaders", async (_request, reply) => {
    const groups = await prisma.blob.groupBy({
      by: ["wallet"],
      _count: { _all: true },
      _max: { createdAt: true },
      orderBy: { _count: { wallet: "desc" } },
      take: 10,
    });

    const leaders = groups.map((g, rank) => ({
      rank: rank + 1,
      owner: g.wallet,
      blobCount: g._count._all,
      lastActive: g._max.createdAt?.toISOString() ?? null,
    }));

    return reply.send({ leaders });
  });

  // ── Trending File Types ─────────────────────────────────────
  app.get("/trends/files", async (_request, reply) => {
    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    const [hourly, daily] = await Promise.all([
      getFileTypeTrends(oneHourAgo),
      getFileTypeTrends(oneDayAgo),
    ]);

    return reply.send({
      lastHour: hourly,
      last24Hours: daily,
    });
  });

  // ── Activity Feed ───────────────────────────────────────────
  app.get<{
    Querystring: { limit?: string };
  }>("/activity", async (request, reply) => {
    const limit = Math.min(50, Math.max(1, Number(request.query.limit) || 20));

    const blobs = await prisma.blob.findMany({
      include: { metadata: true },
      orderBy: { createdAt: "desc" },
      take: limit,
    });

    const feed = blobs.map((b) => {
      const colonIdx = b.blobId.indexOf(":");
      const blobName = colonIdx >= 0 ? b.blobId.slice(colonIdx + 1) : b.blobId;

      // Extract just the filename from @owner/filename
      const fileName = blobName.startsWith("@")
        ? blobName.replace(/^@[^/]+\//, "")
        : blobName;

      return {
        action: "uploaded",
        owner: b.wallet,
        ownerShort: `${b.wallet.slice(0, 8)}...${b.wallet.slice(-4)}`,
        fileName,
        fileType: b.metadata?.fileType ?? null,
        size: b.size.toString(),
        timestamp: b.createdAt.toISOString(),
        timeAgo: getTimeAgo(b.createdAt),
      };
    });

    return reply.send({ feed });
  });

  // ── Scored Ranking ──────────────────────────────────────────
  app.get<{
    Querystring: { limit?: string };
  }>("/ranking", async (request, reply) => {
    const limit = Math.min(50, Math.max(1, Number(request.query.limit) || 20));

    // Get all owners with their blobs
    const owners = await prisma.blob.groupBy({
      by: ["wallet"],
      _count: { _all: true },
      _max: { createdAt: true },
      _min: { createdAt: true },
      orderBy: { _count: { wallet: "desc" } },
    });

    // Compute scores and sort
    const now = new Date();
    const ranked = owners
      .map((o) => {
        const blobCount = o._count._all;
        const lastActive = o._max.createdAt;
        const firstSeen = o._min.createdAt;

        // Score = blobs + frequency bonus + recency bonus
        let score = blobCount;

        // Frequency bonus: if > 5 blobs, add 50% of excess
        if (blobCount > 5) {
          score += Math.floor((blobCount - 5) * 0.5);
        }

        // Recency bonus: activity in last 1h = +10, last 24h = +5
        if (lastActive) {
          const hoursAgo = (now.getTime() - lastActive.getTime()) / 3_600_000;
          if (hoursAgo <= 1) score += 10;
          else if (hoursAgo <= 24) score += 5;
          else if (hoursAgo <= 168) score += 2; // within 1 week
        }

        return {
          owner: o.wallet,
          score,
          blobCount,
          firstSeen: firstSeen?.toISOString() ?? null,
          lastActive: lastActive?.toISOString() ?? null,
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((o, i) => ({ rank: i + 1, ...o }));

    return reply.send({ ranking: ranked });
  });

  // ── Wallet Mini-Timeline ───────────────────────────────────
  app.get<{
    Params: { owner: string };
    Querystring: { limit?: string };
  }>("/owners/:owner/timeline", async (request, reply) => {
    const { owner } = request.params;
    const limit = Math.min(10, Math.max(1, Number(request.query.limit) || 5));

    const blobs = await prisma.blob.findMany({
      where: { wallet: owner },
      include: { metadata: true },
      orderBy: { createdAt: "desc" },
      take: limit,
    });

    const timeline = blobs.map((b) => {
      const colonIdx = b.blobId.indexOf(":");
      const blobName = colonIdx >= 0 ? b.blobId.slice(colonIdx + 1) : b.blobId;
      const fileName = blobName.startsWith("@")
        ? blobName.replace(/^@[^/]+\//, "")
        : blobName;

      return {
        action: "uploaded",
        fileName,
        fileType: b.metadata?.fileType ?? null,
        size: b.size.toString(),
        timestamp: b.createdAt.toISOString(),
        timeAgo: getTimeAgo(b.createdAt),
      };
    });

    return reply.send({ owner, timeline });
  });
}

// ── Helpers ────────────────────────────────────────────────────

interface BlobForScore {
  createdAt: Date;
}

function computeScore(blobs: BlobForScore[]): number {
  const count = blobs.length;
  let score = count;

  if (count > 5) {
    score += Math.floor((count - 5) * 0.5);
  }

  const now = new Date();
  const lastBlob = blobs[blobs.length - 1];
  if (lastBlob) {
    const hoursAgo = (now.getTime() - lastBlob.createdAt.getTime()) / 3_600_000;
    if (hoursAgo <= 1) score += 10;
    else if (hoursAgo <= 24) score += 5;
    else if (hoursAgo <= 168) score += 2;
  }

  return score;
}

async function getFileTypeTrends(since: Date) {
  const blobs = await prisma.blob.findMany({
    where: { createdAt: { gte: since } },
    include: { metadata: true },
  });

  const total = blobs.length;
  const counts = new Map<string, number>();

  for (const b of blobs) {
    const ft = b.metadata?.fileType ?? "unknown";
    counts.set(ft, (counts.get(ft) ?? 0) + 1);
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([type, count]) => ({
      type,
      count,
      percentage: total > 0 ? Math.round((count / total) * 10000) / 100 : 0,
    }));
}

function getTimeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);

  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
