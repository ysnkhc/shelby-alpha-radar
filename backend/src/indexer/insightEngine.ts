import { prisma } from "../database/db.js";

/**
 * Insight Engine v3 — Decision Engine
 *
 * Adds to v2 (quality + intent):
 *  - Project stage: EARLY → EMERGING → GROWING → SATURATED → DYING
 *  - Momentum score: recent growth vs historical baseline
 *  - Opportunity score: early-stage + high-quality + high-momentum = alpha
 *
 * The opportunity score is the PRIMARY ranking signal. It answers:
 * "What should I pay attention to RIGHT NOW?"
 */

// ── Public Types ──────────────────────────────────────────────

export type ProjectIntent =
  | "MEDIA_SPAM"
  | "DATASET"
  | "AI_PIPELINE"
  | "CONFIG_DEPLOYMENT"
  | "MIXED_PROJECT"
  | "UNKNOWN";

export type ProjectStage =
  | "EARLY"       // 1-3 blobs, 1-2 wallets — just discovered
  | "EMERGING"    // 4-10 blobs, growing — building momentum
  | "GROWING"     // 11-30 blobs, active — established project
  | "SATURATED"   // 30+ blobs, slowing — mature, less alpha
  | "DYING";      // no activity in 12+ hours — losing momentum

export interface Insight {
  id: string;
  title: string;
  narrative: string;
  whyItMatters: string;
  importance: number;
  quality: number;
  opportunity: number;
  stage: ProjectStage;
  momentum: number;
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
  stage: ProjectStage;
  status: "active" | "growing" | "dormant";
  quality: number;
  momentum: number;
  opportunity: number;
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
  opportunity: number;
  timestamp: string;
}

// ═══════════════════════════════════════════════════════════════
// PROJECT STAGE
// ═══════════════════════════════════════════════════════════════

export function computeStage(params: {
  blobCount: number;
  walletCount: number;
  growthRate: number;
  lastActive: Date;
}): ProjectStage {
  const hoursSinceActive = (Date.now() - params.lastActive.getTime()) / 3_600_000;

  // DYING: no activity in 12+ hours
  if (hoursSinceActive >= 12) return "DYING";

  // Stage by blob count + wallet count
  const blobs = params.blobCount;
  const wallets = params.walletCount;

  if (blobs <= 3 && wallets <= 2) return "EARLY";
  if (blobs <= 10) return "EMERGING";
  if (blobs <= 30) return "GROWING";

  // SATURATED: large + slowing
  if (params.growthRate < 1 || hoursSinceActive > 3) return "SATURATED";

  return "GROWING";
}

// ═══════════════════════════════════════════════════════════════
// MOMENTUM SCORE (0-100)
// ═══════════════════════════════════════════════════════════════

/**
 * Momentum = how is recent growth compared to historical?
 *
 * High momentum = accelerating project (bullish)
 * Low momentum = decelerating or stale (bearish)
 *
 * Formula: recent hourly rate vs overall hourly rate.
 */
export function computeMomentum(params: {
  growthRate: number;     // current blobs/hour
  blobCount: number;
  firstSeen: Date;
  lastActive: Date;
}): number {
  const totalHours = Math.max(1, (params.lastActive.getTime() - params.firstSeen.getTime()) / 3_600_000);
  const historicalRate = params.blobCount / totalHours;

  if (historicalRate === 0) return 50; // neutral

  const ratio = params.growthRate / historicalRate;

  // ratio > 2 = accelerating strongly
  // ratio 1-2 = steady/growing
  // ratio 0.5-1 = slowing
  // ratio < 0.5 = decelerating
  if (ratio >= 3) return 100;
  if (ratio >= 2) return 85;
  if (ratio >= 1.5) return 75;
  if (ratio >= 1) return 60;
  if (ratio >= 0.5) return 40;
  if (ratio >= 0.2) return 25;
  return 10;
}

// ═══════════════════════════════════════════════════════════════
// QUALITY SCORING (unchanged from v2)
// ═══════════════════════════════════════════════════════════════

export function computeQuality(params: {
  fileTypes: string[];
  tags: string[];
  signals: string[];
  blobCount: number;
}): number {
  let quality = 50;

  const typeCount = params.fileTypes.length;
  if (typeCount >= 4) quality += 20;
  else if (typeCount >= 3) quality += 15;
  else if (typeCount >= 2) quality += 5;
  else quality -= 10;

  const structured = new Set(["json", "csv", "yaml", "yml", "toml", "xml", "parquet", "arrow"]);
  if (params.fileTypes.some((t) => structured.has(t))) quality += 15;

  const configTypes = new Set(["config", "logs", "ai_data", "dataset"]);
  quality += Math.min(15, params.tags.filter((t) => configTypes.has(t)).length * 5);

  const domainSignals = new Set(["ai_interaction", "model_data", "agent_config", "trading_data"]);
  quality += Math.min(15, params.signals.filter((s) => domainSignals.has(s)).length * 8);

  const mediaTypes = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "mp3", "mp4", "wav", "avi", "mov"]);
  if (params.fileTypes.length > 0 && params.fileTypes.every((t) => mediaTypes.has(t))) {
    quality -= 30;
    if (params.blobCount > 20) quality -= 10;
  }

  if (params.signals.length === 0 && params.tags.length <= 2) quality -= 10;

  return Math.max(0, Math.min(100, quality));
}

// ═══════════════════════════════════════════════════════════════
// PROJECT CLASSIFICATION (unchanged from v2)
// ═══════════════════════════════════════════════════════════════

export function classifyProject(params: {
  fileTypes: string[];
  tags: string[];
  signals: string[];
  blobCount: number;
  walletCount: number;
}): ProjectIntent {
  const mediaTypes = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "mp3", "mp4", "wav", "avi", "mov"]);
  const allMedia = params.fileTypes.length > 0 && params.fileTypes.every((t) => mediaTypes.has(t));

  if (allMedia && params.signals.length === 0 && params.walletCount > 5) return "MEDIA_SPAM";

  const aiSignals = ["ai_interaction", "model_data", "agent_config"];
  if (params.signals.some((s) => aiSignals.includes(s))) return "AI_PIPELINE";

  if (params.tags.includes("config") && params.signals.length > 0) return "CONFIG_DEPLOYMENT";

  const dataTypes = new Set(["csv", "parquet", "arrow", "json", "npy", "feather"]);
  if (params.tags.includes("dataset") || params.fileTypes.some((t) => dataTypes.has(t))) return "DATASET";

  if (params.fileTypes.length >= 3 && !allMedia) return "MIXED_PROJECT";

  return "UNKNOWN";
}

// ═══════════════════════════════════════════════════════════════
// OPPORTUNITY SCORE (0-100) — THE CORE DECISION SIGNAL
// ═══════════════════════════════════════════════════════════════

/**
 * Opportunity = should I pay attention to this RIGHT NOW?
 *
 * Favors:  EARLY/EMERGING + high quality + high momentum
 * Penalizes: SATURATED/DYING, media spam, low quality
 *
 * Weights:
 *   Stage bonus:  0-30 pts (EARLY=30, EMERGING=25, GROWING=15, SATURATED=5, DYING=0)
 *   Quality:      0-30 pts (quality × 0.3)
 *   Momentum:     0-25 pts (momentum × 0.25)
 *   Multi-wallet: 0-15 pts (2+ wallets in early stage = big signal)
 */
export function computeOpportunity(params: {
  stage: ProjectStage;
  quality: number;
  momentum: number;
  walletCount: number;
  intent: ProjectIntent;
}): number {
  // Media spam = zero opportunity
  if (params.intent === "MEDIA_SPAM") return 0;

  let score = 0;

  // Stage bonus: early-stage is where the alpha is
  const stageBonus: Record<ProjectStage, number> = {
    EARLY: 30,
    EMERGING: 25,
    GROWING: 15,
    SATURATED: 5,
    DYING: 0,
  };
  score += stageBonus[params.stage];

  // Quality contribution
  score += Math.round(params.quality * 0.3);

  // Momentum contribution
  score += Math.round(params.momentum * 0.25);

  // Multi-wallet early-stage bonus (strongest signal)
  if (params.walletCount >= 2 && (params.stage === "EARLY" || params.stage === "EMERGING")) {
    score += 15;
  } else if (params.walletCount >= 2) {
    score += 5;
  }

  return Math.min(100, score);
}

// ═══════════════════════════════════════════════════════════════
// IMPORTANCE (with diminishing returns — from v2)
// ═══════════════════════════════════════════════════════════════

export function computeImportance(params: {
  walletCount: number;
  blobCount: number;
  growthRate: number;
  signals: string[];
  tags: string[];
  fileTypes: string[];
  signalScore?: number;
}): { quality: number; final: number; intent: ProjectIntent } {
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
  const wc = params.walletCount;
  if (wc <= 5) raw += wc * 5;
  else if (wc <= 20) raw += 25 + (wc - 5) * 2;
  else if (wc <= 50) raw += 55 + (wc - 20) * 0.5;
  else raw += 70;

  const highValueSignals = new Set(["ai_interaction", "model_data", "agent_config", "trading_data"]);
  raw += Math.min(20, params.signals.filter((s) => highValueSignals.has(s)).length * 8);

  if (params.growthRate >= 10) raw += 15;
  else if (params.growthRate >= 5) raw += 10;
  else if (params.growthRate >= 2) raw += 5;

  if (params.signalScore && params.signalScore >= 9) raw += 10;
  else if (params.signalScore && params.signalScore >= 7) raw += 5;

  raw = Math.min(100, raw);
  const qualityMultiplier = 0.1 + (quality / 100) * 0.9;
  const final = Math.round(raw * qualityMultiplier);

  return { quality, final, intent };
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

    const stage = project
      ? computeStage({ blobCount: project.blobCount, walletCount: project.walletCount, growthRate: project.growthRate, lastActive: project.lastActive })
      : "EARLY";

    const momentum = project
      ? computeMomentum({ growthRate: project.growthRate, blobCount: project.blobCount, firstSeen: project.firstSeen, lastActive: project.lastActive })
      : 50;

    const opportunity = computeOpportunity({ stage, quality, momentum, walletCount: project?.walletCount ?? 1, intent });

    if (intent === "MEDIA_SPAM" && importance < 20) continue;

    const category = categorizeSignal(event.signalType);
    const { title, narrative, whyItMatters } = generateNarrative(event, project, intent, stage, momentum, opportunity);

    insights.push({
      id: `insight-${event.id}`,
      title,
      narrative,
      whyItMatters,
      importance,
      quality,
      opportunity,
      stage,
      momentum,
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

  // Sort by OPPORTUNITY first, then importance
  return insights
    .sort((a, b) => b.opportunity - a.opportunity || b.importance - a.importance)
    .slice(0, limit);
}

// ═══════════════════════════════════════════════════════════════
// PROJECT SUMMARIES
// ═══════════════════════════════════════════════════════════════

export async function getProjectSummaries(limit = 20): Promise<ProjectSummary[]> {
  const projects = await prisma.project.findMany({
    where: { blobCount: { gte: 2 } },
    orderBy: [{ walletCount: "desc" }, { blobCount: "desc" }],
    take: limit * 2,
  });

  const now = new Date();

  const summaries = projects.map((p) => {
    const hoursSinceActive = (now.getTime() - p.lastActive.getTime()) / 3_600_000;

    let status: "active" | "growing" | "dormant";
    if (hoursSinceActive < 1 && p.growthRate >= 1) status = "growing";
    else if (hoursSinceActive < 6) status = "active";
    else status = "dormant";

    const { quality, final: importance, intent } = computeImportance({
      walletCount: p.walletCount,
      blobCount: p.blobCount,
      growthRate: p.growthRate,
      signals: p.signals,
      tags: p.tags,
      fileTypes: p.fileTypes,
    });

    const stage = computeStage({ blobCount: p.blobCount, walletCount: p.walletCount, growthRate: p.growthRate, lastActive: p.lastActive });
    const momentum = computeMomentum({ growthRate: p.growthRate, blobCount: p.blobCount, firstSeen: p.firstSeen, lastActive: p.lastActive });
    const opportunity = computeOpportunity({ stage, quality, momentum, walletCount: p.walletCount, intent });

    const topInsight = generateProjectInsight(p, status, intent, stage, momentum, opportunity);

    return {
      projectId: p.id,
      label: p.label,
      category: p.category,
      intent,
      stage,
      status,
      quality,
      momentum,
      opportunity,
      wallets: p.wallets.slice(0, 10).map((w) => `${w.slice(0, 8)}...${w.slice(-4)}`),
      walletCount: p.walletCount,
      blobCount: p.blobCount,
      growthRate: p.growthRate,
      tags: p.tags.filter((t) => !t.startsWith("account:")).slice(0, 10),
      signals: p.signals,
      fileTypes: p.fileTypes,
      firstSeen: p.firstSeen.toISOString(),
      lastActive: p.lastActive.toISOString(),
      importance,
      topInsight,
      recentSignals: [],
    };
  });

  // Sort by opportunity (the decision signal)
  return summaries
    .sort((a, b) => b.opportunity - a.opportunity || b.importance - a.importance)
    .slice(0, limit);
}

// ═══════════════════════════════════════════════════════════════
// ALERTS (v3 — opportunity-driven)
// ═══════════════════════════════════════════════════════════════

export async function generateAlerts(): Promise<Alert[]> {
  const alerts: Alert[] = [];
  const now = new Date();
  const oneHourAgo = new Date(now.getTime() - 3_600_000);

  // Alert: High-opportunity non-spam projects
  const activeProjects = await prisma.project.findMany({
    where: {
      lastActive: { gte: oneHourAgo },
      blobCount: { gte: 2 },
    },
    orderBy: { walletCount: "desc" },
    take: 20,
  });

  for (const p of activeProjects) {
    const { quality, final: importance, intent } = computeImportance({
      walletCount: p.walletCount,
      blobCount: p.blobCount,
      growthRate: p.growthRate,
      signals: p.signals,
      tags: p.tags,
      fileTypes: p.fileTypes,
    });

    if (intent === "MEDIA_SPAM") continue;
    if (quality < 30) continue;

    const stage = computeStage({ blobCount: p.blobCount, walletCount: p.walletCount, growthRate: p.growthRate, lastActive: p.lastActive });
    const momentum = computeMomentum({ growthRate: p.growthRate, blobCount: p.blobCount, firstSeen: p.firstSeen, lastActive: p.lastActive });
    const opportunity = computeOpportunity({ stage, quality, momentum, walletCount: p.walletCount, intent });

    // Only alert on high-opportunity projects
    if (opportunity < 40) continue;

    const level = opportunity >= 70 ? "critical" : opportunity >= 55 ? "high" : "watch";
    const stageEmoji = { EARLY: "🌱", EMERGING: "🚀", GROWING: "📈", SATURATED: "⚖️", DYING: "📉" };

    alerts.push({
      id: `alert-${p.id}`,
      level,
      title: `${stageEmoji[stage]} ${p.label} [${stage}]`,
      message: generateProjectInsight(p, "growing", intent, stage, momentum, opportunity),
      projectId: p.id,
      importance,
      opportunity,
      timestamp: p.lastActive.toISOString(),
    });
  }

  return alerts.sort((a, b) => b.opportunity - a.opportunity);
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

function generateProjectInsight(
  project: ProjectLike,
  status: string,
  intent: ProjectIntent,
  stage: ProjectStage,
  momentum: number,
  opportunity: number
): string {
  if (intent === "MEDIA_SPAM") {
    return `Low-value media spam — ${project.walletCount} wallets uploading ${project.fileTypes.join("/")} files.`;
  }

  const parts: string[] = [];

  // Stage context
  const stageDesc: Record<ProjectStage, string> = {
    EARLY: "newly discovered",
    EMERGING: "building momentum",
    GROWING: "actively growing",
    SATURATED: "mature/slowing",
    DYING: "going quiet",
  };
  parts.push(`📍 ${stageDesc[stage]}`);

  if (project.walletCount > 1) parts.push(`${project.walletCount} wallets`);
  if (status === "growing") parts.push(`${project.growthRate}/hr`);

  // Momentum indicator
  if (momentum >= 75) parts.push("⬆️ accelerating");
  else if (momentum <= 25) parts.push("⬇️ decelerating");

  // Domain signals
  const domainSignals = project.signals.filter((s) =>
    ["ai_interaction", "model_data", "trading_data", "agent_config"].includes(s)
  );
  if (domainSignals.length > 0) parts.push(domainSignals.join(" + "));

  if (project.fileTypes.length > 2) parts.push(`${project.fileTypes.length} file types`);

  // Opportunity summary
  if (opportunity >= 60) parts.push(`🔥 high opportunity (${opportunity})`);
  else if (opportunity >= 40) parts.push(`opportunity: ${opportunity}`);

  return parts.join(" · ") + ".";
}

function generateNarrative(
  event: { signalType: string; explanation: string; score: number },
  project: ProjectLike | null,
  intent: ProjectIntent,
  stage: ProjectStage,
  momentum: number,
  opportunity: number
): { title: string; narrative: string; whyItMatters: string } {
  let title: string;
  const stageTag = `[${stage}]`;

  if (intent === "MEDIA_SPAM") {
    title = "Media Upload Activity";
  } else if (project && project.walletCount > 1) {
    title = `${project.label} ${stageTag}`;
  } else {
    title = `${event.signalType.replace(/_/g, " ")} ${stageTag}`;
  }

  const narrative = event.explanation;

  // Why it matters — now includes stage + opportunity context
  let whyItMatters: string;

  if (opportunity >= 60 && (stage === "EARLY" || stage === "EMERGING")) {
    whyItMatters = `🔥 HIGH OPPORTUNITY — This is an ${stage.toLowerCase()}-stage project with strong quality (${project ? computeQuality({ fileTypes: project.fileTypes, tags: project.tags, signals: project.signals, blobCount: project.blobCount }) : 50}) and ${momentum >= 60 ? "accelerating" : "steady"} momentum. Early discovery of high-quality projects is where the real alpha is.`;
  } else {
    const baseReasons: Record<string, string> = {
      MULTI_WALLET_PROJECT: "Multiple wallets converging on the same project indicates organized development.",
      PROJECT_GROWTH: "Sustained file accumulation indicates real momentum.",
      AI_TRAINING: "AI model training on decentralized storage indicates sophisticated ML workflows.",
      AI_INFERENCE: "Real-time inference outputs suggest a live production AI system.",
      AGENT_DEPLOYMENT: "Autonomous agent deployments represent cutting-edge on-chain automation.",
      DATA_PIPELINE: "Sustained data upload rates indicate production ETL systems.",
      DATASET_FORMATION: "Large datasets forming on-chain suggest training data preparation.",
      RARE_FILE_TYPE: "Novel file formats expand the ecosystem and signal new use cases.",
    };
    whyItMatters = baseReasons[event.signalType] ?? `Scored ${event.score}/10 — top-tier activity.`;

    if (stage === "SATURATED" || stage === "DYING") {
      whyItMatters += ` Note: this project is ${stage.toLowerCase()} — less alpha opportunity remaining.`;
    }
  }

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
