import type { FastifyInstance } from "fastify";
import { getProjectSummaries } from "../../indexer/insightEngine.js";
import { prisma } from "../../database/db.js";

/**
 * Project Routes — Aggregated project intelligence
 *
 *   GET /projects           — all active projects ranked by importance
 *   GET /projects/:id       — single project detail with recent signals
 */
export async function projectRoutes(app: FastifyInstance): Promise<void> {

  // ── All Projects ─────────────────────────────────────────────
  app.get<{
    Querystring: { limit?: string; category?: string; status?: string };
  }>("/projects", async (request, reply) => {
    const limit = Math.min(50, Math.max(1, Number(request.query.limit) || 20));
    const categoryFilter = request.query.category;
    const statusFilter = request.query.status;

    let summaries = await getProjectSummaries(limit);

    if (categoryFilter) {
      summaries = summaries.filter((p) => p.category === categoryFilter);
    }
    if (statusFilter) {
      summaries = summaries.filter((p) => p.status === statusFilter);
    }

    const statusCounts = {
      active: summaries.filter((p) => p.status === "active").length,
      growing: summaries.filter((p) => p.status === "growing").length,
      dormant: summaries.filter((p) => p.status === "dormant").length,
    };

    return reply.send({
      projects: summaries,
      total: summaries.length,
      statusCounts,
    });
  });

  // ── Single Project Detail ────────────────────────────────────
  app.get<{
    Params: { id: string };
  }>("/projects/:id", async (request, reply) => {
    const projectId = decodeURIComponent(request.params.id);

    const project = await prisma.project.findUnique({
      where: { id: projectId },
    });

    if (!project) {
      return reply.status(404).send({ error: "Project not found", projectId });
    }

    // Get recent alpha events for this project's wallets
    const recentSignals = await prisma.alphaEvent.findMany({
      where: {
        owner: { in: project.wallets },
        createdAt: { gte: new Date(Date.now() - 24 * 3_600_000) },
      },
      orderBy: [{ score: "desc" }, { createdAt: "desc" }],
      take: 10,
    });

    // Get blob details
    const blobs = await prisma.blob.findMany({
      where: { projectId },
      include: { metadata: { select: { fileType: true, tags: true, signals: true } } },
      orderBy: { createdAt: "desc" },
      take: 20,
    });

    const now = new Date();
    const hoursSinceActive = (now.getTime() - project.lastActive.getTime()) / 3_600_000;
    const status = hoursSinceActive < 1 && project.growthRate >= 1
      ? "growing"
      : hoursSinceActive < 6
        ? "active"
        : "dormant";

    return reply.send({
      project: {
        id: project.id,
        label: project.label,
        category: project.category,
        status,
        wallets: project.wallets.map((w) => ({
          address: w,
          short: `${w.slice(0, 8)}...${w.slice(-4)}`,
        })),
        walletCount: project.walletCount,
        blobCount: project.blobCount,
        growthRate: project.growthRate,
        tags: project.tags,
        signals: project.signals,
        fileTypes: project.fileTypes,
        firstSeen: project.firstSeen.toISOString(),
        lastActive: project.lastActive.toISOString(),
      },
      recentSignals: recentSignals.map((s) => ({
        type: s.signalType,
        score: s.score,
        priority: s.priority,
        explanation: s.explanation,
        timestamp: s.createdAt.toISOString(),
      })),
      recentBlobs: blobs.map((b) => ({
        blobId: b.blobId,
        wallet: `${b.wallet.slice(0, 8)}...${b.wallet.slice(-4)}`,
        fileType: b.metadata?.fileType ?? null,
        tags: b.metadata?.tags ?? [],
        timestamp: b.createdAt.toISOString(),
      })),
    });
  });
}
