import { prisma } from "../database/db.js";

/**
 * Insight Engine — Converts raw signals into actionable intelligence
 *
 * Transforms signal events into human-readable insights with:
 *  - importance scoring (multi-wallet, rarity, content value, growth rate)
 *  - narrative explanations ("what is happening" + "why it matters")
 *  - alert triggers for high-importance discoveries
 */

// ── Public Types ──────────────────────────────────────────────

export interface Insight {
  id: string;
  title: string;
  narrative: string;
  whyItMatters: string;
  importance: number;        // 0-100 composite score
  category: "project" | "ai" | "data" | "rare" | "alert";
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
  status: "active" | "growing" | "dormant";
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

// ── Importance Calculator ─────────────────────────────────────

/**
 * Compute a 0-100 importance score from project + signal data.
 *
 * Weights:
 *   - Multi-wallet: 0-40 pts  (most important signal)
 *   - Content value: 0-25 pts (AI/trading signals)
 *   - Growth rate:   0-20 pts (active development)
 *   - Rarity:        0-15 pts (novel formats/patterns)
 */
export function computeImportance(params: {
  walletCount: number;
  blobCount: number;
  growthRate: number;
  signals: string[];
  tags: string[];
  signalScore?: number;
}): number {
  let score = 0;

  // Multi-wallet: 0-40 pts
  if (params.walletCount >= 5) score += 40;
  else if (params.walletCount >= 3) score += 30;
  else if (params.walletCount >= 2) score += 20;
  else score += 5;

  // Content value: 0-25 pts
  const highValueSignals = new Set(["ai_interaction", "model_data", "agent_config", "trading_data"]);
  const contentHits = params.signals.filter((s) => highValueSignals.has(s)).length;
  score += Math.min(25, contentHits * 10);

  // AI/trading tags add value
  if (params.tags.includes("ai_data")) score += 5;
  if (params.tags.includes("dataset") && params.blobCount >= 5) score += 5;

  // Growth rate: 0-20 pts
  if (params.growthRate >= 10) score += 20;
  else if (params.growthRate >= 5) score += 15;
  else if (params.growthRate >= 2) score += 10;
  else if (params.growthRate >= 0.5) score += 5;

  // Rarity: 0-15 pts (rare file types or novel patterns)
  if (params.signalScore && params.signalScore >= 9) score += 15;
  else if (params.signalScore && params.signalScore >= 7) score += 10;
  else score += 5;

  return Math.min(100, score);
}

// ── Insight Generator ─────────────────────────────────────────

/**
 * Generate top insights from recent alpha events + projects.
 */
export async function generateInsights(limit = 20): Promise<Insight[]> {
  // Get recent high-value alpha events
  const recentEvents = await prisma.alphaEvent.findMany({
    where: { score: { gte: 7 } },
    orderBy: [{ score: "desc" }, { createdAt: "desc" }],
    take: limit * 2,
  });

  // Get active projects for context
  const projects = await prisma.project.findMany({
    where: { blobCount: { gte: 2 } },
    orderBy: [{ walletCount: "desc" }, { blobCount: "desc" }],
    take: 50,
  });

  const projectMap = new Map(projects.map((p) => [p.id, p]));

  // Deduplicate by project — keep highest-scored event per project
  const seen = new Map<string, typeof recentEvents[0]>();
  for (const event of recentEvents) {
    // Try to find project context
    const projectId = findProjectForEvent(event, projects);
    const key = projectId ?? `standalone:${event.id}`;

    if (!seen.has(key) || event.score > (seen.get(key)?.score ?? 0)) {
      seen.set(key, event);
    }
  }

  // Convert to insights
  const insights: Insight[] = [];
  for (const [key, event] of seen) {
    const projectId = key.startsWith("standalone:") ? null : key;
    const project = projectId ? projectMap.get(projectId) ?? null : null;

    const importance = computeImportance({
      walletCount: project?.walletCount ?? 1,
      blobCount: project?.blobCount ?? 1,
      growthRate: project?.growthRate ?? 0,
      signals: project?.signals ?? [],
      tags: project?.tags ?? [],
      signalScore: event.score,
    });

    const category = categorizeSignal(event.signalType);
    const { title, narrative, whyItMatters } = generateNarrative(
      event,
      project
    );

    insights.push({
      id: `insight-${event.id}`,
      title,
      narrative,
      whyItMatters,
      importance,
      category,
      projectId,
      projectLabel: project?.label ?? null,
      walletCount: project?.walletCount ?? 1,
      blobCount: project?.blobCount ?? 1,
      signals: project?.signals ?? [event.signalType],
      timestamp: event.createdAt.toISOString(),
      timeAgo: getTimeAgo(event.createdAt),
    });
  }

  // Sort by importance desc, take limit
  return insights
    .sort((a, b) => b.importance - a.importance)
    .slice(0, limit);
}

// ── Project Summaries ─────────────────────────────────────────

/**
 * Get all project summaries with status and importance.
 */
export async function getProjectSummaries(limit = 20): Promise<ProjectSummary[]> {
  const projects = await prisma.project.findMany({
    where: { blobCount: { gte: 2 } },
    orderBy: [{ walletCount: "desc" }, { blobCount: "desc" }],
    take: limit,
  });

  const now = new Date();

  return projects.map((p) => {
    const hoursSinceActive = (now.getTime() - p.lastActive.getTime()) / 3_600_000;

    let status: "active" | "growing" | "dormant";
    if (hoursSinceActive < 1 && p.growthRate >= 1) status = "growing";
    else if (hoursSinceActive < 6) status = "active";
    else status = "dormant";

    const importance = computeImportance({
      walletCount: p.walletCount,
      blobCount: p.blobCount,
      growthRate: p.growthRate,
      signals: p.signals,
      tags: p.tags,
    });

    // Generate top insight text
    const topInsight = generateProjectInsight(p, status);

    return {
      projectId: p.id,
      label: p.label,
      category: p.category,
      status,
      wallets: p.wallets.map((w) => `${w.slice(0, 8)}...${w.slice(-4)}`),
      walletCount: p.walletCount,
      blobCount: p.blobCount,
      growthRate: p.growthRate,
      tags: p.tags,
      signals: p.signals,
      fileTypes: p.fileTypes,
      firstSeen: p.firstSeen.toISOString(),
      lastActive: p.lastActive.toISOString(),
      importance,
      topInsight,
      recentSignals: [], // populated below in route if needed
    };
  }).sort((a, b) => b.importance - a.importance);
}

// ── Alert Generation ──────────────────────────────────────────

/**
 * Generate alerts for high-importance projects and events.
 */
export async function generateAlerts(): Promise<Alert[]> {
  const alerts: Alert[] = [];
  const now = new Date();
  const oneHourAgo = new Date(now.getTime() - 3_600_000);

  // Alert 1: Multi-wallet projects with high activity
  const hotProjects = await prisma.project.findMany({
    where: {
      walletCount: { gte: 3 },
      lastActive: { gte: oneHourAgo },
      growthRate: { gte: 2 },
    },
    orderBy: { walletCount: "desc" },
    take: 5,
  });

  for (const p of hotProjects) {
    const importance = computeImportance({
      walletCount: p.walletCount,
      blobCount: p.blobCount,
      growthRate: p.growthRate,
      signals: p.signals,
      tags: p.tags,
    });

    alerts.push({
      id: `alert-project-${p.id}`,
      level: p.walletCount >= 5 ? "critical" : "high",
      title: `🔥 ${p.label} — active multi-wallet project`,
      message: `${p.walletCount} wallets are actively contributing to this project (${p.blobCount} files, ${p.growthRate}/hr). ${generateProjectInsight(p, "growing")}`,
      projectId: p.id,
      importance,
      timestamp: p.lastActive.toISOString(),
    });
  }

  // Alert 2: AI-related projects with recent activity
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
    if (hotProjects.some((hp) => hp.id === p.id)) continue; // skip duplicates

    alerts.push({
      id: `alert-ai-${p.id}`,
      level: "high",
      title: `🤖 AI project active: ${p.label}`,
      message: `AI-related project with ${p.blobCount} files from ${p.walletCount} wallet(s). Signals: ${p.signals.join(", ")}`,
      projectId: p.id,
      importance: computeImportance({
        walletCount: p.walletCount,
        blobCount: p.blobCount,
        growthRate: p.growthRate,
        signals: p.signals,
        tags: p.tags,
      }),
      timestamp: p.lastActive.toISOString(),
    });
  }

  // Alert 3: High-score events in the last hour
  const highScoreEvents = await prisma.alphaEvent.findMany({
    where: {
      score: { gte: 9 },
      createdAt: { gte: oneHourAgo },
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

// ── Internal Helpers ──────────────────────────────────────────

function findProjectForEvent(
  event: { owner: string; blobName: string | null },
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

function generateProjectInsight(project: ProjectLike, status: string): string {
  const parts: string[] = [];

  if (project.walletCount > 1) {
    parts.push(`${project.walletCount} wallets are collaborating on this ${project.category} project`);
  }

  if (status === "growing") {
    parts.push(`uploading at ${project.growthRate} files/hour`);
  }

  if (project.signals.length > 0) {
    const domainSignals = project.signals.filter((s) =>
      ["ai_interaction", "model_data", "trading_data", "agent_config"].includes(s)
    );
    if (domainSignals.length > 0) {
      parts.push(`detected ${domainSignals.join(" + ")} activity`);
    }
  }

  if (project.fileTypes.length > 2) {
    parts.push(`using ${project.fileTypes.length} different file types`);
  }

  return parts.length > 0 ? parts.join(", ") + "." : "Monitoring for further activity.";
}

function generateNarrative(
  event: { signalType: string; explanation: string; score: number; owner: string },
  project: ProjectLike | null
): { title: string; narrative: string; whyItMatters: string } {
  const signalLabel = event.signalType.replace(/_/g, " ").toLowerCase();

  // Title: short, punchy
  let title: string;
  if (project && project.walletCount > 1) {
    title = `${project.label}`;
  } else {
    title = event.signalType.replace(/_/g, " ");
  }

  // Narrative: what is happening
  let narrative = event.explanation;

  // Why it matters: the actionable takeaway
  let whyItMatters: string;
  switch (event.signalType) {
    case "MULTI_WALLET_PROJECT":
      whyItMatters = "Multiple independent wallets converging on the same project is the strongest signal of organized development activity. This rarely happens by coincidence.";
      break;
    case "PROJECT_GROWTH":
      whyItMatters = "Sustained file accumulation indicates a project with real momentum — someone is actively building, not just testing.";
      break;
    case "AI_TRAINING":
      whyItMatters = "AI model training on decentralized storage is advanced usage that indicates sophisticated ML workflows and potential alpha.";
      break;
    case "AI_INFERENCE":
      whyItMatters = "Real-time AI inference outputs suggest a live production system, not just experiments.";
      break;
    case "AGENT_DEPLOYMENT":
      whyItMatters = "Autonomous agent deployments represent the cutting edge of on-chain automation — these systems operate independently.";
      break;
    case "DATA_PIPELINE":
      whyItMatters = "Sustained data upload rates indicate production ETL systems or automated data collection workflows.";
      break;
    case "DATASET_FORMATION":
      whyItMatters = "Large datasets forming on-chain suggest training data preparation, research archives, or analytics infrastructure.";
      break;
    case "RARE_FILE_TYPE":
      whyItMatters = "Novel file formats expand the ecosystem's capabilities and may signal new use cases entering Shelby.";
      break;
    default:
      whyItMatters = `This ${signalLabel} event scored ${event.score}/10, placing it in the top tier of detected activity.`;
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
