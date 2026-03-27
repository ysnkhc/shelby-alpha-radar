import type { FastifyInstance } from "fastify";
import { generateInsights, generateAlerts } from "../../indexer/insightEngine.js";

/**
 * Insight Routes — Top-level intelligence feed
 *
 *   GET /insights         — ranked insights (replaces raw event feed)
 *   GET /alerts           — active alerts for high-importance activity
 */
export async function insightRoutes(app: FastifyInstance): Promise<void> {

  // ── Top Insights ─────────────────────────────────────────────
  app.get<{
    Querystring: { limit?: string; category?: string };
  }>("/insights", async (request, reply) => {
    const limit = Math.min(50, Math.max(1, Number(request.query.limit) || 20));
    const categoryFilter = request.query.category;

    let insights = await generateInsights(limit);

    if (categoryFilter) {
      insights = insights.filter((i) => i.category === categoryFilter);
    }

    const categoryCounts = {
      project: insights.filter((i) => i.category === "project").length,
      ai: insights.filter((i) => i.category === "ai").length,
      data: insights.filter((i) => i.category === "data").length,
      rare: insights.filter((i) => i.category === "rare").length,
    };

    return reply.send({
      insights,
      total: insights.length,
      categoryCounts,
    });
  });

  // ── Active Alerts ────────────────────────────────────────────
  app.get("/alerts", async (_request, reply) => {
    const alerts = await generateAlerts();

    return reply.send({
      alerts,
      total: alerts.length,
      levels: {
        critical: alerts.filter((a) => a.level === "critical").length,
        high: alerts.filter((a) => a.level === "high").length,
        watch: alerts.filter((a) => a.level === "watch").length,
      },
    });
  });
}
