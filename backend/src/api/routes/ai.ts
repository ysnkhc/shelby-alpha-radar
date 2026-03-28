import type { FastifyInstance } from "fastify";
import { prisma } from "../../database/db.js";
import {
  computeConfidence,
  computeStage,
  computeMomentum,
  computeOpportunity,
  computeQuality,
  classifyProject,
  type ProjectIntent,
  type ProjectStage,
  type ConfidenceLevel,
} from "../../indexer/insightEngine.js";

/**
 * AI Consumption Layer v2 — Actionable API
 *
 * AI agents can consume AND act without additional processing:
 *   GET  /datasets/:projectId          — full structured dataset
 *   GET  /datasets/:projectId/sample   — quick sample (3 blobs)
 *   POST /query                        — intent search with inline data
 *   POST /tasks/train-dataset          — ML-ready structured output
 */

const RPC_BASE = "https://api.shelbynet.shelby.xyz";

// ═══════════════════════════════════════════════════════════════
// Content Parsing
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
    return { type: "binary", parsed: null, preview: "(binary or empty)" };
  }

  const text = contentPreview.trim();

  // JSON
  if (fileType === "json" || text.startsWith("{") || text.startsWith("[")) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) {
        const keys = parsed.length > 0 && typeof parsed[0] === "object" && parsed[0] !== null
          ? Object.keys(parsed[0]) : [];
        return {
          type: "json", parsed: parsed.slice(0, 5), keys,
          rowCount: parsed.length,
          preview: JSON.stringify(parsed.slice(0, 2), null, 2).slice(0, 500),
        };
      } else if (typeof parsed === "object" && parsed !== null) {
        return { type: "json", parsed, keys: Object.keys(parsed),
          preview: JSON.stringify(parsed, null, 2).slice(0, 500) };
      }
      return { type: "json", parsed, preview: String(parsed).slice(0, 500) };
    } catch { /* fall through */ }
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
        type: "csv", parsed: rows.slice(0, 10), keys: headers,
        rowCount: lines.length - 1,
        preview: lines.slice(0, 4).join("\n"),
      };
    }
  }

  // Text — keywords
  const words = text.toLowerCase().match(/\b[a-z]{3,}\b/g) ?? [];
  const freq = new Map<string, number>();
  const stops = new Set(["the","and","for","are","this","that","with","has","was","not","from","but","have","will"]);
  for (const w of words) { if (!stops.has(w)) freq.set(w, (freq.get(w) ?? 0) + 1); }
  const keywords = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([w]) => w);

  return { type: "text", parsed: text.slice(0, 1000), keywords, preview: text.slice(0, 500) };
}

function buildBlobUrl(wallet: string, blobName: string): string {
  return `${RPC_BASE}/v1/accounts/${wallet}/resource/${encodeURIComponent(blobName)}`;
}

// ═══════════════════════════════════════════════════════════════
// Agent Hints — actionable guidance for AI consumers
// ═══════════════════════════════════════════════════════════════

interface AgentHints {
  bestUse: string;
  difficulty: "easy" | "medium" | "hard";
  expectedOutcome: string;
  suggestedActions: string[];
  dataQuality: "high" | "medium" | "low";
}

function generateAgentHints(p: {
  intent: ProjectIntent; stage: ProjectStage; quality: number;
  confidence: number; confidenceLevel: ConfidenceLevel;
  fileTypes: string[]; blobCount: number; walletCount: number;
  signals: string[];
}): AgentHints {

  const hasStructured = p.fileTypes.some(ft => ["json","csv","yaml","toml","xml","parquet"].includes(ft));

  let bestUse: string;
  let difficulty: AgentHints["difficulty"];
  let expectedOutcome: string;
  const suggestedActions: string[] = [];

  switch (p.intent) {
    case "AI_PIPELINE":
      bestUse = "Extract AI model configs, prompts, or training parameters for analysis or replication";
      difficulty = hasStructured ? "easy" : "medium";
      expectedOutcome = "Structured AI/ML configuration data ready for pipeline integration";
      suggestedActions.push("Parse JSON blobs for model parameters", "Extract prompt templates", "Cross-reference with other AI projects");
      break;
    case "DATASET":
      bestUse = "Use as training data, analytics source, or feature engineering input";
      difficulty = "easy";
      expectedOutcome = "Tabular or structured data ready for ML ingestion";
      suggestedActions.push("Load CSV/JSON into dataframe", "Check schema consistency across blobs", "Use /tasks/train-dataset for ML-ready format");
      break;
    case "CONFIG_DEPLOYMENT":
      bestUse = "Analyze deployment patterns, extract infrastructure configs";
      difficulty = "medium";
      expectedOutcome = "Configuration objects and deployment manifests";
      suggestedActions.push("Parse config files for service topology", "Extract environment variables", "Map deployment dependencies");
      break;
    case "MIXED_PROJECT":
      bestUse = "Cross-reference multiple file types for holistic project understanding";
      difficulty = "medium";
      expectedOutcome = "Multi-modal data spanning configs, data, and documentation";
      suggestedActions.push("Categorize blobs by type first", "Extract structured data separately", "Build project knowledge graph");
      break;
    case "MEDIA_SPAM":
      bestUse = "Image/media analysis only — low signal-to-noise ratio";
      difficulty = "hard";
      expectedOutcome = "Raw media files with minimal metadata";
      suggestedActions.push("Skip unless specifically looking for media assets", "Check for embedded metadata in images");
      break;
    default:
      bestUse = "General exploration — inspect content to determine specific value";
      difficulty = hasStructured ? "easy" : "medium";
      expectedOutcome = "Mixed content requiring manual classification";
      suggestedActions.push("Sample first via /datasets/:id/sample", "Check file types and previews before full ingestion");
  }

  // Additional suggestions based on signals
  if (p.signals.includes("trading_data")) suggestedActions.push("Extract price/volume data for quantitative analysis");
  if (p.signals.includes("model_data")) suggestedActions.push("Extract model weights or training metrics");
  if (p.walletCount >= 3) suggestedActions.push("Analyze wallet collaboration patterns");
  if (p.blobCount >= 10) suggestedActions.push("Use pagination (limit param) for large datasets");

  const dataQuality: AgentHints["dataQuality"] = p.quality >= 65 ? "high" : p.quality >= 40 ? "medium" : "low";

  return { bestUse, difficulty, expectedOutcome, suggestedActions: suggestedActions.slice(0, 5), dataQuality };
}

// ═══════════════════════════════════════════════════════════════
// Shared: compute project intelligence
// ═══════════════════════════════════════════════════════════════

function computeProjectIntel(p: {
  walletCount: number; blobCount: number; growthRate: number;
  fileTypes: string[]; tags: string[]; signals: string[];
  firstSeen: Date; lastActive: Date;
}) {
  const quality = computeQuality(p);
  const intent = classifyProject(p);
  const stage = computeStage(p);
  const momentum = computeMomentum(p);
  const opportunity = computeOpportunity({ stage, quality, momentum, walletCount: p.walletCount, intent });
  const { confidence, confidenceLevel } = computeConfidence(p);
  return { quality, intent, stage, momentum, opportunity, confidence, confidenceLevel };
}

// ═══════════════════════════════════════════════════════════════
// Shared: serialize blob for API response
// ═══════════════════════════════════════════════════════════════

function serializeBlob(b: {
  blobId: string; wallet: string; size: bigint; contentType: string | null;
  createdAt: Date;
  metadata: { fileType: string | null; tags: string[]; signals: string[]; contentPreview: string | null } | null;
}) {
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
      data: parsed.parsed,
    },
  };
}

// ═══════════════════════════════════════════════════════════════
// Routes
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
    if (!project) return reply.status(404).send({ error: "Project not found", projectId });

    const blobs = await prisma.blob.findMany({
      where: { projectId },
      include: { metadata: true },
      orderBy: { createdAt: "desc" },
      take: limit,
    });

    const intel = computeProjectIntel(project);
    const hints = generateAgentHints({
      ...intel, fileTypes: project.fileTypes, blobCount: project.blobCount,
      walletCount: project.walletCount, signals: project.signals,
    });

    const serialized = blobs.map(b => serializeBlob(b));

    // Aggregate
    const typeCounts: Record<string, number> = {};
    const allKeys = new Set<string>();
    const allKeywords = new Set<string>();
    for (const b of serialized) {
      typeCounts[b.content.type] = (typeCounts[b.content.type] ?? 0) + 1;
      if (b.content.keys) b.content.keys.forEach(k => allKeys.add(k));
      if (b.content.keywords) b.content.keywords.forEach(k => allKeywords.add(k));
    }

    return reply.send({
      project: {
        id: project.id, label: project.label, category: project.category,
        ...intel,
        walletCount: project.walletCount, blobCount: project.blobCount,
        fileTypes: project.fileTypes,
        tags: project.tags.filter(t => !t.startsWith("account:")),
        signals: project.signals,
        firstSeen: project.firstSeen.toISOString(),
        lastActive: project.lastActive.toISOString(),
      },
      agentHints: hints,
      contentSummary: {
        totalBlobs: blobs.length,
        typeCounts,
        allKeys: [...allKeys].slice(0, 50),
        allKeywords: [...allKeywords].slice(0, 30),
      },
      blobs: serialized,
    });
  });

  // ── GET /datasets/:projectId/sample ─────────────────────────
  app.get<{
    Params: { projectId: string };
  }>("/datasets/:projectId/sample", async (request, reply) => {
    const projectId = decodeURIComponent(request.params.projectId);

    const project = await prisma.project.findUnique({ where: { id: projectId } });
    if (!project) return reply.status(404).send({ error: "Project not found", projectId });

    // Get 3 most recent blobs with content
    const blobs = await prisma.blob.findMany({
      where: { projectId },
      include: { metadata: true },
      orderBy: { createdAt: "desc" },
      take: 3,
    });

    const intel = computeProjectIntel(project);
    const hints = generateAgentHints({
      ...intel, fileTypes: project.fileTypes, blobCount: project.blobCount,
      walletCount: project.walletCount, signals: project.signals,
    });

    return reply.send({
      projectId: project.id,
      label: project.label,
      intent: intel.intent,
      stage: intel.stage,
      confidence: intel.confidence,
      confidenceLevel: intel.confidenceLevel,
      quality: intel.quality,
      agentHints: hints,
      sampleSize: blobs.length,
      totalBlobs: project.blobCount,
      fullDatasetUrl: `/datasets/${encodeURIComponent(project.id)}`,
      sample: blobs.map(b => serializeBlob(b)),
    });
  });

  // ── POST /query (v2 — with inline data) ─────────────────────
  app.post<{
    Body: { intent: string; limit?: number; includeData?: boolean };
  }>("/query", async (request, reply) => {
    const { intent: queryIntent, limit: rawLimit, includeData } = request.body ?? {} as { intent?: string; limit?: number; includeData?: boolean };

    if (!queryIntent || typeof queryIntent !== "string") {
      return reply.status(400).send({ error: "Missing 'intent' string in request body" });
    }

    const limit = Math.min(20, Math.max(1, rawLimit ?? 10));
    const wantData = includeData !== false; // default true
    const queryLower = queryIntent.toLowerCase();

    const projects = await prisma.project.findMany({
      where: { blobCount: { gte: 2 } },
      orderBy: [{ walletCount: "desc" }, { blobCount: "desc" }],
      take: 100,
    });

    // Score projects
    const scored = await Promise.all(projects.map(async p => {
      let relevance = 0;
      const reasons: string[] = [];

      // Tag matching
      for (const tag of p.tags) {
        const tl = tag.toLowerCase();
        if (tl.startsWith("account:")) continue;
        if (queryLower.includes(tl) || tl.includes(queryLower)) {
          relevance += 20;
          reasons.push(`Tag: ${tag}`);
        }
      }

      // Signal matching
      for (const sig of p.signals) {
        const sl = sig.toLowerCase().replace(/_/g, " ");
        if (queryLower.includes(sl) || sl.includes(queryLower)) {
          relevance += 25;
          reasons.push(`Signal: ${sig}`);
        }
      }

      // File type matching
      for (const ft of p.fileTypes) {
        if (queryLower.includes(ft)) { relevance += 10; reasons.push(`Type: ${ft}`); }
      }

      // Category matching
      if (queryLower.includes(p.category)) { relevance += 15; reasons.push(`Category: ${p.category}`); }

      // Intent keyword matching
      const intentMap: Record<string, string[]> = {
        ai: ["ai","model","training","inference","agent","llm","neural","prompt","ml"],
        trading: ["trading","trade","price","market","defi","swap","finance"],
        data: ["data","dataset","csv","json","export","analytics","metrics"],
        config: ["config","deploy","deployment","settings","infrastructure"],
        media: ["media","image","video","audio","photo"],
      };
      for (const [cat, kws] of Object.entries(intentMap)) {
        const mc = kws.filter(k => queryLower.includes(k)).length;
        if (mc > 0) {
          const hasMatch = p.signals.some(s => s.toLowerCase().includes(cat)) ||
            p.tags.some(t => t.toLowerCase().includes(cat)) || p.category.includes(cat);
          if (hasMatch) { relevance += mc * 15; reasons.push(`Intent: ${cat}`); }
        }
      }

      // Label matching
      const ll = p.label.toLowerCase();
      for (const w of queryLower.split(/\s+/)) {
        if (w.length >= 3 && ll.includes(w)) { relevance += 10; reasons.push(`Label: "${w}"`); }
      }

      // Intelligence
      const intel = computeProjectIntel(p);

      // Confidence/quality boost
      relevance = Math.round(relevance * (0.5 + intel.confidence / 200) * (0.5 + intel.quality / 200));

      // Penalize MEDIA_SPAM
      if (intel.intent === "MEDIA_SPAM" && !queryLower.includes("media")) {
        relevance = Math.round(relevance * 0.2);
      }

      const hints = generateAgentHints({
        ...intel, fileTypes: p.fileTypes, blobCount: p.blobCount,
        walletCount: p.walletCount, signals: p.signals,
      });

      // Inline sample data if requested
      let sampleData: ReturnType<typeof serializeBlob>[] | null = null;
      if (wantData && relevance > 0) {
        const sampleBlobs = await prisma.blob.findMany({
          where: { projectId: p.id },
          include: { metadata: true },
          orderBy: { createdAt: "desc" },
          take: 3,
        });
        sampleData = sampleBlobs.map(b => serializeBlob(b));
      }

      return {
        projectId: p.id,
        label: p.label,
        relevance,
        reason: reasons.length > 0 ? reasons.join("; ") : "No direct match",
        ...intel,
        walletCount: p.walletCount,
        blobCount: p.blobCount,
        fileTypes: p.fileTypes,
        tags: p.tags.filter(t => !t.startsWith("account:")).slice(0, 10),
        signals: p.signals,
        agentHints: hints,
        sampleData,
        datasetUrl: `/datasets/${encodeURIComponent(p.id)}`,
        sampleUrl: `/datasets/${encodeURIComponent(p.id)}/sample`,
        firstSeen: p.firstSeen.toISOString(),
        lastActive: p.lastActive.toISOString(),
      };
    }));

    const results = scored
      .filter(s => s.relevance > 0)
      .sort((a, b) => b.relevance - a.relevance || b.confidence - a.confidence)
      .slice(0, limit);

    if (results.length === 0) {
      const fallback = scored
        .sort((a, b) => b.opportunity - a.opportunity)
        .slice(0, Math.min(5, limit));
      return reply.send({
        query: queryIntent, matchType: "fallback",
        message: `No direct matches for "${queryIntent}". Top projects by opportunity.`,
        results: fallback, total: fallback.length,
      });
    }

    return reply.send({
      query: queryIntent, matchType: "intent",
      results, total: results.length,
    });
  });

  // ── POST /tasks/train-dataset ───────────────────────────────
  app.post<{
    Body: { projectId: string; format?: "jsonl" | "csv" | "json"; maxRows?: number };
  }>("/tasks/train-dataset", async (request, reply) => {
    const { projectId: rawId, format, maxRows } = request.body ?? {} as { projectId?: string; format?: string; maxRows?: number };

    if (!rawId) {
      return reply.status(400).send({ error: "Missing 'projectId' in request body" });
    }

    const projectId = decodeURIComponent(rawId);
    const outputFormat = format ?? "jsonl";
    const rowLimit = Math.min(1000, Math.max(1, maxRows ?? 500));

    const project = await prisma.project.findUnique({ where: { id: projectId } });
    if (!project) return reply.status(404).send({ error: "Project not found", projectId });

    const intel = computeProjectIntel(project);

    // Get all blobs with content
    const blobs = await prisma.blob.findMany({
      where: { projectId },
      include: { metadata: true },
      orderBy: { createdAt: "asc" },
      take: rowLimit,
    });

    // Build training rows
    const rows: Record<string, unknown>[] = [];
    const schema: Set<string> = new Set();

    for (const b of blobs) {
      const parsed = parseContent(b.metadata?.contentPreview ?? null, b.metadata?.fileType ?? null);
      const colonIdx = b.blobId.indexOf(":");
      const blobName = colonIdx >= 0 ? b.blobId.slice(colonIdx + 1) : b.blobId;

      const baseRow = {
        _id: b.blobId,
        _source: blobName,
        _wallet: b.wallet,
        _type: parsed.type,
        _fileType: b.metadata?.fileType ?? null,
        _tags: b.metadata?.tags ?? [],
        _signals: b.metadata?.signals ?? [],
        _timestamp: b.createdAt.toISOString(),
        _url: buildBlobUrl(b.wallet, blobName),
      };

      Object.keys(baseRow).forEach(k => schema.add(k));

      if (parsed.type === "json" && parsed.parsed !== null) {
        if (Array.isArray(parsed.parsed)) {
          // Flatten array items into individual rows
          for (const item of parsed.parsed) {
            if (typeof item === "object" && item !== null) {
              const row = { ...baseRow, ...item as Record<string, unknown> };
              Object.keys(item as Record<string, unknown>).forEach(k => schema.add(k));
              rows.push(row);
            } else {
              rows.push({ ...baseRow, _value: item });
              schema.add("_value");
            }
          }
        } else if (typeof parsed.parsed === "object") {
          const row = { ...baseRow, ...parsed.parsed as Record<string, unknown> };
          Object.keys(parsed.parsed as Record<string, unknown>).forEach(k => schema.add(k));
          rows.push(row);
        }
      } else if (parsed.type === "csv" && Array.isArray(parsed.parsed)) {
        for (const item of parsed.parsed) {
          const row = { ...baseRow, ...item as Record<string, unknown> };
          Object.keys(item as Record<string, unknown>).forEach(k => schema.add(k));
          rows.push(row);
        }
      } else if (parsed.type === "text" && parsed.parsed) {
        rows.push({
          ...baseRow,
          _content: String(parsed.parsed),
          _keywords: parsed.keywords ?? [],
        });
        schema.add("_content");
        schema.add("_keywords");
      } else {
        // Binary/empty — just metadata row
        rows.push(baseRow);
      }

      if (rows.length >= rowLimit) break;
    }

    const finalRows = rows.slice(0, rowLimit);

    // Format output
    let output: string | unknown;
    let contentType: string;

    if (outputFormat === "jsonl") {
      output = finalRows.map(r => JSON.stringify(r)).join("\n");
      contentType = "application/jsonl";
    } else if (outputFormat === "csv") {
      const cols = [...schema];
      const header = cols.join(",");
      const csvRows = finalRows.map(r =>
        cols.map(c => {
          const v = (r as Record<string, unknown>)[c];
          const s = v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
          return s.includes(",") || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s;
        }).join(",")
      );
      output = [header, ...csvRows].join("\n");
      contentType = "text/csv";
    } else {
      output = finalRows;
      contentType = "application/json";
    }

    return reply
      .header("content-type", contentType)
      .send({
        task: "train-dataset",
        projectId: project.id,
        label: project.label,
        intent: intel.intent,
        stage: intel.stage,
        confidence: intel.confidence,
        confidenceLevel: intel.confidenceLevel,
        quality: intel.quality,
        format: outputFormat,
        schema: [...schema],
        totalRows: finalRows.length,
        totalBlobsProcessed: blobs.length,
        agentHints: {
          bestUse: intel.intent === "DATASET" ? "Direct ML training data" : "Feature engineering input",
          columns: [...schema].filter(c => !c.startsWith("_")),
          metaColumns: [...schema].filter(c => c.startsWith("_")),
          rowsAvailable: finalRows.length,
          format: outputFormat,
          note: "Meta columns (prefixed with _) contain provenance data. Data columns contain parsed blob content.",
        },
        data: output,
      });
  });
}
