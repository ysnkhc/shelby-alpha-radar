import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";

/**
 * Rate Limiter Plugin
 *
 * Simple in-memory rate limiter using a sliding window.
 * Limits each IP to a configurable number of requests per window.
 *
 * For production, replace with @fastify/rate-limit backed by Redis.
 */

interface RateLimitConfig {
  /** Max requests per window (default: 100) */
  max?: number;
  /** Window size in milliseconds (default: 60000 = 1 minute) */
  windowMs?: number;
}

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

export async function rateLimiter(
  app: FastifyInstance,
  opts?: RateLimitConfig
): Promise<void> {
  const max = opts?.max ?? 100;
  const windowMs = opts?.windowMs ?? 60_000;
  const store = new Map<string, RateLimitEntry>();

  // Clean up expired entries every 5 minutes
  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of store) {
      if (entry.resetAt <= now) store.delete(key);
    }
  }, 300_000);

  // Ensure cleanup doesn't prevent process exit
  cleanup.unref();

  app.addHook(
    "onRequest",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const ip = request.ip;
      const now = Date.now();

      let entry = store.get(ip);

      if (!entry || entry.resetAt <= now) {
        // New window
        entry = { count: 1, resetAt: now + windowMs };
        store.set(ip, entry);
      } else {
        entry.count++;
      }

      // Set rate limit headers
      const remaining = Math.max(0, max - entry.count);
      const resetSec = Math.ceil((entry.resetAt - now) / 1000);

      void reply.header("X-RateLimit-Limit", String(max));
      void reply.header("X-RateLimit-Remaining", String(remaining));
      void reply.header("X-RateLimit-Reset", String(resetSec));

      if (entry.count > max) {
        void reply.header("Retry-After", String(resetSec));
        return reply.status(429).send({
          error: "Too Many Requests",
          statusCode: 429,
          retryAfter: resetSec,
        });
      }
    }
  );
}
