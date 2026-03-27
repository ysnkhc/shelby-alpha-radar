import type { FastifyInstance } from "fastify";
import { prisma } from "../../database/db.js";
import {
  computeConfidence,
  computeStage,
  computeMomentum,
  computeOpportunity,
  computeQuality,
  classifyProject,
} from "../../indexer/insightEngine.js";

/**
 * AI Consumption Layer
 *
 * Makes Shelby data directly usable by AI agents:
 *   GET  /datasets/:projectId — structured parsed content for a project
 *   POST /query               — intent-based project search
 */

const RPC_BASE = "https://api.shelbynet.shelby.xyz";

// ═══════════════════════════════════════════════════════════════
// Standardized Content Parsing
// ═══════════════════════════════════════════════════════════════

interface ParsedContent {
  type: "json" | "csv" | "text" | "binary";
  parsed: unknown;
  keys?: string[];
  rowCount?: number;
  keywords?: string[];
  preview: string;
}

function parseContent(contentPreview: string | null, fileType: string | null): ParsedContent {
  if (!contentPreview) {
    return { type: "binary", parsed: null, preview: "(binary or empty content)" };
  }

  const text = contentPreview.trim();

  // JSON
  if (fileType === "json" || text.startsWith("{") || text.startsWith("[")) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) {
        const keys = parsed.length > 0 && typeof parsed[0] === "object" && parsed[0] !== null
          ? Object.keys(parsed[0])
          : [];
        return {
          type: "json",
          parsed: parsed.slice(0, 3),  // first 3 rows as preview
          keys,
          rowCount: parsed.length,
          preview: JSON.stringify(parsed.slice(0, 2), null, 2).slice(0, 500),
        };
      } else if (typeof parsed === "object" && parsed !== null) {
        const keys = Object.keys(parsed);
        return {
          type: "json",
          parsed,
          keys,
          preview: JSON.stringify(parsed, null, 2).slice(0, 500),
        };
      }
      return { type: "json", parsed, preview: String(parsed).slice(0, 500) };
    } catch {
      // Not valid JSON, fall through to text
    }
  }

  // CSV
  if (fileType === "csv" || (text.includes(",") && text.includes("\n"))) {
    const lines = text.split("\n").filter(l => l.trim());
    if (lines.length >= 2) {
      const headers = lines[0].split(",").map(h => h.trim().replace(/^"|"$/g, ""));
      const rows = lines.slice(1).map(line => {
        const vals = line.split(",").map(v => v.trim().replace(/^"|"$/g, ""));
        const row: Record<string, string> = {};
        headers.forEach((h, i) => { row[h] = vals[i] ?? ""; });
        return row;
      });
      return {
        type: "csv",
        parsed: rows.slice(0, 5),  // first 5 data rows
        keys: headers,
        rowCount: lines.length - 1,
        preview: lines.slice(0, 4).join("\n"),
      };
    }
  }

  // Text — extract keywords
  const words = text.toLowerCase().match(/\b[a-z]{3,}\b/g) ?? [];
  const freq = new Map<string, number>();
  const stopWords = new Set(["the", "and", "for", "are", "this", "that", "with", "has", "was", "not", "from", "but", "have", "will"]);
  for (const w of words) {
    if (!stopWords.has(w)) freq.set(w, (freq.get(w) ?? 0) + 1);
  }
  const keywords = [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([w]) => w);

  return {
    type: "text",
    parsed: text.slice(0, 1000),
    keywords,
    preview: text.slice(0, 500),
  };
}

function buildBlobUrl(wallet: string, blobName: string): string {
  return `${RPC_BASE}/v1/accounts/${wallet}/resource/${encodeURIComponent(blobName)}`;
}

// ═══════════════════════════════════════════════════════════════
// Route Registration
// ═══════════════════════════════════════════════════════════════

export async function aiRoutes(app: FastifyInstance): Promise<void> {

  // ── GET /datasets/:projectId ────────────────────────────────
  app.get<{
    Params: { projectId: string };
    Querystring: { limit?: string };
  }>("/datasets/:projectId", async (request, reply) => {
    const projectId = decodeURIComponent(request.params.projectId);
    const limit = Math.min(100, Math.max(1, Number(request.query.limit) || 50));

    const project = await prisma.project.findUnique({ where: { id: projectId } });
    if (!project) {
      return reply.status(404).send({ error: "Project not found", projectId });
    }

    // Get blobs with metadata
    const blobs = await prisma.blob.findMany({
      where: { projectId },
      include: { metadata: true },
      orderBy: { createdAt: "desc" },
      take: limit,
    });

    // Compute project signals
    const quality = computeQuality(project);
    const intent = classifyProject(project);
    const stage = computeStage(project);
    const momentum = computeMomentum(project);
    const opportunity = computeOpportunity({ stage, quality, momentum, walletCount: project.walletCount, intent });
    const { confidence, confidenceLevel } = computeConfidence(project);

    // Parse each blob's content
    const parsedBlobs = blobs.map(b => {
      const colonIdx = b.blobId.indexOf(":");
      const blobName = colonIdx >= 0 ? b.blobId.slice(colonIdx + 1) : b.blobId;
      const parsed = parseContent(b.metadata?.contentPreview ?? null, b.metadata?.fileType ?? null);

      return {
        blobId: b.blobId,
        blobName,
        wallet: b.wallet,
        fileType: b.metadata?.fileType ?? null,
        size: b.size.toString(),
        contentType: b.contentType,
        tags: b.metadata?.tags ?? [],
        signals: b.metadata?.signals ?? [],
        url: buildBlobUrl(b.wallet, blobName),
        createdAt: b.createdAt.toISOString(),
        content: {
          type: parsed.type,
          keys: parsed.keys ?? null,
          rowCount: parsed.rowCount ?? null,
          keywords: parsed.keywords ?? null,
          preview: parsed.preview,
          parsed: parsed.parsed,
        },
      };
    });

    // Aggregate content summary
    const typeCounts: Record<string, number> = {};
    const allKeys = new Set<string>();
    const allKeywords = new Set<string>();
    for (const b of parsedBlobs) {
      const t = b.content.type;
      typeCounts[t] = (typeCounts[t] ?? 0) + 1;
      if (b.content.keys) b.content.keys.forEach(k => allKeys.add(k));
      if (b.content.keywords) b.content.keywords.forEach(k => allKeywords.add(k));
    }

    return reply.send({
      project: {
        id: project.id,
        label: project.label,
        category: project.category,
        intent,
        stage,
        quality,
        confidence,
        confidenceLevel,
        opportunity,
        momentum,
        walletCount: project.walletCount,
        blobCount: project.blobCount,
        fileTypes: project.fileTypes,
        tags: project.tags,
        signals: project.signals,
        firstSeen: project.firstSeen.toISOString(),
        lastActive: project.lastActive.toISOString(),
      },
      contentSummary: {
        totalBlobs: blobs.length,
        typeCounts,
        allKeys: [...allKeys].slice(0, 50),
        allKeywords: [...allKeywords].slice(0, 30),
      },
      blobs: parsedBlobs,
    });
  });

  // ── POST /query ─────────────────────────────────────────────
  app.post<{
    Body: { intent: string; limit?: number };
  }>("/query", async (request, reply) => {
    const { intent: queryIntent, limit: rawLimit } = request.body ?? {} as { intent?: string; limit?: number };

    if (!queryIntent || typeof queryIntent !== "string") {
      return reply.status(400).send({ error: "Missing 'intent' string in request body" });
    }

    const limit = Math.min(20, Math.max(1, rawLimit ?? 10));
    const queryLower = queryIntent.toLowerCase();

    // Load all projects
    const projects = await prisma.project.findMany({
      where: { blobCount: { gte: 2 } },
      orderBy: [{ walletCount: "desc" }, { blobCount: "desc" }],
      take: 100,
    });

    // Score each project against the query intent
    const scored = projects.map(p => {
      let relevance = 0;
      const reasons: string[] = [];

      // Match against tags
      for (const tag of p.tags) {
        if (queryLower.includes(tag.toLowerCase()) || tag.toLowerCase().includes(queryLower)) {
          relevance += 20;
          reasons.push(`Tag match: ${tag}`);
        }
      }

      // Match against signals
      for (const sig of p.signals) {
        const sigLower = sig.toLowerCase().replace(/_/g, " ");
        if (queryLower.includes(sigLower) || sigLower.includes(queryLower)) {
          relevance += 25;
          reasons.push(`Signal match: ${sig}`);
        }
      }

      // Match against file types
      for (const ft of p.fileTypes) {
        if (queryLower.includes(ft)) {
          relevance += 10;
          reasons.push(`File type: ${ft}`);
        }
      }

      // Match against category
      if (queryLower.includes(p.category)) {
        relevance += 15;
        reasons.push(`Category: ${p.category}`);
      }

      // Intent keyword matching
      const intentKeywords: Record<string, string[]> = {
        ai: ["ai", "model", "training", "inference", "agent", "llm", "neural", "prompt", "ml", "machine learning"],
        trading: ["trading", "trade", "price", "market", "defi", "swap", "finance", "portfolio"],
        data: ["data", "dataset", "csv", "json", "export", "analytics", "metrics"],
        config: ["config", "configuration", "deploy", "deployment", "settings", "infrastructure"],
        media: ["media", "image", "video", "audio", "photo", "picture"],
      };

      for (const [category, keywords] of Object.entries(intentKeywords)) {
        const matchCount = keywords.filter(kw => queryLower.includes(kw)).length;
        if (matchCount > 0) {
          // Check if project has matching signals/tags
          const hasMatch = p.signals.some(s => s.toLowerCase().includes(category)) ||
                          p.tags.some(t => t.toLowerCase().includes(category)) ||
                          p.category.includes(category);
          if (hasMatch) {
            relevance += matchCount * 15;
            reasons.push(`Intent category: ${category} (${matchCount} keyword matches)`);
          }
        }
      }

      // Label matching
      const labelLower = p.label.toLowerCase();
      const queryWords = queryLower.split(/\s+/);
      for (const word of queryWords) {
        if (word.length >= 3 && labelLower.includes(word)) {
          relevance += 10;
          reasons.push(`Label match: "${word}"`);
        }
      }

      // Compute intelligence signals
      const quality = computeQuality(p);
      const intent = classifyProject(p);
      const stage = computeStage(p);
      const momentum = computeMomentum(p);
      const opportunity = computeOpportunity({ stage, quality, momentum, walletCount: p.walletCount, intent });
      const conf = computeConfidence(p);

      // Boost by quality + confidence
      relevance = Math.round(relevance * (0.5 + (conf.confidence / 200)) * (0.5 + (quality / 200)));

      // Penalize MEDIA_SPAM unless query is explicitly about media
      if (intent === "MEDIA_SPAM" && !queryLower.includes("media")) {
        relevance = Math.round(relevance * 0.2);
      }

      return {
        projectId: p.id,
        label: p.label,
        relevance,
        reason: reasons.length > 0 ? reasons.join("; ") : "No direct match — browse all projects",
        intent,
        stage,
        quality,
        confidence: conf.confidence,
        confidenceLevel: conf.confidenceLevel,
        opportunity,
        walletCount: p.walletCount,
        blobCount: p.blobCount,
        fileTypes: p.fileTypes,
        tags: p.tags.filter(t => !t.startsWith("account:")).slice(0, 10),
        signals: p.signals,
        datasetUrl: `/datasets/${encodeURIComponent(p.id)}`,
        firstSeen: p.firstSeen.toISOString(),
        lastActive: p.lastActive.toISOString(),
      };
    });

    // Filter + sort
    const results = scored
      .filter(s => s.relevance > 0)
      .sort((a, b) => b.relevance - a.relevance || b.confidence - a.confidence)
      .slice(0, limit);

    // If no matches, return top projects by opportunity
    if (results.length === 0) {
      const fallback = scored
        .sort((a, b) => b.opportunity - a.opportunity)
        .slice(0, Math.min(5, limit));
      return reply.send({
        query: queryIntent,
        matchType: "fallback",
        message: `No direct matches for "${queryIntent}". Showing top projects by opportunity.`,
        results: fallback,
        total: fallback.length,
      });
    }

    return reply.send({
      query: queryIntent,
      matchType: "intent",
      results,
      total: results.length,
    });
  });
}
