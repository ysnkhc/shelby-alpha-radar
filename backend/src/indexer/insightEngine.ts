import { prisma } from "../database/db.js";

/**
 * Insight Engine v2 — Intent-Aware Intelligence
 *
 * Quality scoring + project classification + diminishing returns
 * to filter noise and surface genuinely interesting activity.
 *
 * Key changes from v1:
 *  - Quality score (0-100) penalizes repetitive file types, rewards diversity
 *  - Project classification: MEDIA_SPAM, DATASET, AI_PIPELINE, CONFIG_DEPLOYMENT, UNKNOWN
 *  - Diminishing returns on wallet count (caps at 20, heavily after 50+)
 *  - Final importance = raw importance × quality multiplier
 *  - Alerts only fire on meaningful transitions, not incremental wallet joins
 */

// ── Public Types ──────────────────────────────────────────────

export type ProjectIntent =
  | "MEDIA_SPAM"
  | "DATASET"
  | "AI_PIPELINE"
  | "CONFIG_DEPLOYMENT"
  | "MIXED_PROJECT"
  | "UNKNOWN";

export interface Insight {
  id: string;
  title: string;
  narrative: string;
  whyItMatters: string;
  importance: number;        // 0-100 final (raw × quality)
  quality: number;           // 0-100 content quality
  category: "project" | "ai" | "data" | "rare" | "alert";
  intent: ProjectIntent;
  projectId: string | null;
  projectLabel: string | null;
  walletCount: number;
  blobCount: number;
  signals: string[];
  timestamp: string;
  timeAgo: string;
}

export interface ProjectSummary {
  projectId: string;
  label: string;
  category: string;
  intent: ProjectIntent;
  status: "active" | "growing" | "dormant";
  quality: number;
  wallets: string[];
  walletCount: number;
  blobCount: number;
  growthRate: number;
  tags: string[];
  signals: string[];
  fileTypes: string[];
  firstSeen: string;
  lastActive: string;
  importance: number;
  topInsight: string | null;
  recentSignals: { type: string; score: number; explanation: string }[];
}

export interface Alert {
  id: string;
  level: "critical" | "high" | "watch";
  title: string;
  message: string;
  projectId: string | null;
  importance: number;
  timestamp: string;
}

// ═══════════════════════════════════════════════════════════════
// QUALITY SCORING
// ═══════════════════════════════════════════════════════════════

/**
 * Compute a 0-100 quality score for a project.
 *
 * Rewards:
 *  - File type diversity (mixed ecosystems)
 *  - Structured content (JSON, CSV, configs)
 *  - Domain-specific signals (AI, trading)
 *
 * Penalties:
 *  - Single file type dominance (>80% same type)
 *  - Pure media with no structured data
 *  - No content signals at all
 */
export function computeQuality(params: {
  fileTypes: string[];
  tags: string[];
  signals: string[];
  blobCount: number;
}): number {
  let quality = 50; // baseline

  // ── File type diversity ──────────────────────────
  const typeCount = params.fileTypes.length;
  if (typeCount >= 4) quality += 20;
  else if (typeCount >= 3) quality += 15;
  else if (typeCount >= 2) quality += 5;
  else quality -= 10; // single type = penalty

  // ── Structured content reward ────────────────────
  const structured = new Set(["json", "csv", "yaml", "yml", "toml", "xml", "parquet", "arrow"]);
  const hasStructured = params.fileTypes.some((t) => structured.has(t));
  if (hasStructured) quality += 15;

  // ── Config/code presence reward ──────────────────
  const configTypes = new Set(["config", "logs", "ai_data", "dataset"]);
  const configHits = params.tags.filter((t) => configTypes.has(t)).length;
  quality += Math.min(15, configHits * 5);

  // ── Domain signal reward ─────────────────────────
  const domainSignals = new Set(["ai_interaction", "model_data", "agent_config", "trading_data"]);
  const signalHits = params.signals.filter((s) => domainSignals.has(s)).length;
  quality += Math.min(15, signalHits * 8);

  // ── Media-only penalty ───────────────────────────
  const mediaTypes = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "mp3", "mp4", "wav", "avi", "mov"]);
  const allMedia = params.fileTypes.length > 0 && params.fileTypes.every((t) => mediaTypes.has(t));
  if (allMedia) {
    quality -= 30;
    // Extra penalty for high-volume pure media
    if (params.blobCount > 20) quality -= 10;
  }

  // ── No signals penalty ───────────────────────────
  if (params.signals.length === 0 && params.tags.length <= 2) {
    quality -= 10;
  }

  return Math.max(0, Math.min(100, quality));
}

// ═══════════════════════════════════════════════════════════════
// PROJECT CLASSIFICATION
// ═══════════════════════════════════════════════════════════════

/**
 * Classify project intent based on file types, tags, and signals.
 */
export function classifyProject(params: {
  fileTypes: string[];
  tags: string[];
  signals: string[];
  blobCount: number;
  walletCount: number;
}): ProjectIntent {
  const mediaTypes = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "mp3", "mp4", "wav", "avi", "mov"]);
  const allMedia = params.fileTypes.length > 0 && params.fileTypes.every((t) => mediaTypes.has(t));

  // MEDIA_SPAM: all media files, many wallets, no domain signals
  if (allMedia && params.signals.length === 0 && params.walletCount > 5) {
    return "MEDIA_SPAM";
  }

  // AI_PIPELINE: has AI-related signals
  const aiSignals = ["ai_interaction", "model_data", "agent_config"];
  if (params.signals.some((s) => aiSignals.includes(s))) {
    return "AI_PIPELINE";
  }

  // CONFIG_DEPLOYMENT: has config tags + domain signals
  if (params.tags.includes("config") && params.signals.length > 0) {
    return "CONFIG_DEPLOYMENT";
  }

  // DATASET: has dataset tags or structured data files
  const dataTypes = new Set(["csv", "parquet", "arrow", "json", "npy", "feather"]);
  if (params.tags.includes("dataset") || params.fileTypes.some((t) => dataTypes.has(t))) {
    return "DATASET";
  }

  // MIXED_PROJECT: multiple file types with some substance
  if (params.fileTypes.length >= 3 && !allMedia) {
    return "MIXED_PROJECT";
  }

  return "UNKNOWN";
}

// ═══════════════════════════════════════════════════════════════
// IMPORTANCE SCORING (v2 — with quality + diminishing returns)
// ═══════════════════════════════════════════════════════════════

/**
 * Compute final importance = raw importance × quality multiplier.
 *
 * Diminishing returns on wallet count:
 *   1-5:   full credit (5pts each)
 *   6-20:  2pts each
 *   21-50: 0.5pts each
 *   50+:   0pts (capped)
 */
export function computeImportance(params: {
  walletCount: number;
  blobCount: number;
  growthRate: number;
  signals: string[];
  tags: string[];
  fileTypes: string[];
  signalScore?: number;
}): { raw: number; quality: number; final: number; intent: ProjectIntent } {
  const quality = computeQuality({
    fileTypes: params.fileTypes,
    tags: params.tags,
    signals: params.signals,
    blobCount: params.blobCount,
  });

  const intent = classifyProject({
    fileTypes: params.fileTypes,
    tags: params.tags,
    signals: params.signals,
    blobCount: params.blobCount,
    walletCount: params.walletCount,
  });

  let raw = 0;

  // ── Multi-wallet with diminishing returns ────────
  const wc = params.walletCount;
  if (wc <= 5) raw += wc * 5;          // 1-5: full credit
  else if (wc <= 20) raw += 25 + (wc - 5) * 2;  // 6-20: +2 each
  else if (wc <= 50) raw += 55 + (wc - 20) * 0.5; // 21-50: +0.5 each
  else raw += 70;                       // 50+: capped at 70

  // ── Content value ────────────────────────────────
  const highValueSignals = new Set(["ai_interaction", "model_data", "agent_config", "trading_data"]);
  const contentHits = params.signals.filter((s) => highValueSignals.has(s)).length;
  raw += Math.min(20, contentHits * 8);

  // ── Growth rate ──────────────────────────────────
  if (params.growthRate >= 10) raw += 15;
  else if (params.growthRate >= 5) raw += 10;
  else if (params.growthRate >= 2) raw += 5;

  // ── Signal score bonus ───────────────────────────
  if (params.signalScore && params.signalScore >= 9) raw += 10;
  else if (params.signalScore && params.signalScore >= 7) raw += 5;

  raw = Math.min(100, raw);

  // ── Apply quality multiplier ─────────────────────
  // quality 0-100 maps to multiplier 0.1-1.0
  const qualityMultiplier = 0.1 + (quality / 100) * 0.9;
  const final = Math.round(raw * qualityMultiplier);

  return { raw, quality, final, intent };
}

// ═══════════════════════════════════════════════════════════════
// INSIGHT GENERATOR
// ═══════════════════════════════════════════════════════════════

export async function generateInsights(limit = 20): Promise<Insight[]> {
  const recentEvents = await prisma.alphaEvent.findMany({
    where: { score: { gte: 7 } },
    orderBy: [{ score: "desc" }, { createdAt: "desc" }],
    take: limit * 2,
  });

  const projects = await prisma.project.findMany({
    where: { blobCount: { gte: 2 } },
    orderBy: [{ walletCount: "desc" }, { blobCount: "desc" }],
    take: 50,
  });

  const projectMap = new Map(projects.map((p) => [p.id, p]));

  // Deduplicate by project — keep highest-scored event per project
  const seen = new Map<string, typeof recentEvents[0]>();
  for (const event of recentEvents) {
    const projectId = findProjectForEvent(event, projects);
    const key = projectId ?? `standalone:${event.id}`;
    if (!seen.has(key) || event.score > (seen.get(key)?.score ?? 0)) {
      seen.set(key, event);
    }
  }

  const insights: Insight[] = [];
  for (const [key, event] of seen) {
    const projectId = key.startsWith("standalone:") ? null : key;
    const project = projectId ? projectMap.get(projectId) ?? null : null;

    const { quality, final: importance, intent } = computeImportance({
      walletCount: project?.walletCount ?? 1,
      blobCount: project?.blobCount ?? 1,
      growthRate: project?.growthRate ?? 0,
      signals: project?.signals ?? [],
      tags: project?.tags ?? [],
      fileTypes: project?.fileTypes ?? [],
      signalScore: event.score,
    });

    // Skip low-quality spam entirely
    if (intent === "MEDIA_SPAM" && importance < 20) continue;

    const category = categorizeSignal(event.signalType);
    const { title, narrative, whyItMatters } = generateNarrative(event, project, intent);

    insights.push({
      id: `insight-${event.id}`,
      title,
      narrative,
      whyItMatters,
      importance,
      quality,
      category,
      intent,
      projectId,
      projectLabel: project?.label ?? null,
      walletCount: project?.walletCount ?? 1,
      blobCount: project?.blobCount ?? 1,
      signals: project?.signals ?? [event.signalType],
      timestamp: event.createdAt.toISOString(),
      timeAgo: getTimeAgo(event.createdAt),
    });
  }

  return insights
    .sort((a, b) => b.importance - a.importance)
    .slice(0, limit);
}

// ═══════════════════════════════════════════════════════════════
// PROJECT SUMMARIES
// ═══════════════════════════════════════════════════════════════

export async function getProjectSummaries(limit = 20): Promise<ProjectSummary[]> {
  const projects = await prisma.project.findMany({
    where: { blobCount: { gte: 2 } },
    orderBy: [{ walletCount: "desc" }, { blobCount: "desc" }],
    take: limit * 2, // fetch more, then filter/rank
  });

  const now = new Date();

  const summaries = projects.map((p) => {
    const hoursSinceActive = (now.getTime() - p.lastActive.getTime()) / 3_600_000;

    let status: "active" | "growing" | "dormant";
    if (hoursSinceActive < 1 && p.growthRate >= 1) status = "growing";
    else if (hoursSinceActive < 6) status = "active";
    else status = "dormant";

    const { quality, final, intent } = computeImportance({
      walletCount: p.walletCount,
      blobCount: p.blobCount,
      growthRate: p.growthRate,
      signals: p.signals,
      tags: p.tags,
      fileTypes: p.fileTypes,
    });

    const topInsight = generateProjectInsight(p, status, intent);

    return {
      projectId: p.id,
      label: p.label,
      category: p.category,
      intent,
      status,
      quality,
      wallets: p.wallets.slice(0, 10).map((w) => `${w.slice(0, 8)}...${w.slice(-4)}`),
      walletCount: p.walletCount,
      blobCount: p.blobCount,
      growthRate: p.growthRate,
      tags: p.tags.filter((t) => !t.startsWith("account:")).slice(0, 10),
      signals: p.signals,
      fileTypes: p.fileTypes,
      firstSeen: p.firstSeen.toISOString(),
      lastActive: p.lastActive.toISOString(),
      importance: final,
      topInsight,
      recentSignals: [],
    };
  });

  return summaries
    .sort((a, b) => b.importance - a.importance)
    .slice(0, limit);
}

// ═══════════════════════════════════════════════════════════════
// ALERTS (v2 — meaningful transitions only)
// ═══════════════════════════════════════════════════════════════

export async function generateAlerts(): Promise<Alert[]> {
  const alerts: Alert[] = [];
  const now = new Date();
  const oneHourAgo = new Date(now.getTime() - 3_600_000);

  // Alert 1: Non-spam multi-wallet projects with high activity
  const hotProjects = await prisma.project.findMany({
    where: {
      walletCount: { gte: 3 },
      lastActive: { gte: oneHourAgo },
      growthRate: { gte: 2 },
    },
    orderBy: { walletCount: "desc" },
    take: 10,
  });

  for (const p of hotProjects) {
    const { quality, final, intent } = computeImportance({
      walletCount: p.walletCount,
      blobCount: p.blobCount,
      growthRate: p.growthRate,
      signals: p.signals,
      tags: p.tags,
      fileTypes: p.fileTypes,
    });

    // Skip media spam from alerts entirely
    if (intent === "MEDIA_SPAM") continue;
    // Skip low-quality projects
    if (quality < 30) continue;

    alerts.push({
      id: `alert-project-${p.id}`,
      level: final >= 60 ? "critical" : "high",
      title: `🔥 ${p.label}`,
      message: generateProjectInsight(p, "growing", intent),
      projectId: p.id,
      importance: final,
      timestamp: p.lastActive.toISOString(),
    });
  }

  // Alert 2: AI projects (these are always interesting)
  const aiProjects = await prisma.project.findMany({
    where: {
      category: "ai",
      lastActive: { gte: oneHourAgo },
      blobCount: { gte: 3 },
    },
    orderBy: { blobCount: "desc" },
    take: 3,
  });

  for (const p of aiProjects) {
    if (alerts.some((a) => a.projectId === p.id)) continue;

    const { final } = computeImportance({
      walletCount: p.walletCount,
      blobCount: p.blobCount,
      growthRate: p.growthRate,
      signals: p.signals,
      tags: p.tags,
      fileTypes: p.fileTypes,
    });

    alerts.push({
      id: `alert-ai-${p.id}`,
      level: "high",
      title: `🤖 ${p.label}`,
      message: `AI project with ${p.blobCount} files from ${p.walletCount} wallet(s). Signals: ${p.signals.join(", ")}`,
      projectId: p.id,
      importance: final,
      timestamp: p.lastActive.toISOString(),
    });
  }

  // Alert 3: High-score events (only truly unique signal types, deduped)
  const highScoreEvents = await prisma.alphaEvent.findMany({
    where: {
      score: { gte: 9 },
      createdAt: { gte: oneHourAgo },
      signalType: { notIn: ["MULTI_WALLET_PROJECT"] }, // skip incremental wallet joins
    },
    orderBy: { score: "desc" },
    take: 3,
  });

  for (const e of highScoreEvents) {
    alerts.push({
      id: `alert-event-${e.id}`,
      level: "watch",
      title: `⚡ ${e.signalType.replace(/_/g, " ")}`,
      message: e.explanation,
      projectId: null,
      importance: e.score * 10,
      timestamp: e.createdAt.toISOString(),
    });
  }

  return alerts.sort((a, b) => b.importance - a.importance);
}

// ═══════════════════════════════════════════════════════════════
// INTERNAL HELPERS
// ═══════════════════════════════════════════════════════════════

function findProjectForEvent(
  event: { owner: string },
  projects: { id: string; wallets: string[] }[]
): string | null {
  for (const p of projects) {
    if (p.wallets.includes(event.owner)) return p.id;
  }
  return null;
}

function categorizeSignal(signalType: string): Insight["category"] {
  if (signalType.includes("WALLET") || signalType.includes("PROJECT") || signalType.includes("GROWTH")) return "project";
  if (signalType.includes("AI") || signalType.includes("AGENT")) return "ai";
  if (signalType.includes("DATA") || signalType.includes("DATASET")) return "data";
  if (signalType.includes("RARE")) return "rare";
  return "project";
}

interface ProjectLike {
  label: string;
  walletCount: number;
  blobCount: number;
  growthRate: number;
  category: string;
  signals: string[];
  tags: string[];
  fileTypes: string[];
}

function generateProjectInsight(project: ProjectLike, status: string, intent: ProjectIntent): string {
  // Intent-aware insight generation
  if (intent === "MEDIA_SPAM") {
    return `Low-value media collection — ${project.walletCount} wallets uploading ${project.fileTypes.join("/")} files with no structured content.`;
  }

  const parts: string[] = [];

  if (project.walletCount > 1) {
    parts.push(`${project.walletCount} wallets collaborating`);
  }

  if (status === "growing") {
    parts.push(`${project.growthRate} files/hour`);
  }

  // Domain-specific insight
  const domainSignals = project.signals.filter((s) =>
    ["ai_interaction", "model_data", "trading_data", "agent_config"].includes(s)
  );
  if (domainSignals.length > 0) {
    parts.push(`detected ${domainSignals.join(" + ")} activity`);
  }

  if (project.fileTypes.length > 2) {
    parts.push(`${project.fileTypes.length} file types (${project.fileTypes.join(", ")})`);
  }

  if (intent !== "UNKNOWN") {
    const intentLabels: Record<ProjectIntent, string> = {
      MEDIA_SPAM: "",
      DATASET: "building a dataset",
      AI_PIPELINE: "running an AI pipeline",
      CONFIG_DEPLOYMENT: "deploying configurations",
      MIXED_PROJECT: "multi-component project",
      UNKNOWN: "",
    };
    if (intentLabels[intent]) parts.push(intentLabels[intent]);
  }

  return parts.length > 0 ? parts.join(" · ") + "." : "Monitoring for further activity.";
}

function generateNarrative(
  event: { signalType: string; explanation: string; score: number },
  project: ProjectLike | null,
  intent: ProjectIntent
): { title: string; narrative: string; whyItMatters: string } {
  let title: string;
  if (intent === "MEDIA_SPAM") {
    title = "Media Upload Activity";
  } else if (project && project.walletCount > 1) {
    title = project.label;
  } else {
    title = event.signalType.replace(/_/g, " ");
  }

  const narrative = event.explanation;

  const whyItMattersMap: Record<string, string> = {
    MULTI_WALLET_PROJECT: "Multiple wallets converging on the same project indicates organized development — this rarely happens by coincidence.",
    PROJECT_GROWTH: "Sustained file accumulation indicates real momentum — active building, not just testing.",
    AI_TRAINING: "AI model training on decentralized storage indicates sophisticated ML workflows.",
    AI_INFERENCE: "Real-time inference outputs suggest a live production AI system.",
    AGENT_DEPLOYMENT: "Autonomous agent deployments represent cutting-edge on-chain automation.",
    DATA_PIPELINE: "Sustained data upload rates indicate production ETL or automated data collection.",
    DATASET_FORMATION: "Large datasets forming on-chain suggest training data preparation or research archives.",
    RARE_FILE_TYPE: "Novel file formats expand the ecosystem and signal new use cases.",
  };

  const whyItMatters = whyItMattersMap[event.signalType]
    ?? `Scored ${event.score}/10 — top-tier detected activity.`;

  return { title, narrative, whyItMatters };
}

function getTimeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
