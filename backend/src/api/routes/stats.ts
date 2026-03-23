import { prisma } from "../../database/db.js";
import type { FastifyInstance } from "fastify";

/**
 * Stats Route
 *
 *   GET /stats — aggregate statistics about indexed blobs
 */
export async function statsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/stats", async (_request, reply) => {
    const [totalBlobs, uniqueOwners, earliest, latest] = await Promise.all([
      prisma.blob.count(),
      prisma.blob
        .groupBy({ by: ["wallet"] })
        .then((groups) => groups.length),
      prisma.blob.findFirst({
        orderBy: { createdAt: "asc" },
        select: { createdAt: true },
      }),
      prisma.blob.findFirst({
        orderBy: { createdAt: "desc" },
        select: { createdAt: true },
      }),
    ]);

    // Calculate approximate blobs per minute
    let blobsPerMinute = 0;
    if (earliest && latest && totalBlobs > 1) {
      const spanMs =
        latest.createdAt.getTime() - earliest.createdAt.getTime();
      const spanMinutes = spanMs / 60_000;
      blobsPerMinute =
        spanMinutes > 0
          ? Math.round((totalBlobs / spanMinutes) * 100) / 100
          : 0;
    }

    return reply.send({
      totalBlobs,
      uniqueOwners,
      blobsPerMinute,
      earliest: earliest?.createdAt?.toISOString() ?? null,
      latest: latest?.createdAt?.toISOString() ?? null,
    });
  });
}
