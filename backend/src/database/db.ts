import { PrismaClient } from "@prisma/client";

/**
 * Prisma Client Singleton
 *
 * Creates a single PrismaClient instance that is reused across the application.
 * In development, we store the client on `globalThis` to prevent
 * multiple instances being created during hot-reloading.
 */

// Extend globalThis to hold the prisma client across hot reloads
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

/** Shared Prisma client instance */
export const prisma: PrismaClient =
  globalForPrisma.prisma ??
  new PrismaClient({
    log:
      process.env.NODE_ENV === "development"
        ? ["query", "warn", "error"]
        : ["warn", "error"],
  });

// Preserve the client across hot reloads in development
if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

/**
 * Gracefully disconnect Prisma when the process exits.
 */
export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
  console.log("🔌 Database disconnected.");
}
