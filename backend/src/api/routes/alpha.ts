import { prisma } from "../../database/db.js";
import type { FastifyInstance } from "fastify";

/**
 * Alpha Feed Routes
 *
 *   GET /alpha           — all alpha events (filterable by type, priority)
 *   GET /alpha/high      — only HIGH priority signals
 *   GET /alpha/:owner    — alpha events for a specific owner
 */
export async function alphaRoutes(app: FastifyInstance): Promise<void> {

  // ── All Alpha Events ────────────────────────────────────────
  app.get<{
    Querystring: { limit?: string; type?: string; priority?: string };
  }>("/alpha", async (request, reply) => {
    const limit = Math.min(50, Math.max(1, Number(request.query.limit) || 20));
    const typeFilter = request.query.type;
    const priorityFilter = request.query.priority?.toUpperCase();

    const where: Record<string, unknown> = {};
    if (typeFilter) where.signalType = typeFilter;
    if (priorityFilter) where.priority = priorityFilter;

    const [events, total] = await Promise.all([
      prisma.alphaEvent.findMany({
        where,
        orderBy: [{ score: "desc" }, { createdAt: "desc" }],
        take: limit,
      }),
      prisma.alphaEvent.count({ where }),
    ]);

    return reply.send({
      events: events.map(serializeAlpha),
      total,
      limit,
      signalTypes: await getSignalTypeSummary(),
    });
  });

  // ── High-Priority Only ──────────────────────────────────────
  app.get<{
    Querystring: { limit?: string };
  }>("/alpha/high", async (request, reply) => {
    const limit = Math.min(50, Math.max(1, Number(request.query.limit) || 20));

    const [events, total] = await Promise.all([
      prisma.alphaEvent.findMany({
        where: { priority: "HIGH" },
        orderBy: [{ score: "desc" }, { createdAt: "desc" }],
        take: limit,
      }),
      prisma.alphaEvent.count({ where: { priority: "HIGH" } }),
    ]);

    return reply.send({
      priority: "HIGH",
      events: events.map(serializeAlpha),
      total,
    });
  });

  // ── Alpha Events by Owner ──────────────────────────────────
  app.get<{
    Params: { owner: string };
    Querystring: { limit?: string };
  }>("/alpha/:owner", async (request, reply) => {
    const { owner } = request.params;
    const limit = Math.min(50, Math.max(1, Number(request.query.limit) || 20));

    const [events, total] = await Promise.all([
      prisma.alphaEvent.findMany({
        where: { owner },
        orderBy: [{ score: "desc" }, { createdAt: "desc" }],
        take: limit,
      }),
      prisma.alphaEvent.count({ where: { owner } }),
    ]);

    return reply.send({
      owner,
      events: events.map(serializeAlpha),
      total,
    });
  });
}

// ── Helpers ────────────────────────────────────────────────────

function serializeAlpha(event: {
  id: number;
  owner: string;
  blobName: string | null;
  signalType: string;
  score: number;
  priority: string;
  explanation: string;
  createdAt: Date;
}) {
  return {
    id: event.id,
    owner: event.owner,
    ownerShort: `${event.owner.slice(0, 8)}...${event.owner.slice(-4)}`,
    blobName: event.blobName,
    signalType: event.signalType,
    score: event.score,
    priority: event.priority,
    explanation: event.explanation,
    timestamp: event.createdAt.toISOString(),
    timeAgo: getTimeAgo(event.createdAt),
  };
}

async function getSignalTypeSummary() {
  const groups = await prisma.alphaEvent.groupBy({
    by: ["signalType"],
    _count: { _all: true },
    orderBy: { _count: { signalType: "desc" } },
  });

  return groups.map((g) => ({
    type: g.signalType,
    count: g._count._all,
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
