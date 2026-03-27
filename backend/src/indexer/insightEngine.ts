import { prisma } from "../database/db.js";

/**
 * Insight Engine v5 — Real-Time Alpha Feed
 *
 * Tuned for maximum urgency:
 *  - Freshness is now DOMINANT signal (45% weight)
 *  - Burst detection: rapid uploads in short windows
 *  - Relaxed ACT NOW: triggers on freshness ≥ 50 + opportunity ≥ 35
 *  - Staleness penalty: projects idle > 2hrs get penalized
 *  - WhyNow narratives focus on sudden change + urgency
 *
 * The question: "What is happening RIGHT NOW that I should act on?"
 */

// ── Types ─────────────────────────────────────────────────────

export type ProjectIntent = "MEDIA_SPAM" | "DATASET" | "AI_PIPELINE" | "CONFIG_DEPLOYMENT" | "MIXED_PROJECT" | "UNKNOWN";
export type ProjectStage = "EARLY" | "EMERGING" | "GROWING" | "SATURATED" | "DYING";
export type TriggerEvent = "NEW_PROJECT" | "STAGE_TRANSITION" | "MOMENTUM_SPIKE" | "FIRST_MULTI_WALLET" | "BURST_DETECTED" | "QUALITY_SURGE" | null;

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
  staleness: number;
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
  lastActiveAgo: string;
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
  staleness: number;
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
  lastActiveAgo: string;
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
// FRESHNESS (0-100) — AGGRESSIVE DECAY
// ═══════════════════════════════════════════════════════════════

export function computeFreshness(firstSeen: Date): number {
  const min = (Date.now() - firstSeen.getTime()) / 60_000;
  if (min < 2) return 100;
  if (min < 5) return 95;
  if (min < 10) return 90;
  if (min < 20) return 85;
  if (min < 30) return 75;
  if (min < 60) return 65;
  if (min < 120) return 50;
  if (min < 240) return 35;
  if (min < 480) return 25;
  if (min < 720) return 15;
  return 10;
}

// ═══════════════════════════════════════════════════════════════
// STALENESS (0-100) — PENALIZES INACTIVE PROJECTS
// ═══════════════════════════════════════════════════════════════

/**
 * How recently was this project LAST active?
 * 100 = active right now, 0 = dead
 */
export function computeStaleness(lastActive: Date): number {
  const min = (Date.now() - lastActive.getTime()) / 60_000;
  if (min < 5) return 100;
  if (min < 15) return 90;
  if (min < 30) return 80;
  if (min < 60) return 65;
  if (min < 120) return 50;
  if (min < 360) return 30;
  if (min < 720) return 15;
  return 5;
}

// ═══════════════════════════════════════════════════════════════
// BURST DETECTION
// ═══════════════════════════════════════════════════════════════

/**
 * Detect rapid activity bursts.
 * A burst = high growth rate relative to project age.
 */
export function detectBurst(params: {
  blobCount: number;
  growthRate: number;
  firstSeen: Date;
  lastActive: Date;
}): boolean {
  const ageMinutes = (Date.now() - params.firstSeen.getTime()) / 60_000;

  // Young project with rapid uploads
  if (ageMinutes < 60 && params.blobCount >= 3) return true;
  if (ageMinutes < 30 && params.blobCount >= 2) return true;

  // Any project with extreme growth rate
  if (params.growthRate >= 5) return true;

  // High velocity relative to age
  if (ageMinutes > 0 && (params.blobCount / (ageMinutes / 60)) >= 4) return true;

  return false;
}

// ═══════════════════════════════════════════════════════════════
// TRIGGER DETECTION (v2 — with bursts)
// ═══════════════════════════════════════════════════════════════

export function detectTrigger(params: {
  firstSeen: Date;
  lastActive: Date;
  blobCount: number;
  walletCount: number;
  growthRate: number;
  momentum: number;
  stage: ProjectStage;
  isBurst: boolean;
}): TriggerEvent {
  const minSinceCreated = (Date.now() - params.firstSeen.getTime()) / 60_000;

  // BURST takes priority — it's the most urgent
  if (params.isBurst) return "BURST_DETECTED";

  // NEW_PROJECT
  if (minSinceCreated < 30 && params.blobCount <= 5) return "NEW_PROJECT";

  // FIRST_MULTI_WALLET
  if (params.walletCount === 2 && minSinceCreated < 120) return "FIRST_MULTI_WALLET";

  // MOMENTUM_SPIKE
  if (params.momentum >= 85) return "MOMENTUM_SPIKE";

  // STAGE_TRANSITION
  if (params.stage === "EMERGING" && params.blobCount >= 4 && params.blobCount <= 6) return "STAGE_TRANSITION";

  return null;
}

// ═══════════════════════════════════════════════════════════════
// TEMPORAL SCORE — FRESHNESS DOMINANT
// ═══════════════════════════════════════════════════════════════

/**
 * v5 formula: freshness^0.45 × opportunity^0.3 × recency^0.15 × momentum^0.1
 *
 * freshness = when did the project START (discovery freshness)
 * recency = when was the project LAST ACTIVE (staleness inverse)
 * opportunity = structural quality
 * momentum = acceleration
 *
 * This heavily favors NEW things that are STILL ACTIVE.
 */
export function computeTemporalScore(params: {
  opportunity: number;
  freshness: number;
  staleness: number;
  momentum: number;
  isBurst: boolean;
}): number {
  const opp = Math.max(0.01, params.opportunity / 100);
  const fresh = Math.max(0.01, params.freshness / 100);
  const stale = Math.max(0.01, params.staleness / 100);
  const mom = Math.max(0.01, params.momentum / 100);

  let score = Math.pow(fresh, 0.45) * Math.pow(opp, 0.3) * Math.pow(stale, 0.15) * Math.pow(mom, 0.1);

  // Burst bonus: +20% temporal score
  if (params.isBurst) score *= 1.2;

  return Math.min(100, Math.round(score * 100));
}

// ═══════════════════════════════════════════════════════════════
// ACT NOW — RELAXED THRESHOLDS
// ═══════════════════════════════════════════════════════════════

export function isActNow(params: {
  opportunity: number;
  freshness: number;
  staleness: number;
  momentum: number;
  intent: ProjectIntent;
  trigger: TriggerEvent;
  isBurst: boolean;
}): boolean {
  if (params.intent === "MEDIA_SPAM") return false;

  // Burst + any reasonable opportunity = ACT NOW
  if (params.isBurst && params.opportunity >= 30) return true;

  // Fresh + decent opportunity = ACT NOW (relaxed from v4)
  if (params.freshness >= 50 && params.opportunity >= 35) return true;

  // Very fresh + any trigger = ACT NOW
  if (params.freshness >= 70 && params.trigger !== null) return true;

  // High staleness (still active) + high opportunity = ACT NOW
  if (params.staleness >= 80 && params.opportunity >= 50) return true;

  return false;
}

// ═══════════════════════════════════════════════════════════════
// PROJECT STAGE
// ═══════════════════════════════════════════════════════════════

export function computeStage(p: { blobCount: number; walletCount: number; growthRate: number; lastActive: Date }): ProjectStage {
  const hrs = (Date.now() - p.lastActive.getTime()) / 3_600_000;
  if (hrs >= 12) return "DYING";
  if (p.blobCount <= 3 && p.walletCount <= 2) return "EARLY";
  if (p.blobCount <= 10) return "EMERGING";
  if (p.blobCount <= 30 && (p.growthRate >= 1 || hrs < 3)) return "GROWING";
  if (p.growthRate < 1 || hrs > 3) return "SATURATED";
  return "GROWING";
}

// ═══════════════════════════════════════════════════════════════
// MOMENTUM (0-100)
// ═══════════════════════════════════════════════════════════════

export function computeMomentum(p: { growthRate: number; blobCount: number; firstSeen: Date; lastActive: Date }): number {
  const hrs = Math.max(0.1, (p.lastActive.getTime() - p.firstSeen.getTime()) / 3_600_000);
  const historical = p.blobCount / hrs;
  if (historical === 0) return 50;
  const ratio = p.growthRate / historical;
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

export function computeQuality(p: { fileTypes: string[]; tags: string[]; signals: string[]; blobCount: number }): number {
  let q = 50;
  const tc = p.fileTypes.length;
  if (tc >= 4) q += 20; else if (tc >= 3) q += 15; else if (tc >= 2) q += 5; else q -= 10;
  const struct = new Set(["json","csv","yaml","yml","toml","xml","parquet","arrow"]);
  if (p.fileTypes.some(t => struct.has(t))) q += 15;
  const cfg = new Set(["config","logs","ai_data","dataset"]);
  q += Math.min(15, p.tags.filter(t => cfg.has(t)).length * 5);
  const dom = new Set(["ai_interaction","model_data","agent_config","trading_data"]);
  q += Math.min(15, p.signals.filter(s => dom.has(s)).length * 8);
  const media = new Set(["png","jpg","jpeg","gif","webp","svg","bmp","ico","mp3","mp4","wav","avi","mov"]);
  if (p.fileTypes.length > 0 && p.fileTypes.every(t => media.has(t))) { q -= 30; if (p.blobCount > 20) q -= 10; }
  if (p.signals.length === 0 && p.tags.length <= 2) q -= 10;
  return Math.max(0, Math.min(100, q));
}

// ═══════════════════════════════════════════════════════════════
// CLASSIFICATION
// ═══════════════════════════════════════════════════════════════

export function classifyProject(p: { fileTypes: string[]; tags: string[]; signals: string[]; blobCount: number; walletCount: number }): ProjectIntent {
  const media = new Set(["png","jpg","jpeg","gif","webp","svg","bmp","ico","mp3","mp4","wav","avi","mov"]);
  const allMedia = p.fileTypes.length > 0 && p.fileTypes.every(t => media.has(t));
  if (allMedia && p.signals.length === 0 && p.walletCount > 5) return "MEDIA_SPAM";
  if (p.signals.some(s => ["ai_interaction","model_data","agent_config"].includes(s))) return "AI_PIPELINE";
  if (p.tags.includes("config") && p.signals.length > 0) return "CONFIG_DEPLOYMENT";
  const data = new Set(["csv","parquet","arrow","json","npy","feather"]);
  if (p.tags.includes("dataset") || p.fileTypes.some(t => data.has(t))) return "DATASET";
  if (p.fileTypes.length >= 3 && !allMedia) return "MIXED_PROJECT";
  return "UNKNOWN";
}

// ═══════════════════════════════════════════════════════════════
// OPPORTUNITY (0-100)
// ═══════════════════════════════════════════════════════════════

export function computeOpportunity(p: { stage: ProjectStage; quality: number; momentum: number; walletCount: number; intent: ProjectIntent }): number {
  if (p.intent === "MEDIA_SPAM") return 0;
  let s = 0;
  const bonus: Record<ProjectStage, number> = { EARLY: 30, EMERGING: 25, GROWING: 15, SATURATED: 5, DYING: 0 };
  s += bonus[p.stage];
  s += Math.round(p.quality * 0.3);
  s += Math.round(p.momentum * 0.25);
  if (p.walletCount >= 2 && (p.stage === "EARLY" || p.stage === "EMERGING")) s += 15;
  else if (p.walletCount >= 2) s += 5;
  return Math.min(100, s);
}

// ═══════════════════════════════════════════════════════════════
// IMPORTANCE
// ═══════════════════════════════════════════════════════════════

export function computeImportance(p: {
  walletCount: number; blobCount: number; growthRate: number;
  signals: string[]; tags: string[]; fileTypes: string[]; signalScore?: number;
}): { quality: number; final: number; intent: ProjectIntent } {
  const quality = computeQuality(p);
  const intent = classifyProject(p);
  let raw = 0;
  const wc = p.walletCount;
  if (wc <= 5) raw += wc * 5; else if (wc <= 20) raw += 25 + (wc - 5) * 2;
  else if (wc <= 50) raw += 55 + (wc - 20) * 0.5; else raw += 70;
  const hvs = new Set(["ai_interaction","model_data","agent_config","trading_data"]);
  raw += Math.min(20, p.signals.filter(s => hvs.has(s)).length * 8);
  if (p.growthRate >= 10) raw += 15; else if (p.growthRate >= 5) raw += 10; else if (p.growthRate >= 2) raw += 5;
  if (p.signalScore && p.signalScore >= 9) raw += 10; else if (p.signalScore && p.signalScore >= 7) raw += 5;
  raw = Math.min(100, raw);
  const qm = 0.1 + (quality / 100) * 0.9;
  return { quality, final: Math.round(raw * qm), intent };
}

// ═══════════════════════════════════════════════════════════════
// COMPUTE ALL SIGNALS FOR A PROJECT
// ═══════════════════════════════════════════════════════════════

interface ProjectRow {
  id: string; label: string; category: string; walletCount: number; blobCount: number;
  growthRate: number; signals: string[]; tags: string[]; fileTypes: string[];
  wallets: string[]; firstSeen: Date; lastActive: Date;
}

function computeAllSignals(p: ProjectRow, signalScore?: number) {
  const { quality, final: importance, intent } = computeImportance({
    walletCount: p.walletCount, blobCount: p.blobCount, growthRate: p.growthRate,
    signals: p.signals, tags: p.tags, fileTypes: p.fileTypes, signalScore,
  });
  const stage = computeStage(p);
  const momentum = computeMomentum(p);
  const opportunity = computeOpportunity({ stage, quality, momentum, walletCount: p.walletCount, intent });
  const freshness = computeFreshness(p.firstSeen);
  const staleness = computeStaleness(p.lastActive);
  const isBurst = detectBurst({ blobCount: p.blobCount, growthRate: p.growthRate, firstSeen: p.firstSeen, lastActive: p.lastActive });
  const trigger = detectTrigger({ firstSeen: p.firstSeen, lastActive: p.lastActive, blobCount: p.blobCount, walletCount: p.walletCount, growthRate: p.growthRate, momentum, stage, isBurst });
  const temporalScore = computeTemporalScore({ opportunity, freshness, staleness, momentum, isBurst });
  const actNow = isActNow({ opportunity, freshness, staleness, momentum, intent, trigger, isBurst });

  return { quality, importance, intent, stage, momentum, opportunity, freshness, staleness, isBurst, trigger, temporalScore, actNow };
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

  const projectMap = new Map(projects.map(p => [p.id, p]));

  // Dedup by project
  const seen = new Map<string, typeof recentEvents[0]>();
  for (const ev of recentEvents) {
    const pid = findProject(ev, projects);
    const key = pid ?? `solo:${ev.id}`;
    if (!seen.has(key) || ev.score > (seen.get(key)?.score ?? 0)) seen.set(key, ev);
  }

  const insights: Insight[] = [];
  for (const [key, event] of seen) {
    const projectId = key.startsWith("solo:") ? null : key;
    const project = projectId ? projectMap.get(projectId) ?? null : null;

    const sigs = project
      ? computeAllSignals(project, event.score)
      : { quality: 50, importance: event.score * 5, intent: "UNKNOWN" as ProjectIntent, stage: "EARLY" as ProjectStage, momentum: 50, opportunity: 30, freshness: computeFreshness(event.createdAt), staleness: 100, isBurst: false, trigger: null as TriggerEvent, temporalScore: 30, actNow: false };

    if (sigs.intent === "MEDIA_SPAM" && sigs.importance < 20) continue;

    const cat = categorize(event.signalType);
    const { title, narrative, whyItMatters, whyNow } = buildNarrative(event, project, sigs);
    const startedAgo = project ? timeAgo(project.firstSeen) : timeAgo(event.createdAt);
    const lastActiveAgo = project ? timeAgo(project.lastActive) : timeAgo(event.createdAt);

    insights.push({
      id: `insight-${event.id}`, title, narrative, whyItMatters, whyNow,
      actNow: sigs.actNow, trigger: sigs.trigger,
      importance: sigs.importance, quality: sigs.quality, opportunity: sigs.opportunity,
      freshness: sigs.freshness, staleness: sigs.staleness, temporalScore: sigs.temporalScore,
      stage: sigs.stage, momentum: sigs.momentum, category: cat, intent: sigs.intent,
      projectId, projectLabel: project?.label ?? null,
      walletCount: project?.walletCount ?? 1, blobCount: project?.blobCount ?? 1,
      signals: project?.signals ?? [event.signalType],
      startedAgo, lastActiveAgo,
      timestamp: event.createdAt.toISOString(), timeAgo: timeAgo(event.createdAt),
    });
  }

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
  const summaries = projects.map(p => {
    const hrs = (now.getTime() - p.lastActive.getTime()) / 3_600_000;
    const status: "active" | "growing" | "dormant" = hrs < 1 && p.growthRate >= 1 ? "growing" : hrs < 6 ? "active" : "dormant";
    const sigs = computeAllSignals(p);
    const topInsight = buildProjectInsight(p, status, sigs);

    return {
      projectId: p.id, label: p.label, category: p.category,
      intent: sigs.intent, stage: sigs.stage, status,
      quality: sigs.quality, momentum: sigs.momentum, opportunity: sigs.opportunity,
      freshness: sigs.freshness, staleness: sigs.staleness, temporalScore: sigs.temporalScore,
      actNow: sigs.actNow, trigger: sigs.trigger,
      wallets: p.wallets.slice(0, 10).map(w => `${w.slice(0, 8)}...${w.slice(-4)}`),
      walletCount: p.walletCount, blobCount: p.blobCount, growthRate: p.growthRate,
      tags: p.tags.filter(t => !t.startsWith("account:")).slice(0, 10),
      signals: p.signals, fileTypes: p.fileTypes,
      firstSeen: p.firstSeen.toISOString(), lastActive: p.lastActive.toISOString(),
      startedAgo: timeAgo(p.firstSeen), lastActiveAgo: timeAgo(p.lastActive),
      importance: sigs.importance, topInsight, recentSignals: [],
    };
  });

  return summaries.sort((a, b) => {
    if (a.actNow && !b.actNow) return -1;
    if (!a.actNow && b.actNow) return 1;
    return b.temporalScore - a.temporalScore || b.opportunity - a.opportunity;
  }).slice(0, limit);
}

// ═══════════════════════════════════════════════════════════════
// ALERTS
// ═══════════════════════════════════════════════════════════════

export async function generateAlerts(): Promise<Alert[]> {
  const alerts: Alert[] = [];
  const threeHoursAgo = new Date(Date.now() - 10_800_000);

  const active = await prisma.project.findMany({
    where: { lastActive: { gte: threeHoursAgo }, blobCount: { gte: 2 } },
    orderBy: { walletCount: "desc" },
    take: 30,
  });

  for (const p of active) {
    const sigs = computeAllSignals(p);
    if (sigs.intent === "MEDIA_SPAM" || sigs.quality < 30) continue;

    // Alert on ACT NOW or high temporal score
    if (!sigs.actNow && sigs.temporalScore < 25) continue;

    const level = sigs.actNow ? "critical" : sigs.temporalScore >= 40 ? "high" : "watch";
    const emoji: Record<ProjectStage, string> = { EARLY: "🌱", EMERGING: "🚀", GROWING: "📈", SATURATED: "⚖️", DYING: "📉" };
    const burstTag = sigs.isBurst ? " ⚡BURST" : "";

    alerts.push({
      id: `alert-${p.id}`, level,
      title: `${sigs.actNow ? "🔥 ACT NOW: " : ""}${emoji[sigs.stage]} ${p.label} [${sigs.stage}]${burstTag}`,
      message: buildProjectInsight(p, "growing", sigs),
      projectId: p.id, importance: sigs.importance, opportunity: sigs.opportunity,
      freshness: sigs.freshness, actNow: sigs.actNow, trigger: sigs.trigger,
      timestamp: p.lastActive.toISOString(),
    });
  }

  return alerts.sort((a, b) => {
    if (a.actNow && !b.actNow) return -1;
    if (!a.actNow && b.actNow) return 1;
    return b.opportunity - a.opportunity;
  });
}

// ═══════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════

function findProject(ev: { owner: string }, projects: { id: string; wallets: string[] }[]): string | null {
  for (const p of projects) { if (p.wallets.includes(ev.owner)) return p.id; }
  return null;
}

function categorize(st: string): Insight["category"] {
  if (st.includes("WALLET") || st.includes("PROJECT") || st.includes("GROWTH")) return "project";
  if (st.includes("AI") || st.includes("AGENT")) return "ai";
  if (st.includes("DATA") || st.includes("DATASET")) return "data";
  if (st.includes("RARE")) return "rare";
  return "project";
}

function formatTrigger(t: TriggerEvent): string {
  const m: Record<string, string> = {
    NEW_PROJECT: "🆕 New project", STAGE_TRANSITION: "📈 Stage up",
    MOMENTUM_SPIKE: "⚡ Momentum spike", FIRST_MULTI_WALLET: "👥 Multi-wallet",
    BURST_DETECTED: "💥 Burst detected", QUALITY_SURGE: "✨ Quality surge",
  };
  return t ? m[t] ?? t : "";
}

interface AllSigs {
  quality: number; importance: number; intent: ProjectIntent; stage: ProjectStage;
  momentum: number; opportunity: number; freshness: number; staleness: number;
  isBurst: boolean; trigger: TriggerEvent; temporalScore: number; actNow: boolean;
}

function buildProjectInsight(
  project: { label: string; walletCount: number; blobCount: number; growthRate: number; fileTypes: string[]; signals: string[]; firstSeen: Date; lastActive: Date },
  _status: string, sigs: AllSigs
): string {
  if (sigs.intent === "MEDIA_SPAM") return `Media spam — ${project.walletCount} wallets uploading ${project.fileTypes.join("/")}.`;

  const parts: string[] = [];
  if (sigs.actNow) parts.push("🔥 ACT NOW");
  if (sigs.isBurst) parts.push("💥 BURST");

  parts.push(`started ${timeAgo(project.firstSeen)}`);
  parts.push(`active ${timeAgo(project.lastActive)}`);

  const desc: Record<ProjectStage, string> = { EARLY: "new", EMERGING: "building", GROWING: "growing", SATURATED: "slowing", DYING: "quiet" };
  parts.push(`📍 ${desc[sigs.stage]}`);

  if (project.walletCount > 1) parts.push(`${project.walletCount}w`);
  if (project.growthRate >= 2) parts.push(`${project.growthRate}/hr`);
  if (sigs.momentum >= 75) parts.push("⬆️ accel");
  if (sigs.trigger) parts.push(formatTrigger(sigs.trigger));
  if (sigs.opportunity >= 50) parts.push(`🔥 opp:${sigs.opportunity}`);

  return parts.join(" · ") + ".";
}

function buildNarrative(
  event: { signalType: string; explanation: string; score: number },
  project: { label: string; walletCount: number; blobCount: number; fileTypes: string[]; tags: string[]; signals: string[]; firstSeen: Date; lastActive: Date } | null,
  sigs: AllSigs
): { title: string; narrative: string; whyItMatters: string; whyNow: string | null } {

  const prefix = sigs.actNow ? "🔥 " : sigs.isBurst ? "💥 " : "";
  const stageTag = `[${sigs.stage}]`;

  let title: string;
  if (sigs.intent === "MEDIA_SPAM") title = "Media Upload Activity";
  else if (project && project.walletCount > 1) title = `${prefix}${project.label} ${stageTag}`;
  else title = `${prefix}${event.signalType.replace(/_/g, " ")} ${stageTag}`;

  const narrative = event.explanation;

  // WHY IT MATTERS
  let whyItMatters: string;
  if (sigs.opportunity >= 60 && (sigs.stage === "EARLY" || sigs.stage === "EMERGING")) {
    whyItMatters = `🔥 HIGH OPPORTUNITY — ${sigs.stage.toLowerCase()}-stage, quality ${sigs.quality}, ${sigs.momentum >= 60 ? "accelerating" : "steady"} momentum. Early discovery = real alpha.`;
  } else {
    const base: Record<string, string> = {
      MULTI_WALLET_PROJECT: "Multiple wallets converging = organized development.",
      PROJECT_GROWTH: "Sustained growth = real momentum.",
      AI_TRAINING: "AI training on decentralized storage = advanced ML.",
      AGENT_DEPLOYMENT: "Agent deployment = cutting-edge automation.",
      DATA_PIPELINE: "Production-grade data pipeline detected.",
      DATASET_FORMATION: "Dataset accumulation = training data preparation.",
      RARE_FILE_TYPE: "Novel file format = new use case.",
    };
    whyItMatters = base[event.signalType] ?? `Score ${event.score}/10 — top-tier signal.`;
    if (sigs.stage === "SATURATED" || sigs.stage === "DYING") whyItMatters += ` ⚠️ Project is ${sigs.stage.toLowerCase()}.`;
  }

  // WHY NOW — URGENCY FOCUSED
  let whyNow: string | null = null;

  if (sigs.isBurst) {
    const rate = project ? `${project.blobCount} files in ${timeAgo(project.firstSeen).replace(" ago", "")}` : "rapid upload burst";
    whyNow = `💥 BURST — ${rate}. This is happening RIGHT NOW. Growth rate suggests automated or coordinated activity.`;
  } else if (sigs.trigger === "NEW_PROJECT") {
    whyNow = `🆕 JUST APPEARED — first seen ${project ? timeAgo(project.firstSeen) : "moments ago"}. You're catching this at the absolute earliest moment.`;
  } else if (sigs.trigger === "FIRST_MULTI_WALLET") {
    whyNow = `👥 SECOND WALLET JUST JOINED — this shifted from solo to collaborative. This is the single strongest early signal of genuine project activity.`;
  } else if (sigs.trigger === "MOMENTUM_SPIKE") {
    whyNow = `⚡ SUDDEN ACCELERATION — growth rate spiked dramatically. Something just activated this project. Watch closely.`;
  } else if (sigs.trigger === "STAGE_TRANSITION") {
    whyNow = `📈 STAGE CHANGE — just crossed into ${sigs.stage}. Enough data to evaluate, still early enough to matter.`;
  } else if (sigs.actNow) {
    whyNow = `⏳ WINDOW CLOSING — this is fresh and high-quality but won't stay ${sigs.stage.toLowerCase()}-stage for long. Act before it matures.`;
  } else if (sigs.staleness <= 30) {
    whyNow = `⚠️ GOING STALE — last activity was ${project ? timeAgo(project.lastActive) : "a while ago"}. May be losing momentum.`;
  }

  return { title, narrative, whyItMatters, whyNow };
}

function timeAgo(d: Date): string {
  const s = Math.floor((Date.now() - d.getTime()) / 1000);
  if (s < 10) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
