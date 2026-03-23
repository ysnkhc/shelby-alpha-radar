import { prisma } from "../../database/db.js";
import type { FastifyInstance } from "fastify";

/**
 * Search Route
 *
 *   GET /search?q=keyword&page=1&limit=20
 *
 * Searches by blob_name and owner using LIKE queries.
 * Returns matching blobs with metadata, sorted by relevance.
 */
export async function searchRoutes(app: FastifyInstance): Promise<void> {
  app.get<{
    Querystring: { q?: string; page?: string; limit?: string };
  }>("/search", async (request, reply) => {
    const query = request.query.q?.trim();
    const page = Math.max(1, Number(request.query.page) || 1);
    const limit = Math.min(50, Math.max(1, Number(request.query.limit) || 20));
    const offset = (page - 1) * limit;

    // No query → return recent blobs
    if (!query) {
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
    }

    // Search by blob_name (via blobId which contains it) and wallet

    const [blobs, total] = await Promise.all([
      prisma.blob.findMany({
        where: {
          OR: [
            { blobId: { contains: query, mode: "insensitive" } },
            { wallet: { contains: query, mode: "insensitive" } },
            {
              metadata: {
                OR: [
                  { title: { contains: query, mode: "insensitive" } },
                  { tags: { has: query.toLowerCase() } },
                ],
              },
            },
          ],
        },
        include: { metadata: true },
        orderBy: { createdAt: "desc" },
        take: limit,
        skip: offset,
      }),
      prisma.blob.count({
        where: {
          OR: [
            { blobId: { contains: query, mode: "insensitive" } },
            { wallet: { contains: query, mode: "insensitive" } },
            {
              metadata: {
                OR: [
                  { title: { contains: query, mode: "insensitive" } },
                  { tags: { has: query.toLowerCase() } },
                ],
              },
            },
          ],
        },
      }),
    ]);

    return reply.send({
      results: blobs.map(serializeBlob),
      total,
      page,
      limit,
      query,
    });
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
