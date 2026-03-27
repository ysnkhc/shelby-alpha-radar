import { prisma } from "../database/db.js";

/**
 * Insight Engine v4 — Temporal Intelligence
 *
 * Adds to v3 (stages, momentum, opportunity):
 *  - Freshness score: how recently did this project start?
 *  - Trigger events: new project, stage transition, momentum spike, first multi-wallet
 *  - Temporal priority: opportunity × freshness × momentum
 *  - ACT_NOW flag: high opportunity + high freshness = immediate alpha
 *
 * The question this answers:
 * "What JUST became important?"
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
  | "EARLY"
  | "EMERGING"
  | "GROWING"
  | "SATURATED"
  | "DYING";

export type TriggerEvent =
  | "NEW_PROJECT"
  | "STAGE_TRANSITION"
  | "MOMENTUM_SPIKE"
  | "FIRST_MULTI_WALLET"
  | "QUALITY_SURGE"
  | null;

export interface Insight {
  id: string;
  title: string;
  narrative: string;
  whyItMatters: string;
  whyNow: string | null;
  actNow: boolean;
  trigger: TriggerEvent;
  importance: number;
  quality: number;
  opportunity: number;
  freshness: number;
  temporalScore: number;
  stage: ProjectStage;
  momentum: number;
  category: "project" | "ai" | "data" | "rare" | "alert";
  intent: ProjectIntent;
  projectId: string | null;
  projectLabel: string | null;
  walletCount: number;
  blobCount: number;
  signals: string[];
  startedAgo: string;
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
  freshness: number;
  temporalScore: number;
  actNow: boolean;
  trigger: TriggerEvent;
  wallets: string[];
  walletCount: number;
  blobCount: number;
  growthRate: number;
  tags: string[];
  signals: string[];
  fileTypes: string[];
  firstSeen: string;
  lastActive: string;
  startedAgo: string;
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
  freshness: number;
  actNow: boolean;
  trigger: TriggerEvent;
  timestamp: string;
}

// ═══════════════════════════════════════════════════════════════
// FRESHNESS SCORE (0-100)
// ═══════════════════════════════════════════════════════════════

/**
 * How recently was this project first seen?
 *
 * 100 = just appeared (< 5 min ago)
 *  80 = very fresh (< 30 min)
 *  60 = recent (< 2 hours)
 *  40 = today (< 12 hours)
 *  20 = yesterday (< 24 hours)
 *  10 = old (> 24 hours)
 */
export function computeFreshness(firstSeen: Date): number {
  const minutesAgo = (Date.now() - firstSeen.getTime()) / 60_000;

  if (minutesAgo < 5) return 100;
  if (minutesAgo < 15) return 90;
  if (minutesAgo < 30) return 80;
  if (minutesAgo < 60) return 70;
  if (minutesAgo < 120) return 60;
  if (minutesAgo < 360) return 45;
  if (minutesAgo < 720) return 30;
  if (minutesAgo < 1440) return 20;
  return 10;
}

// ═══════════════════════════════════════════════════════════════
// TRIGGER EVENT DETECTION
// ═══════════════════════════════════════════════════════════════

/**
 * Detect what just happened to make this project interesting.
 * Returns the most significant trigger event.
 */
export function detectTrigger(params: {
  firstSeen: Date;
  lastActive: Date;
  blobCount: number;
  walletCount: number;
  growthRate: number;
  momentum: number;
  stage: ProjectStage;
}): TriggerEvent {
  const minutesSinceCreated = (Date.now() - params.firstSeen.getTime()) / 60_000;

  // NEW_PROJECT: appeared in last 30 minutes
  if (minutesSinceCreated < 30 && params.blobCount <= 5) {
    return "NEW_PROJECT";
  }

  // FIRST_MULTI_WALLET: exactly 2 wallets (just became multi-wallet)
  if (params.walletCount === 2 && minutesSinceCreated < 120) {
    return "FIRST_MULTI_WALLET";
  }

  // MOMENTUM_SPIKE: growth rate significantly above baseline
  if (params.momentum >= 85) {
    return "MOMENTUM_SPIKE";
  }

  // STAGE_TRANSITION: emerging-stage projects that recently crossed threshold
  if (params.stage === "EMERGING" && params.blobCount >= 4 && params.blobCount <= 6) {
    return "STAGE_TRANSITION";
  }

  return null;
}

// ═══════════════════════════════════════════════════════════════
// TEMPORAL PRIORITY SCORE
// ═══════════════════════════════════════════════════════════════

/**
 * temporalScore = opportunity × freshnessWeight × momentumWeight
 *
 * This answers: "What should I act on RIGHT NOW?"
 * Fresh + high-opportunity + accelerating = top priority.
 */
export function computeTemporalScore(params: {
  opportunity: number;
  freshness: number;
  momentum: number;
}): number {
  // Normalize to 0-1 scale
  const opp = params.opportunity / 100;
  const fresh = params.freshness / 100;
  const mom = params.momentum / 100;

  // Weighted geometric mean (opportunity dominant, freshness second, momentum third)
  // opportunity: 50% weight, freshness: 30% weight, momentum: 20% weight
  const score = Math.pow(opp, 0.5) * Math.pow(fresh, 0.3) * Math.pow(mom, 0.2);

  return Math.round(score * 100);
}

// ═══════════════════════════════════════════════════════════════
// ACT NOW DETECTION
// ═══════════════════════════════════════════════════════════════

export function isActNow(params: {
  opportunity: number;
  freshness: number;
  momentum: number;
  intent: ProjectIntent;
  trigger: TriggerEvent;
}): boolean {
  if (params.intent === "MEDIA_SPAM") return false;

  // ACT NOW = high opportunity + high freshness + has a trigger
  if (params.opportunity >= 50 && params.freshness >= 60 && params.trigger !== null) {
    return true;
  }

  // Also ACT NOW if extremely fresh with decent opportunity
  if (params.freshness >= 80 && params.opportunity >= 40) {
    return true;
  }

  return false;
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
  if (hoursSinceActive >= 12) return "DYING";
  if (params.blobCount <= 3 && params.walletCount <= 2) return "EARLY";
  if (params.blobCount <= 10) return "EMERGING";
  if (params.blobCount <= 30) {
    if (params.growthRate < 1 || hoursSinceActive > 3) return "SATURATED";
    return "GROWING";
  }
  if (params.growthRate < 1 || hoursSinceActive > 3) return "SATURATED";
  return "GROWING";
}

// ═══════════════════════════════════════════════════════════════
// MOMENTUM (0-100)
// ═══════════════════════════════════════════════════════════════

export function computeMomentum(params: {
  growthRate: number;
  blobCount: number;
  firstSeen: Date;
  lastActive: Date;
}): number {
  const totalHours = Math.max(1, (params.lastActive.getTime() - params.firstSeen.getTime()) / 3_600_000);
  const historicalRate = params.blobCount / totalHours;
  if (historicalRate === 0) return 50;
  const ratio = params.growthRate / historicalRate;
  if (ratio >= 3) return 100;
  if (ratio >= 2) return 85;
  if (ratio >= 1.5) return 75;
  if (ratio >= 1) return 60;
  if (ratio >= 0.5) return 40;
  if (ratio >= 0.2) return 25;
  return 10;
}

// ═══════════════════════════════════════════════════════════════
// QUALITY (0-100)
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
// CLASSIFICATION
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
  if (params.signals.some((s) => ["ai_interaction", "model_data", "agent_config"].includes(s))) return "AI_PIPELINE";
  if (params.tags.includes("config") && params.signals.length > 0) return "CONFIG_DEPLOYMENT";
  const dataTypes = new Set(["csv", "parquet", "arrow", "json", "npy", "feather"]);
  if (params.tags.includes("dataset") || params.fileTypes.some((t) => dataTypes.has(t))) return "DATASET";
  if (params.fileTypes.length >= 3 && !allMedia) return "MIXED_PROJECT";
  return "UNKNOWN";
}

// ═══════════════════════════════════════════════════════════════
// OPPORTUNITY (0-100)
// ═══════════════════════════════════════════════════════════════

export function computeOpportunity(params: {
  stage: ProjectStage;
  quality: number;
  momentum: number;
  walletCount: number;
  intent: ProjectIntent;
}): number {
  if (params.intent === "MEDIA_SPAM") return 0;
  let score = 0;
  const stageBonus: Record<ProjectStage, number> = { EARLY: 30, EMERGING: 25, GROWING: 15, SATURATED: 5, DYING: 0 };
  score += stageBonus[params.stage];
  score += Math.round(params.quality * 0.3);
  score += Math.round(params.momentum * 0.25);
  if (params.walletCount >= 2 && (params.stage === "EARLY" || params.stage === "EMERGING")) score += 15;
  else if (params.walletCount >= 2) score += 5;
  return Math.min(100, score);
}

// ═══════════════════════════════════════════════════════════════
// IMPORTANCE (with diminishing returns)
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
  const quality = computeQuality({ fileTypes: params.fileTypes, tags: params.tags, signals: params.signals, blobCount: params.blobCount });
  const intent = classifyProject({ fileTypes: params.fileTypes, tags: params.tags, signals: params.signals, blobCount: params.blobCount, walletCount: params.walletCount });

  let raw = 0;
  const wc = params.walletCount;
  if (wc <= 5) raw += wc * 5;
  else if (wc <= 20) raw += 25 + (wc - 5) * 2;
  else if (wc <= 50) raw += 55 + (wc - 20) * 0.5;
  else raw += 70;

  const hvs = new Set(["ai_interaction", "model_data", "agent_config", "trading_data"]);
  raw += Math.min(20, params.signals.filter((s) => hvs.has(s)).length * 8);
  if (params.growthRate >= 10) raw += 15;
  else if (params.growthRate >= 5) raw += 10;
  else if (params.growthRate >= 2) raw += 5;
  if (params.signalScore && params.signalScore >= 9) raw += 10;
  else if (params.signalScore && params.signalScore >= 7) raw += 5;

  raw = Math.min(100, raw);
  const qualityMultiplier = 0.1 + (quality / 100) * 0.9;
  return { quality, final: Math.round(raw * qualityMultiplier), intent };
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

  // Deduplicate by project
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
      walletCount: project?.walletCount ?? 1, blobCount: project?.blobCount ?? 1,
      growthRate: project?.growthRate ?? 0, signals: project?.signals ?? [],
      tags: project?.tags ?? [], fileTypes: project?.fileTypes ?? [], signalScore: event.score,
    });

    const stage = project ? computeStage({ blobCount: project.blobCount, walletCount: project.walletCount, growthRate: project.growthRate, lastActive: project.lastActive }) : "EARLY";
    const momentum = project ? computeMomentum({ growthRate: project.growthRate, blobCount: project.blobCount, firstSeen: project.firstSeen, lastActive: project.lastActive }) : 50;
    const opportunity = computeOpportunity({ stage, quality, momentum, walletCount: project?.walletCount ?? 1, intent });
    const freshness = project ? computeFreshness(project.firstSeen) : computeFreshness(event.createdAt);
    const temporalScore = computeTemporalScore({ opportunity, freshness, momentum });
    const trigger = project ? detectTrigger({ firstSeen: project.firstSeen, lastActive: project.lastActive, blobCount: project.blobCount, walletCount: project.walletCount, growthRate: project.growthRate, momentum, stage }) : null;
    const actNow = isActNow({ opportunity, freshness, momentum, intent, trigger });

    if (intent === "MEDIA_SPAM" && importance < 20) continue;

    const category = categorizeSignal(event.signalType);
    const { title, narrative, whyItMatters, whyNow } = generateNarrative(event, project, intent, stage, momentum, opportunity, freshness, trigger, actNow);
    const startedAgo = project ? getTimeAgo(project.firstSeen) : getTimeAgo(event.createdAt);

    insights.push({
      id: `insight-${event.id}`, title, narrative, whyItMatters, whyNow, actNow, trigger,
      importance, quality, opportunity, freshness, temporalScore, stage, momentum, category, intent,
      projectId, projectLabel: project?.label ?? null,
      walletCount: project?.walletCount ?? 1, blobCount: project?.blobCount ?? 1,
      signals: project?.signals ?? [event.signalType],
      startedAgo, timestamp: event.createdAt.toISOString(), timeAgo: getTimeAgo(event.createdAt),
    });
  }

  // Sort by TEMPORAL SCORE (the ultimate decision signal)
  return insights.sort((a, b) => b.temporalScore - a.temporalScore || b.opportunity - a.opportunity).slice(0, limit);
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
      walletCount: p.walletCount, blobCount: p.blobCount, growthRate: p.growthRate,
      signals: p.signals, tags: p.tags, fileTypes: p.fileTypes,
    });

    const stage = computeStage({ blobCount: p.blobCount, walletCount: p.walletCount, growthRate: p.growthRate, lastActive: p.lastActive });
    const momentum = computeMomentum({ growthRate: p.growthRate, blobCount: p.blobCount, firstSeen: p.firstSeen, lastActive: p.lastActive });
    const opportunity = computeOpportunity({ stage, quality, momentum, walletCount: p.walletCount, intent });
    const freshness = computeFreshness(p.firstSeen);
    const temporalScore = computeTemporalScore({ opportunity, freshness, momentum });
    const trigger = detectTrigger({ firstSeen: p.firstSeen, lastActive: p.lastActive, blobCount: p.blobCount, walletCount: p.walletCount, growthRate: p.growthRate, momentum, stage });
    const actNow = isActNow({ opportunity, freshness, momentum, intent, trigger });

    const topInsight = generateProjectInsight(p, status, intent, stage, momentum, opportunity, freshness, trigger, actNow);

    return {
      projectId: p.id, label: p.label, category: p.category, intent, stage, status,
      quality, momentum, opportunity, freshness, temporalScore, actNow, trigger,
      wallets: p.wallets.slice(0, 10).map((w) => `${w.slice(0, 8)}...${w.slice(-4)}`),
      walletCount: p.walletCount, blobCount: p.blobCount, growthRate: p.growthRate,
      tags: p.tags.filter((t) => !t.startsWith("account:")).slice(0, 10),
      signals: p.signals, fileTypes: p.fileTypes,
      firstSeen: p.firstSeen.toISOString(), lastActive: p.lastActive.toISOString(),
      startedAgo: getTimeAgo(p.firstSeen), importance, topInsight, recentSignals: [],
    };
  });

  return summaries.sort((a, b) => b.temporalScore - a.temporalScore || b.opportunity - a.opportunity).slice(0, limit);
}

// ═══════════════════════════════════════════════════════════════
// ALERTS (v4 — temporal)
// ═══════════════════════════════════════════════════════════════

export async function generateAlerts(): Promise<Alert[]> {
  const alerts: Alert[] = [];
  const now = new Date();
  const twoHoursAgo = new Date(now.getTime() - 7_200_000);

  const activeProjects = await prisma.project.findMany({
    where: { lastActive: { gte: twoHoursAgo }, blobCount: { gte: 2 } },
    orderBy: { walletCount: "desc" },
    take: 20,
  });

  for (const p of activeProjects) {
    const { quality, final: importance, intent } = computeImportance({
      walletCount: p.walletCount, blobCount: p.blobCount, growthRate: p.growthRate,
      signals: p.signals, tags: p.tags, fileTypes: p.fileTypes,
    });
    if (intent === "MEDIA_SPAM" || quality < 30) continue;

    const stage = computeStage({ blobCount: p.blobCount, walletCount: p.walletCount, growthRate: p.growthRate, lastActive: p.lastActive });
    const momentum = computeMomentum({ growthRate: p.growthRate, blobCount: p.blobCount, firstSeen: p.firstSeen, lastActive: p.lastActive });
    const opportunity = computeOpportunity({ stage, quality, momentum, walletCount: p.walletCount, intent });
    const freshness = computeFreshness(p.firstSeen);
    const temporalScore = computeTemporalScore({ opportunity, freshness, momentum });
    const trigger = detectTrigger({ firstSeen: p.firstSeen, lastActive: p.lastActive, blobCount: p.blobCount, walletCount: p.walletCount, growthRate: p.growthRate, momentum, stage });
    const actNow = isActNow({ opportunity, freshness, momentum, intent, trigger });

    // Only alert on meaningful temporal events
    if (temporalScore < 30 && !actNow) continue;

    const level = actNow ? "critical" : temporalScore >= 50 ? "high" : "watch";
    const stageEmoji: Record<ProjectStage, string> = { EARLY: "🌱", EMERGING: "🚀", GROWING: "📈", SATURATED: "⚖️", DYING: "📉" };
    const triggerLabel = trigger ? ` — ${formatTrigger(trigger)}` : "";

    alerts.push({
      id: `alert-${p.id}`, level,
      title: `${actNow ? "🔥 ACT NOW: " : ""}${stageEmoji[stage]} ${p.label} [${stage}]`,
      message: generateProjectInsight(p, "growing", intent, stage, momentum, opportunity, freshness, trigger, actNow) + triggerLabel,
      projectId: p.id, importance, opportunity, freshness, actNow, trigger,
      timestamp: p.lastActive.toISOString(),
    });
  }

  // Sort: ACT NOW first, then by temporal score
  return alerts.sort((a, b) => {
    if (a.actNow && !b.actNow) return -1;
    if (!a.actNow && b.actNow) return 1;
    return b.opportunity - a.opportunity;
  });
}

// ═══════════════════════════════════════════════════════════════
// INTERNAL HELPERS
// ═══════════════════════════════════════════════════════════════

function findProjectForEvent(event: { owner: string }, projects: { id: string; wallets: string[] }[]): string | null {
  for (const p of projects) { if (p.wallets.includes(event.owner)) return p.id; }
  return null;
}

function categorizeSignal(signalType: string): Insight["category"] {
  if (signalType.includes("WALLET") || signalType.includes("PROJECT") || signalType.includes("GROWTH")) return "project";
  if (signalType.includes("AI") || signalType.includes("AGENT")) return "ai";
  if (signalType.includes("DATA") || signalType.includes("DATASET")) return "data";
  if (signalType.includes("RARE")) return "rare";
  return "project";
}

function formatTrigger(trigger: TriggerEvent): string {
  const map: Record<string, string> = {
    NEW_PROJECT: "🆕 New project detected",
    STAGE_TRANSITION: "📈 Stage transition",
    MOMENTUM_SPIKE: "⚡ Momentum spike",
    FIRST_MULTI_WALLET: "👥 First multi-wallet",
    QUALITY_SURGE: "✨ Quality surge",
  };
  return trigger ? map[trigger] ?? trigger : "";
}

interface ProjectLike {
  label: string; walletCount: number; blobCount: number; growthRate: number;
  category: string; signals: string[]; tags: string[]; fileTypes: string[];
  firstSeen: Date;
}

function generateProjectInsight(
  project: ProjectLike, status: string, intent: ProjectIntent,
  stage: ProjectStage, momentum: number, opportunity: number,
  _freshness: number, trigger: TriggerEvent, actNow: boolean
): string {
  if (intent === "MEDIA_SPAM") return `Low-value media spam — ${project.walletCount} wallets uploading ${project.fileTypes.join("/")}.`;

  const parts: string[] = [];

  if (actNow) parts.push("🔥 ACT NOW");

  // Time context
  const startedAgo = getTimeAgo(project.firstSeen);
  parts.push(`started ${startedAgo}`);

  const stageDesc: Record<ProjectStage, string> = {
    EARLY: "newly discovered", EMERGING: "building momentum", GROWING: "actively growing",
    SATURATED: "mature/slowing", DYING: "going quiet",
  };
  parts.push(`📍 ${stageDesc[stage]}`);

  if (project.walletCount > 1) parts.push(`${project.walletCount} wallets`);
  if (status === "growing") parts.push(`${project.growthRate}/hr`);
  if (momentum >= 75) parts.push("⬆️ accelerating");
  else if (momentum <= 25) parts.push("⬇️ decelerating");

  if (trigger) parts.push(formatTrigger(trigger));

  if (opportunity >= 60) parts.push(`🔥 opp: ${opportunity}`);
  else if (opportunity >= 40) parts.push(`opp: ${opportunity}`);

  return parts.join(" · ") + ".";
}

function generateNarrative(
  event: { signalType: string; explanation: string; score: number },
  project: ProjectLike | null, intent: ProjectIntent,
  stage: ProjectStage, momentum: number, opportunity: number,
  _freshness: number, trigger: TriggerEvent, actNow: boolean
): { title: string; narrative: string; whyItMatters: string; whyNow: string | null } {

  // Title with ACT NOW prefix
  let title: string;
  const stageTag = `[${stage}]`;
  const actNowPrefix = actNow ? "🔥 ACT NOW: " : "";

  if (intent === "MEDIA_SPAM") title = "Media Upload Activity";
  else if (project && project.walletCount > 1) title = `${actNowPrefix}${project.label} ${stageTag}`;
  else title = `${actNowPrefix}${event.signalType.replace(/_/g, " ")} ${stageTag}`;

  const narrative = event.explanation;

  // Why it matters (static)
  let whyItMatters: string;
  if (opportunity >= 60 && (stage === "EARLY" || stage === "EMERGING")) {
    const q = project ? computeQuality({ fileTypes: project.fileTypes, tags: project.tags, signals: project.signals, blobCount: project.blobCount }) : 50;
    whyItMatters = `🔥 HIGH OPPORTUNITY — ${stage.toLowerCase()}-stage project with quality ${q} and ${momentum >= 60 ? "accelerating" : "steady"} momentum. Early discovery = real alpha.`;
  } else {
    const base: Record<string, string> = {
      MULTI_WALLET_PROJECT: "Multiple wallets converging indicates organized development.",
      PROJECT_GROWTH: "Sustained file accumulation indicates real momentum.",
      AI_TRAINING: "AI training on decentralized storage indicates sophisticated ML workflows.",
      AGENT_DEPLOYMENT: "Autonomous agent deployments = cutting-edge on-chain automation.",
      DATA_PIPELINE: "Sustained data uploads indicate production ETL systems.",
      DATASET_FORMATION: "Large datasets forming suggest training data preparation.",
      RARE_FILE_TYPE: "Novel file formats signal new use cases.",
    };
    whyItMatters = base[event.signalType] ?? `Scored ${event.score}/10 — top-tier activity.`;
    if (stage === "SATURATED" || stage === "DYING") whyItMatters += ` Note: project is ${stage.toLowerCase()}.`;
  }

  // WHY NOW (temporal — the new signal)
  let whyNow: string | null = null;
  if (trigger === "NEW_PROJECT") {
    const startedAgo = project ? getTimeAgo(project.firstSeen) : "just now";
    whyNow = `🆕 This project appeared ${startedAgo}. You're seeing it at the earliest possible moment.`;
  } else if (trigger === "FIRST_MULTI_WALLET") {
    whyNow = `👥 A second wallet just joined — this shifted from solo activity to collaborative. This is the strongest early signal.`;
  } else if (trigger === "MOMENTUM_SPIKE") {
    whyNow = `⚡ Growth rate just spiked dramatically. Something activated this project.`;
  } else if (trigger === "STAGE_TRANSITION") {
    whyNow = `📈 This project just crossed into ${stage} stage. It has enough data to evaluate but is still early.`;
  } else if (actNow) {
    whyNow = `This is a fresh, high-quality opportunity that won't stay early-stage for long.`;
  }

  return { title, narrative, whyItMatters, whyNow };
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
