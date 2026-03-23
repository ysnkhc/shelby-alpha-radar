import { prisma } from "../../database/db.js";
import type { FastifyInstance } from "fastify";

/**
 * Blob Routes — Explorer Backend
 *
 * Public API for browsing indexed Shelby blobs:
 *   GET /blobs/recent              — latest blobs (paginated)
 *   GET /blobs/:owner              — blobs for a specific wallet
 *   GET /blobs/:owner/:blobName    — single blob detail
 */
export async function blobRoutes(app: FastifyInstance): Promise<void> {

  // ── Recent blobs ─────────────────────────────────────────────
  app.get<{
    Querystring: { page?: string; limit?: string };
  }>("/blobs/recent", async (request, reply) => {
    const page = Math.max(1, Number(request.query.page) || 1);
    const limit = Math.min(50, Math.max(1, Number(request.query.limit) || 20));
    const offset = (page - 1) * limit;

    const [blobs, total] = await Promise.all([
      prisma.blob.findMany({
        include: { metadata: true },
        orderBy: { createdAt: "desc" },
        take: limit,
        skip: offset,
      }),
      prisma.blob.count(),
    ]);

    return reply.send({
      results: blobs.map(serializeBlob),
      total,
      page,
      limit,
    });
  });

  // ── Blobs by owner ──────────────────────────────────────────
  app.get<{
    Params: { owner: string };
    Querystring: { page?: string; limit?: string };
  }>("/blobs/:owner", async (request, reply) => {
    const { owner } = request.params;
    const page = Math.max(1, Number(request.query.page) || 1);
    const limit = Math.min(50, Math.max(1, Number(request.query.limit) || 20));
    const offset = (page - 1) * limit;

    const [blobs, total] = await Promise.all([
      prisma.blob.findMany({
        where: { wallet: owner },
        include: { metadata: true },
        orderBy: { createdAt: "desc" },
        take: limit,
        skip: offset,
      }),
      prisma.blob.count({ where: { wallet: owner } }),
    ]);

    return reply.send({
      results: blobs.map(serializeBlob),
      total,
      page,
      limit,
      owner,
    });
  });

  // ── Single blob detail ──────────────────────────────────────
  app.get<{
    Params: { owner: string; blobName: string };
  }>("/blobs/:owner/:blobName", async (request, reply) => {
    const { owner, blobName } = request.params;
    const blobId = `${owner}:${decodeURIComponent(blobName)}`;

    const blob = await prisma.blob.findUnique({
      where: { blobId },
      include: { metadata: true },
    });

    if (!blob) {
      return reply.status(404).send({
        error: "Blob not found",
        blobId,
      });
    }

    return reply.send(serializeBlob(blob));
  });
}

// ── Serialization ──────────────────────────────────────────────

interface BlobWithMetadata {
  id: number;
  blobId: string;
  wallet: string;
  size: bigint;
  contentType: string | null;
  createdAt: Date;
  indexedAt: Date;
  metadata: {
    id: number;
    blobId: string;
    title: string | null;
    description: string | null;
    tags: string[];
    fileType: string | null;
  } | null;
}

function serializeBlob(blob: BlobWithMetadata) {
  // Extract blob_name from blobId (format: "owner:blobName")
  const colonIdx = blob.blobId.indexOf(":");
  const blobName = colonIdx >= 0 ? blob.blobId.slice(colonIdx + 1) : blob.blobId;

  return {
    blobId: blob.blobId,
    owner: blob.wallet,
    blobName,
    size: blob.size.toString(),
    contentType: blob.contentType,
    createdAt: blob.createdAt.toISOString(),
    indexedAt: blob.indexedAt.toISOString(),
    fileType: blob.metadata?.fileType ?? null,
    metadata: blob.metadata
      ? {
          title: blob.metadata.title,
          description: blob.metadata.description,
          tags: blob.metadata.tags,
          fileType: blob.metadata.fileType,
        }
      : null,
  };
}
