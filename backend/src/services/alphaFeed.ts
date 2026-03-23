import { EventEmitter } from "node:events";

/**
 * Alpha Live Feed — Real-Time Broadcast Service
 *
 * Priority tiers:
 *   HIGH   — score ≥ 8 or coordination/velocity signals
 *   MEDIUM — score 6–7
 *   LOW    — score 5
 */

export type AlphaPriority = "HIGH" | "MEDIUM" | "LOW";

export interface LiveAlphaEvent {
  id: number;
  owner: string;
  ownerShort: string;
  blobName: string | null;
  signalType: string;
  score: number;
  priority: AlphaPriority;
  explanation: string;
  impact: string;
  context: string;
  timestamp: string;
}

/** Compute priority from score + signal type */
export function computePriority(
  score: number,
  signalType: string
): AlphaPriority {
  // Coordination and velocity are always boosted
  const boostedTypes = new Set(["CROSS_WALLET_PATTERN", "WALLET_VELOCITY"]);

  if (score >= 8 || (score >= 6 && boostedTypes.has(signalType))) {
    return "HIGH";
  }
  if (score >= 6) {
    return "MEDIUM";
  }
  return "LOW";
}

const PRIORITY_RANK: Record<AlphaPriority, number> = {
  HIGH: 3,
  MEDIUM: 2,
  LOW: 1,
};

const CACHE_SIZE = 50;
const THROTTLE_WINDOW_MS = 60_000;

class AlphaLiveFeed {
  private emitter = new EventEmitter();
  private cache: LiveAlphaEvent[] = [];
  private recentKeys = new Map<string, number>();

  constructor() {
    this.emitter.setMaxListeners(200);

    const cleanup = setInterval(() => {
      const now = Date.now();
      for (const [key, ts] of this.recentKeys) {
        if (now - ts > THROTTLE_WINDOW_MS * 2) this.recentKeys.delete(key);
      }
    }, 300_000);
    cleanup.unref();
  }

  /** Broadcast event to all clients. Returns false if throttled. */
  broadcast(event: LiveAlphaEvent): boolean {
    const dedupeKey = `${event.owner}:${event.signalType}`;
    const now = Date.now();

    const lastEmit = this.recentKeys.get(dedupeKey);
    if (lastEmit && now - lastEmit < THROTTLE_WINDOW_MS) {
      return false;
    }

    this.recentKeys.set(dedupeKey, now);

    this.cache.push(event);
    if (this.cache.length > CACHE_SIZE) {
      this.cache = this.cache.slice(-CACHE_SIZE);
    }

    this.emitter.emit("alpha", event);
    return true;
  }

  /** Subscribe with optional filter. Returns unsubscribe function. */
  subscribe(
    callback: (event: LiveAlphaEvent) => void,
    filter?: { minPriority?: AlphaPriority; owner?: string }
  ): () => void {
    const filtered = (event: LiveAlphaEvent) => {
      // Priority filter
      if (
        filter?.minPriority &&
        PRIORITY_RANK[event.priority] < PRIORITY_RANK[filter.minPriority]
      ) {
        return;
      }
      // Owner watchlist filter
      if (filter?.owner && event.owner !== filter.owner) {
        return;
      }
      callback(event);
    };

    this.emitter.on("alpha", filtered);
    return () => {
      this.emitter.off("alpha", filtered);
    };
  }

  /** Get recent cached events, optionally filtered. */
  getRecent(filter?: {
    minPriority?: AlphaPriority;
    owner?: string;
  }): LiveAlphaEvent[] {
    let events = [...this.cache];

    if (filter?.minPriority) {
      const minRank = PRIORITY_RANK[filter.minPriority];
      events = events.filter((e) => PRIORITY_RANK[e.priority] >= minRank);
    }
    if (filter?.owner) {
      events = events.filter((e) => e.owner === filter.owner);
    }

    return events;
  }

  get clientCount(): number {
    return this.emitter.listenerCount("alpha");
  }
}

export const alphaFeed = new AlphaLiveFeed();
