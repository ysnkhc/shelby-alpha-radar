import type { FastifyInstance } from "fastify";
import {
  alphaFeed,
  type AlphaPriority,
  type LiveAlphaEvent,
} from "../../services/alphaFeed.js";

/**
 * Live Alpha Feed — Server-Sent Events
 *
 *   GET /ws/alpha                          — all signals
 *   GET /ws/alpha?minPriority=MEDIUM       — only MEDIUM + HIGH
 *   GET /ws/alpha?minPriority=HIGH         — only HIGH
 *   GET /ws/alpha?owner=0x...              — watchlist for specific wallet
 *   GET /ws/alpha?minPriority=HIGH&owner=  — combined filters
 *
 *   GET /ws/status                         — connection stats
 */
export async function liveRoutes(app: FastifyInstance): Promise<void> {
  // ── CORS preflight for SSE endpoint ──────────────────────
  app.options("/ws/alpha", async (_request, reply) => {
    return reply
      .header("Access-Control-Allow-Origin", "*")
      .header("Access-Control-Allow-Methods", "GET, OPTIONS")
      .header("Access-Control-Allow-Headers", "*")
      .status(204)
      .send();
  });

  app.get<{
    Querystring: { minPriority?: string; owner?: string };
  }>("/ws/alpha", async (request, reply) => {
    // Parse filters
    const minPriority = parseMinPriority(request.query.minPriority);
    const owner = request.query.owner?.trim() || undefined;
    const filter = { minPriority, owner };

    // Set SSE headers with explicit CORS
    void reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "*",
      "X-Accel-Buffering": "no",
    });

    const raw = reply.raw;

    const sendEvent = (type: string, data: unknown) => {
      raw.write(`event: ${type}\n`);
      raw.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    // 1. Connection confirmation
    sendEvent("connected", {
      message: "Connected to Shelby Alpha Feed",
      clients: alphaFeed.clientCount + 1,
      filters: {
        minPriority: minPriority ?? "ALL",
        owner: owner ?? "ALL",
      },
      timestamp: new Date().toISOString(),
    });

    // 2. Backfill (filtered)
    const recent = alphaFeed.getRecent(filter);
    if (recent.length > 0) {
      sendEvent("backfill", {
        count: recent.length,
        events: recent,
      });
    }

    // 3. Subscribe with filters
    const onAlpha = (event: LiveAlphaEvent) => {
      sendEvent("alpha", event);
    };

    const unsubscribe = alphaFeed.subscribe(onAlpha, filter);

    // 4. Keep-alive
    const ping = setInterval(() => {
      raw.write(`: ping\n\n`);
    }, 30_000);

    // 5. Cleanup
    request.raw.on("close", () => {
      unsubscribe();
      clearInterval(ping);
    });

    await reply.hijack();
  });

  // ── Status ──────────────────────────────────────────────────
  app.get("/ws/status", async (_request, reply) => {
    return reply.send({
      type: "sse",
      endpoint: "/ws/alpha",
      connectedClients: alphaFeed.clientCount,
      cachedEvents: alphaFeed.getRecent().length,
      filters: ["minPriority=HIGH|MEDIUM|LOW", "owner=0x..."],
    });
  });
}

function parseMinPriority(value?: string): AlphaPriority | undefined {
  if (!value) return undefined;
  const upper = value.toUpperCase();
  if (upper === "HIGH" || upper === "MEDIUM" || upper === "LOW") {
    return upper as AlphaPriority;
  }
  return undefined;
}
