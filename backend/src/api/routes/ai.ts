import type { FastifyInstance } from "fastify";
import { prisma } from "../../database/db.js";
import { createOrUpdateDataset } from "../../datasets/datasetService.js";
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
 * AI Data Layer v3 — Automated Intelligence
 *
 * Zero-decision API for AI agents:
 *   GET  /datasets/:projectId          — full dataset + scoring + safety
 *   GET  /datasets/:projectId/sample   — quick preview (3 blobs)
 *   GET  /datasets/:projectId/updates  — delta since timestamp
 *   POST /query                        — intent search with inline data
 *   POST /tasks/train-dataset          — ML-ready output
 *   POST /pipelines/discover-and-prepare — auto-discover + return ready data
 *   POST /subscriptions                — register for new dataset notifications
 *   GET  /subscriptions                — list active subscriptions
 *   GET  /subscriptions/check          — poll for new matches
 */

const RPC_BASE = "https://api.shelbynet.shelby.xyz";

// ═══════════════════════════════════════════════════════════════
// In-Memory Subscription Store
// ═══════════════════════════════════════════════════════════════

interface Subscription {
  id: string;
  intent: string;
  minQuality: number;
  minConfidence: number;
  createdAt: string;
  lastChecked: string;
}

const subscriptions = new Map<string, Subscription>();
let subCounter = 0;

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
  if (!contentPreview) return { type: "binary", parsed: null, preview: "(binary or empty)" };
  const text = contentPreview.trim();

  if (fileType === "json" || text.startsWith("{") || text.startsWith("[")) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) {
        const keys = parsed.length > 0 && typeof parsed[0] === "object" && parsed[0] !== null
          ? Object.keys(parsed[0]) : [];
        return { type: "json", parsed: parsed.slice(0, 5), keys, rowCount: parsed.length,
          preview: JSON.stringify(parsed.slice(0, 2), null, 2).slice(0, 500) };
      } else if (typeof parsed === "object" && parsed !== null) {
        return { type: "json", parsed, keys: Object.keys(parsed),
          preview: JSON.stringify(parsed, null, 2).slice(0, 500) };
      }
      return { type: "json", parsed, preview: String(parsed).slice(0, 500) };
    } catch { /* fall through */ }
  }

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
      return { type: "csv", parsed: rows.slice(0, 10), keys: headers,
        rowCount: lines.length - 1, preview: lines.slice(0, 4).join("\n") };
    }
  }

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
// Dataset Scoring
// ═══════════════════════════════════════════════════════════════

interface DatasetScore {
  qualityScore: number;     // 0-100: overall data quality
  completeness: number;     // 0-100: how complete is the data
  consistency: number;      // 0-100: how consistent is the schema
  freshness: number;        // 0-100: how recent
  usability: number;        // 0-100: composite score for AI consumption
}

function computeDatasetScore(p: {
  quality: number; confidence: number; blobCount: number;
  fileTypes: string[]; signals: string[];
  firstSeen: Date; lastActive: Date;
}, blobs: { metadata: { fileType: string | null; contentPreview: string | null; tags: string[]; signals: string[] } | null }[]): DatasetScore {

  // Quality: based on content intelligence
  const qualityScore = p.quality;

  // Completeness: ratio of blobs with actual content + metadata
  const withContent = blobs.filter(b => b.metadata?.contentPreview).length;
  const withType = blobs.filter(b => b.metadata?.fileType).length;
  const withTags = blobs.filter(b => (b.metadata?.tags?.length ?? 0) > 0).length;
  const completeness = blobs.length > 0
    ? Math.round(((withContent / blobs.length) * 40 + (withType / blobs.length) * 30 + (withTags / blobs.length) * 30))
    : 0;

  // Consistency: do blobs share the same file type / schema?
  const typeDist = new Map<string, number>();
  for (const b of blobs) {
    const t = b.metadata?.fileType ?? "unknown";
    typeDist.set(t, (typeDist.get(t) ?? 0) + 1);
  }
  const dominantTypeRatio = blobs.length > 0
    ? Math.max(...typeDist.values()) / blobs.length : 0;
  // High consistency if most blobs share a type, but not if it's "unknown"
  const mostCommonType = [...typeDist.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const consistency = mostCommonType && mostCommonType !== "unknown"
    ? Math.round(dominantTypeRatio * 100) : Math.round(dominantTypeRatio * 50);

  // Freshness decay
  const hrs = (Date.now() - p.lastActive.getTime()) / 3_600_000;
  const freshness = hrs < 1 ? 100 : hrs < 6 ? 80 : hrs < 24 ? 60 : hrs < 72 ? 40 : 20;

  // Usability composite
  const usability = Math.round(qualityScore * 0.3 + completeness * 0.25 + consistency * 0.2 + freshness * 0.1 + (p.confidence * 0.15));

  return { qualityScore, completeness, consistency, freshness, usability };
}

// ═══════════════════════════════════════════════════════════════
// Execution Safety
// ═══════════════════════════════════════════════════════════════

interface ExecutionSafety {
  safeToTrain: boolean;
  riskLevel: "low" | "medium" | "high";
  risks: string[];
  recommendations: string[];
}

function assessExecutionSafety(p: {
  intent: ProjectIntent; quality: number; confidence: number; confidenceLevel: ConfidenceLevel;
  blobCount: number; walletCount: number; consistency: number; completeness: number;
}): ExecutionSafety {
  const risks: string[] = [];
  const recommendations: string[] = [];
  let riskScore = 0;

  // Intent risks
  if (p.intent === "MEDIA_SPAM") { risks.push("Classified as MEDIA_SPAM — very low signal content"); riskScore += 40; }
  if (p.intent === "UNKNOWN") { risks.push("Unknown intent — content type not classified"); riskScore += 15; }

  // Quality risks
  if (p.quality < 30) { risks.push(`Low quality score (${p.quality}/100)`); riskScore += 20; }
  if (p.quality < 50) recommendations.push("Inspect content manually before training");

  // Confidence risks
  if (p.confidenceLevel === "LOW") { risks.push(`Low confidence (${p.confidence}/100) — possible false positive`); riskScore += 25; }
  if (p.confidenceLevel === "MEDIUM") { risks.push(`Medium confidence (${p.confidence}/100) — some uncertainty`); riskScore += 10; }

  // Data size risks
  if (p.blobCount < 3) { risks.push("Very small dataset — may not be statistically significant"); riskScore += 10; }
  if (p.blobCount > 500) recommendations.push("Large dataset — consider sampling first");

  // Consistency risks
  if (p.consistency < 30) { risks.push("Low schema consistency across blobs"); riskScore += 15; }
  if (p.completeness < 30) { risks.push("Low data completeness — many empty or unparseable blobs"); riskScore += 15; }

  // Single wallet risk
  if (p.walletCount === 1) { risks.push("Single wallet source — no cross-validation possible"); riskScore += 10; }

  // Recommendations
  if (p.quality >= 60 && p.confidence >= 60) recommendations.push("Dataset appears suitable for direct training");
  if (p.consistency >= 70) recommendations.push("High schema consistency — good for tabular ML");
  if (p.walletCount >= 3) recommendations.push("Multi-source data — good for validation");
  recommendations.push(riskScore < 20 ? "Proceed with standard pipeline" : riskScore < 40 ? "Proceed with validation step" : "Manual review recommended before use");

  const riskLevel: ExecutionSafety["riskLevel"] = riskScore < 20 ? "low" : riskScore < 40 ? "medium" : "high";
  const safeToTrain = riskLevel === "low" || (riskLevel === "medium" && p.quality >= 50 && p.confidence >= 50);

  return { safeToTrain, riskLevel, risks, recommendations: recommendations.slice(0, 5) };
}

// ═══════════════════════════════════════════════════════════════
// Agent Hints
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
  fileTypes: string[]; blobCount: number; walletCount: number; signals: string[];
}): AgentHints {
  const hasStructured = p.fileTypes.some(ft => ["json","csv","yaml","toml","xml","parquet"].includes(ft));
  let bestUse: string, difficulty: AgentHints["difficulty"], expectedOutcome: string;
  const suggestedActions: string[] = [];

  switch (p.intent) {
    case "AI_PIPELINE":
      bestUse = "Extract AI model configs, prompts, or training parameters";
      difficulty = hasStructured ? "easy" : "medium";
      expectedOutcome = "Structured AI/ML configuration data";
      suggestedActions.push("Parse JSON blobs for model parameters", "Extract prompt templates");
      break;
    case "DATASET":
      bestUse = "Training data, analytics, or feature engineering";
      difficulty = "easy";
      expectedOutcome = "Tabular or structured data ready for ML";
      suggestedActions.push("Use /tasks/train-dataset for ML-ready format", "Check schema consistency");
      break;
    case "CONFIG_DEPLOYMENT":
      bestUse = "Deployment pattern analysis, infrastructure configs";
      difficulty = "medium";
      expectedOutcome = "Configuration objects and manifests";
      suggestedActions.push("Parse config files for topology", "Extract environment variables");
      break;
    case "MIXED_PROJECT":
      bestUse = "Cross-reference multiple file types for holistic understanding";
      difficulty = "medium";
      expectedOutcome = "Multi-modal data spanning configs, data, docs";
      suggestedActions.push("Categorize blobs by type first", "Extract structured data separately");
      break;
    case "MEDIA_SPAM":
      bestUse = "Image/media analysis only — low signal";
      difficulty = "hard";
      expectedOutcome = "Raw media files with minimal metadata";
      suggestedActions.push("Skip unless specifically looking for media");
      break;
    default:
      bestUse = "General exploration — inspect to determine value";
      difficulty = hasStructured ? "easy" : "medium";
      expectedOutcome = "Mixed content requiring classification";
      suggestedActions.push("Sample first via /datasets/:id/sample");
  }
  if (p.signals.includes("trading_data")) suggestedActions.push("Extract price/volume data");
  if (p.walletCount >= 3) suggestedActions.push("Analyze wallet collaboration patterns");
  suggestedActions.push("Use /pipelines/discover-and-prepare for automated setup");

  const dataQuality: AgentHints["dataQuality"] = p.quality >= 65 ? "high" : p.quality >= 40 ? "medium" : "low";
  return { bestUse, difficulty, expectedOutcome, suggestedActions: suggestedActions.slice(0, 5), dataQuality };
}

// ═══════════════════════════════════════════════════════════════
// Shared Helpers
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

function serializeBlob(b: {
  blobId: string; wallet: string; size: bigint; contentType: string | null;
  createdAt: Date;
  metadata: { fileType: string | null; tags: string[]; signals: string[]; contentPreview: string | null } | null;
}) {
  const colonIdx = b.blobId.indexOf(":");
  const blobName = colonIdx >= 0 ? b.blobId.slice(colonIdx + 1) : b.blobId;
  const parsed = parseContent(b.metadata?.contentPreview ?? null, b.metadata?.fileType ?? null);
  return {
    blobId: b.blobId, blobName, wallet: b.wallet,
    fileType: b.metadata?.fileType ?? null, size: b.size.toString(),
    contentType: b.contentType,
    tags: b.metadata?.tags ?? [], signals: b.metadata?.signals ?? [],
    url: buildBlobUrl(b.wallet, blobName),
    createdAt: b.createdAt.toISOString(),
    content: { type: parsed.type, keys: parsed.keys ?? null, rowCount: parsed.rowCount ?? null,
      keywords: parsed.keywords ?? null, preview: parsed.preview, data: parsed.parsed },
  };
}

// Intent matching (shared between /query and subscriptions)
function scoreProjectForIntent(p: {
  id: string; label: string; category: string;
  tags: string[]; signals: string[]; fileTypes: string[];
  walletCount: number; blobCount: number; growthRate: number;
  firstSeen: Date; lastActive: Date;
}, queryLower: string) {
  let relevance = 0;
  const reasons: string[] = [];

  for (const tag of p.tags) {
    const tl = tag.toLowerCase();
    if (tl.startsWith("account:")) continue;
    if (queryLower.includes(tl) || tl.includes(queryLower)) { relevance += 20; reasons.push(`Tag: ${tag}`); }
  }
  for (const sig of p.signals) {
    const sl = sig.toLowerCase().replace(/_/g, " ");
    if (queryLower.includes(sl) || sl.includes(queryLower)) { relevance += 25; reasons.push(`Signal: ${sig}`); }
  }
  for (const ft of p.fileTypes) {
    if (queryLower.includes(ft)) { relevance += 10; reasons.push(`Type: ${ft}`); }
  }
  if (queryLower.includes(p.category)) { relevance += 15; reasons.push(`Category: ${p.category}`); }

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

  const ll = p.label.toLowerCase();
  for (const w of queryLower.split(/\s+/)) {
    if (w.length >= 3 && ll.includes(w)) { relevance += 10; reasons.push(`Label: "${w}"`); }
  }

  const intel = computeProjectIntel(p);
  relevance = Math.round(relevance * (0.5 + intel.confidence / 200) * (0.5 + intel.quality / 200));
  if (intel.intent === "MEDIA_SPAM" && !queryLower.includes("media")) relevance = Math.round(relevance * 0.2);

  return { relevance, reasons, intel };
}

// Build ML rows from blobs
function buildTrainingRows(blobs: {
  blobId: string; wallet: string; createdAt: Date;
  metadata: { fileType: string | null; tags: string[]; signals: string[]; contentPreview: string | null } | null;
}[], rowLimit: number) {
  const rows: Record<string, unknown>[] = [];
  const schema = new Set<string>();

  for (const b of blobs) {
    const parsed = parseContent(b.metadata?.contentPreview ?? null, b.metadata?.fileType ?? null);
    const colonIdx = b.blobId.indexOf(":");
    const blobName = colonIdx >= 0 ? b.blobId.slice(colonIdx + 1) : b.blobId;
    const baseRow = {
      _id: b.blobId, _source: blobName, _wallet: b.wallet, _type: parsed.type,
      _fileType: b.metadata?.fileType ?? null, _tags: b.metadata?.tags ?? [],
      _signals: b.metadata?.signals ?? [], _timestamp: b.createdAt.toISOString(),
      _url: buildBlobUrl(b.wallet, blobName),
    };
    Object.keys(baseRow).forEach(k => schema.add(k));

    if (parsed.type === "json" && parsed.parsed !== null) {
      if (Array.isArray(parsed.parsed)) {
        for (const item of parsed.parsed) {
          if (typeof item === "object" && item !== null) {
            const row = { ...baseRow, ...item as Record<string, unknown> };
            Object.keys(item as Record<string, unknown>).forEach(k => schema.add(k));
            rows.push(row);
          } else { rows.push({ ...baseRow, _value: item }); schema.add("_value"); }
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
      rows.push({ ...baseRow, _content: String(parsed.parsed), _keywords: parsed.keywords ?? [] });
      schema.add("_content"); schema.add("_keywords");
    } else {
      rows.push(baseRow);
    }
    if (rows.length >= rowLimit) break;
  }
  return { rows: rows.slice(0, rowLimit), schema: [...schema] };
}

// ═══════════════════════════════════════════════════════════════
// Routes
// ═══════════════════════════════════════════════════════════════

export async function aiRoutes(app: FastifyInstance): Promise<void> {

  // ── GET /datasets/:projectId/sample ─────────────────────────
  app.get<{ Params: { projectId: string } }>("/datasets/:projectId/sample", async (request, reply) => {
    const projectId = decodeURIComponent(request.params.projectId);
    const project = await prisma.project.findUnique({ where: { id: projectId } });
    if (!project) return reply.status(404).send({ error: "Project not found", projectId });

    const blobs = await prisma.blob.findMany({
      where: { projectId }, include: { metadata: true },
      orderBy: { createdAt: "desc" }, take: 3,
    });

    const intel = computeProjectIntel(project);
    const dsScore = computeDatasetScore({ ...intel, ...project }, blobs);
    const safety = assessExecutionSafety({ ...intel, ...dsScore, blobCount: project.blobCount, walletCount: project.walletCount });
    const hints = generateAgentHints({ ...intel, fileTypes: project.fileTypes, blobCount: project.blobCount, walletCount: project.walletCount, signals: project.signals });

    return reply.send({
      projectId: project.id, label: project.label,
      intent: intel.intent, stage: intel.stage,
      confidence: intel.confidence, confidenceLevel: intel.confidenceLevel,
      quality: intel.quality,
      datasetScore: dsScore, executionSafety: safety, agentHints: hints,
      sampleSize: blobs.length, totalBlobs: project.blobCount,
      fullDatasetUrl: `/datasets/${encodeURIComponent(project.id)}`,
      sample: blobs.map(b => serializeBlob(b)),
    });
  });

  // ── GET /datasets/:projectId/updates ────────────────────────
  app.get<{ Params: { projectId: string }; Querystring: { since?: string } }>("/datasets/:projectId/updates", async (request, reply) => {
    const projectId = decodeURIComponent(request.params.projectId);
    const since = request.query.since ? new Date(request.query.since) : new Date(Date.now() - 3_600_000);

    if (isNaN(since.getTime())) return reply.status(400).send({ error: "Invalid 'since' timestamp" });

    const project = await prisma.project.findUnique({ where: { id: projectId } });
    if (!project) return reply.status(404).send({ error: "Project not found", projectId });

    const newBlobs = await prisma.blob.findMany({
      where: { projectId, createdAt: { gt: since } },
      include: { metadata: true },
      orderBy: { createdAt: "desc" },
      take: 50,
    });

    const intel = computeProjectIntel(project);

    return reply.send({
      projectId: project.id, label: project.label,
      since: since.toISOString(),
      now: new Date().toISOString(),
      newBlobCount: newBlobs.length,
      totalBlobCount: project.blobCount,
      hasChanges: newBlobs.length > 0,
      projectStatus: { intent: intel.intent, stage: intel.stage, quality: intel.quality, confidence: intel.confidence },
      newBlobs: newBlobs.map(b => serializeBlob(b)),
      nextPollUrl: `/datasets/${encodeURIComponent(project.id)}/updates?since=${new Date().toISOString()}`,
    });
  });

  // ── GET /datasets/:projectId ────────────────────────────────
  app.get<{ Params: { projectId: string }; Querystring: { limit?: string } }>("/datasets/:projectId", async (request, reply) => {
    const projectId = decodeURIComponent(request.params.projectId);
    const limit = Math.min(100, Math.max(1, Number(request.query.limit) || 50));

    const project = await prisma.project.findUnique({ where: { id: projectId } });
    if (!project) return reply.status(404).send({ error: "Project not found", projectId });

    const blobs = await prisma.blob.findMany({
      where: { projectId }, include: { metadata: true },
      orderBy: { createdAt: "desc" }, take: limit,
    });

    const intel = computeProjectIntel(project);
    const dsScore = computeDatasetScore({ ...intel, ...project }, blobs);
    const safety = assessExecutionSafety({ ...intel, ...dsScore, blobCount: project.blobCount, walletCount: project.walletCount });
    const hints = generateAgentHints({ ...intel, fileTypes: project.fileTypes, blobCount: project.blobCount, walletCount: project.walletCount, signals: project.signals });

    const serialized = blobs.map(b => serializeBlob(b));
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
        ...intel, walletCount: project.walletCount, blobCount: project.blobCount,
        fileTypes: project.fileTypes, tags: project.tags.filter(t => !t.startsWith("account:")),
        signals: project.signals, firstSeen: project.firstSeen.toISOString(), lastActive: project.lastActive.toISOString(),
      },
      datasetScore: dsScore, executionSafety: safety, agentHints: hints,
      contentSummary: { totalBlobs: blobs.length, typeCounts, allKeys: [...allKeys].slice(0, 50), allKeywords: [...allKeywords].slice(0, 30) },
      blobs: serialized,
      deltaUrl: `/datasets/${encodeURIComponent(project.id)}/updates?since=${new Date().toISOString()}`,
    });
  });

  // ── POST /query ─────────────────────────────────────────────
  app.post<{ Body: { intent: string; limit?: number; includeData?: boolean } }>("/query", async (request, reply) => {
    const { intent: queryIntent, limit: rawLimit, includeData } = request.body ?? {} as { intent?: string; limit?: number; includeData?: boolean };
    if (!queryIntent || typeof queryIntent !== "string") return reply.status(400).send({ error: "Missing 'intent' string" });

    const limit = Math.min(20, Math.max(1, rawLimit ?? 10));
    const wantData = includeData !== false;
    const queryLower = queryIntent.toLowerCase();

    const projects = await prisma.project.findMany({
      where: { blobCount: { gte: 2 } },
      orderBy: [{ walletCount: "desc" }, { blobCount: "desc" }], take: 100,
    });

    const scored = await Promise.all(projects.map(async p => {
      const { relevance, reasons, intel } = scoreProjectForIntent(p, queryLower);
      const hints = generateAgentHints({ ...intel, fileTypes: p.fileTypes, blobCount: p.blobCount, walletCount: p.walletCount, signals: p.signals });

      let sampleData: ReturnType<typeof serializeBlob>[] | null = null;
      let safety: ExecutionSafety | null = null;
      if (wantData && relevance > 0) {
        const sampleBlobs = await prisma.blob.findMany({
          where: { projectId: p.id }, include: { metadata: true },
          orderBy: { createdAt: "desc" }, take: 3,
        });
        sampleData = sampleBlobs.map(b => serializeBlob(b));
        const dsScore = computeDatasetScore({ ...intel, ...p }, sampleBlobs);
        safety = assessExecutionSafety({ ...intel, ...dsScore, blobCount: p.blobCount, walletCount: p.walletCount });
      }

      return {
        projectId: p.id, label: p.label, relevance,
        reason: reasons.length > 0 ? reasons.join("; ") : "No direct match",
        ...intel, walletCount: p.walletCount, blobCount: p.blobCount, fileTypes: p.fileTypes,
        tags: p.tags.filter(t => !t.startsWith("account:")).slice(0, 10), signals: p.signals,
        agentHints: hints, executionSafety: safety, sampleData,
        datasetUrl: `/datasets/${encodeURIComponent(p.id)}`,
        sampleUrl: `/datasets/${encodeURIComponent(p.id)}/sample`,
        trainUrl: `/tasks/train-dataset`,
        firstSeen: p.firstSeen.toISOString(), lastActive: p.lastActive.toISOString(),
      };
    }));

    const results = scored.filter(s => s.relevance > 0).sort((a, b) => b.relevance - a.relevance || b.confidence - a.confidence).slice(0, limit);
    if (results.length === 0) {
      const fallback = scored.sort((a, b) => b.opportunity - a.opportunity).slice(0, Math.min(5, limit));
      return reply.send({ query: queryIntent, matchType: "fallback", message: `No direct matches. Top by opportunity.`, results: fallback, total: fallback.length });
    }
    return reply.send({ query: queryIntent, matchType: "intent", results, total: results.length });
  });

  // ── POST /tasks/train-dataset ───────────────────────────────
  app.post<{ Body: { projectId: string; format?: "jsonl" | "csv" | "json"; maxRows?: number } }>("/tasks/train-dataset", async (request, reply) => {
    const { projectId: rawId, format, maxRows } = request.body ?? {} as { projectId?: string; format?: string; maxRows?: number };
    if (!rawId) return reply.status(400).send({ error: "Missing 'projectId'" });

    const projectId = decodeURIComponent(rawId);
    const outputFormat = format ?? "jsonl";
    const rowLimit = Math.min(1000, Math.max(1, maxRows ?? 500));

    const project = await prisma.project.findUnique({ where: { id: projectId } });
    if (!project) return reply.status(404).send({ error: "Project not found", projectId });

    const intel = computeProjectIntel(project);
    const blobs = await prisma.blob.findMany({
      where: { projectId }, include: { metadata: true },
      orderBy: { createdAt: "asc" }, take: rowLimit,
    });

    const dsScore = computeDatasetScore({ ...intel, ...project }, blobs);
    const safety = assessExecutionSafety({ ...intel, ...dsScore, blobCount: project.blobCount, walletCount: project.walletCount });
    const { rows: finalRows, schema } = buildTrainingRows(blobs, rowLimit);

    let output: string | unknown;
    if (outputFormat === "jsonl") output = finalRows.map(r => JSON.stringify(r)).join("\n");
    else if (outputFormat === "csv") {
      const cols = schema;
      const header = cols.join(",");
      const csvRows = finalRows.map(r => cols.map(c => {
        const v = (r as Record<string, unknown>)[c];
        const s = v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
        return s.includes(",") || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s;
      }).join(","));
      output = [header, ...csvRows].join("\n");
    } else output = finalRows;

    return reply.send({
      task: "train-dataset", projectId: project.id, label: project.label,
      ...intel, format: outputFormat, schema, totalRows: finalRows.length, totalBlobsProcessed: blobs.length,
      datasetScore: dsScore, executionSafety: safety,
      agentHints: { columns: schema.filter(c => !c.startsWith("_")), metaColumns: schema.filter(c => c.startsWith("_")),
        rowsAvailable: finalRows.length, format: outputFormat, note: "Meta columns (_) = provenance. Data columns = parsed content." },
      data: output,
    });
  });

  // ── POST /pipelines/discover-and-prepare ────────────────────
  app.post<{ Body: { intent: string; minQuality?: number; minConfidence?: number; maxResults?: number; format?: "jsonl" | "csv" | "json" } }>("/pipelines/discover-and-prepare", async (request, reply) => {
    const { intent, minQuality, minConfidence, maxResults, format } = request.body ?? {} as { intent?: string; minQuality?: number; minConfidence?: number; maxResults?: number; format?: string };
    if (!intent || typeof intent !== "string") return reply.status(400).send({ error: "Missing 'intent' string" });

    const qMin = minQuality ?? 40;
    const cMin = minConfidence ?? 40;
    const rMax = Math.min(10, maxResults ?? 5);
    const outFormat = format ?? "json";
    const queryLower = intent.toLowerCase();

    // 1. Discover matching projects
    const projects = await prisma.project.findMany({
      where: { blobCount: { gte: 2 } },
      orderBy: [{ walletCount: "desc" }, { blobCount: "desc" }], take: 100,
    });

    const candidates = projects.map(p => {
      const { relevance, reasons, intel } = scoreProjectForIntent(p, queryLower);
      return { ...p, relevance, reasons, intel };
    }).filter(p => p.relevance > 0 && p.intel.quality >= qMin && p.intel.confidence >= cMin)
      .sort((a, b) => b.relevance - a.relevance)
      .slice(0, rMax);

    if (candidates.length === 0) {
      return reply.send({
        pipeline: "discover-and-prepare", intent, status: "no_matches",
        message: `No projects match "${intent}" with quality≥${qMin} and confidence≥${cMin}.`,
        datasets: [], totalDatasets: 0,
      });
    }

    // 2. Prepare each matched dataset
    const datasets = await Promise.all(candidates.map(async c => {
      const blobs = await prisma.blob.findMany({
        where: { projectId: c.id }, include: { metadata: true },
        orderBy: { createdAt: "asc" }, take: 200,
      });

      const dsScore = computeDatasetScore({ ...c.intel, ...c }, blobs);
      const safety = assessExecutionSafety({ ...c.intel, ...dsScore, blobCount: c.blobCount, walletCount: c.walletCount });
      const hints = generateAgentHints({ ...c.intel, fileTypes: c.fileTypes, blobCount: c.blobCount, walletCount: c.walletCount, signals: c.signals });
      const { rows, schema } = buildTrainingRows(blobs, 200);

      let output: string | unknown;
      if (outFormat === "jsonl") output = rows.map(r => JSON.stringify(r)).join("\n");
      else if (outFormat === "csv") {
        const header = schema.join(",");
        const csvRows = rows.map(r => schema.map(col => {
          const v = (r as Record<string, unknown>)[col];
          const s = v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
          return s.includes(",") || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s;
        }).join(","));
        output = [header, ...csvRows].join("\n");
      } else output = rows;

      return {
        projectId: c.id, label: c.label, relevance: c.relevance,
        reason: c.reasons.join("; "),
        ...c.intel, datasetScore: dsScore, executionSafety: safety, agentHints: hints,
        schema, totalRows: rows.length, format: outFormat, data: output,
        deltaUrl: `/datasets/${encodeURIComponent(c.id)}/updates?since=${new Date().toISOString()}`,
      };
    }));

    return reply.send({
      pipeline: "discover-and-prepare", intent, status: "ready",
      filters: { minQuality: qMin, minConfidence: cMin },
      totalDatasets: datasets.length,
      datasets,
    });
  });

  // ── POST /subscriptions ─────────────────────────────────────
  app.post<{ Body: { intent: string; minQuality?: number; minConfidence?: number } }>("/subscriptions", async (request, reply) => {
    const { intent, minQuality, minConfidence } = request.body ?? {} as { intent?: string; minQuality?: number; minConfidence?: number };
    if (!intent || typeof intent !== "string") return reply.status(400).send({ error: "Missing 'intent' string" });

    const id = `sub_${++subCounter}_${Date.now()}`;
    const sub: Subscription = {
      id, intent,
      minQuality: minQuality ?? 40,
      minConfidence: minConfidence ?? 40,
      createdAt: new Date().toISOString(),
      lastChecked: new Date().toISOString(),
    };
    subscriptions.set(id, sub);

    return reply.send({
      subscription: sub,
      checkUrl: `/subscriptions/check?id=${id}`,
      message: `Subscription created. Poll /subscriptions/check?id=${id} for new matching datasets.`,
    });
  });

  // ── GET /subscriptions ──────────────────────────────────────
  app.get("/subscriptions", async (_request, reply) => {
    return reply.send({
      subscriptions: [...subscriptions.values()],
      total: subscriptions.size,
    });
  });

  // ── GET /subscriptions/check ────────────────────────────────
  app.get<{ Querystring: { id?: string } }>("/subscriptions/check", async (request, reply) => {
    const subId = request.query.id;
    if (!subId) return reply.status(400).send({ error: "Missing 'id' query parameter" });

    const sub = subscriptions.get(subId);
    if (!sub) return reply.status(404).send({ error: "Subscription not found", id: subId });

    const since = new Date(sub.lastChecked);

    // Find projects updated since last check
    const projects = await prisma.project.findMany({
      where: {
        blobCount: { gte: 2 },
        lastActive: { gt: since },
      },
      orderBy: { lastActive: "desc" },
      take: 50,
    });

    const queryLower = sub.intent.toLowerCase();
    const matches = projects
      .map(p => {
        const { relevance, reasons, intel } = scoreProjectForIntent(p, queryLower);
        return { projectId: p.id, label: p.label, relevance, reason: reasons.join("; "), ...intel,
          blobCount: p.blobCount, walletCount: p.walletCount,
          datasetUrl: `/datasets/${encodeURIComponent(p.id)}`,
          lastActive: p.lastActive.toISOString() };
      })
      .filter(m => m.relevance > 0 && m.quality >= sub.minQuality && m.confidence >= sub.minConfidence)
      .sort((a, b) => b.relevance - a.relevance)
      .slice(0, 10);

    // Update lastChecked
    sub.lastChecked = new Date().toISOString();

    return reply.send({
      subscriptionId: sub.id, intent: sub.intent,
      since: since.toISOString(), checkedAt: sub.lastChecked,
      hasNewMatches: matches.length > 0,
      newMatches: matches,
      total: matches.length,
      nextCheckUrl: `/subscriptions/check?id=${sub.id}`,
    });
  });

  // ── POST /dataset/build ──────────────────────────────────────
  app.post<{ Body: { projectId: string; type?: string } }>("/dataset/build", async (request, reply) => {
    const { projectId: rawId, type } = request.body ?? {} as { projectId?: string; type?: string };
    if (!rawId || typeof rawId !== "string") return reply.status(400).send({ error: "Missing 'projectId' string" });

    const projectId = decodeURIComponent(rawId);
    try {
      const result = await createOrUpdateDataset(projectId, type);
      return reply.send({
        dataset: {
          id: result.dataset.id,
          projectId: result.dataset.projectId,
          type: result.dataset.type,
          status: result.dataset.status,
          schema: result.dataset.schema,
          rowCount: result.dataset.rowCount,
          createdAt: result.dataset.createdAt.toISOString(),
          updatedAt: result.dataset.updatedAt.toISOString(),
        },
        version: {
          id: result.version.id,
          datasetId: result.version.datasetId,
          version: result.version.version,
          blobIds: result.version.blobIds,
          schema: result.version.schema,
          rowCount: result.version.rowCount,
          createdAt: result.version.createdAt.toISOString(),
        },
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes("not found")) return reply.status(404).send({ error: msg });
      return reply.status(500).send({ error: "Dataset build failed", detail: msg });
    }
  });
}
