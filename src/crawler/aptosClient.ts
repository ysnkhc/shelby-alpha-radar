import { env } from "../config/env.js";
import type {
  LedgerInfo,
  AptosBlock,
  AptosTransaction,
} from "../types.js";

/**
 * Aptos REST API Client
 *
 * Communicates with an Aptos fullnode to scan blocks, transactions, and events.
 * Uses the native `fetch` API (Node 18+).
 *
 * Endpoints:
 *   GET /v1/                                         — ledger info
 *   GET /v1/blocks/by_height/{h}?with_transactions=  — block + txns
 *   GET /v1/transactions?start=N&limit=M             — transaction batch
 */
export class AptosClient {
  private readonly baseUrl: string;
  private readonly timeout: number;

  constructor(baseUrl?: string, timeoutMs = 20_000) {
    this.baseUrl = (baseUrl ?? env.APTOS_RPC_URL).replace(/\/+$/, "");
    this.timeout = timeoutMs;
  }

  // ── Ledger ─────────────────────────────────────────────────

  /** Get current ledger info (latest block height, version, etc.) */
  async getLedgerInfo(): Promise<LedgerInfo> {
    return this.get<LedgerInfo>("/");
  }

  /** Get the latest block height as a number */
  async getLatestBlockHeight(): Promise<number> {
    const info = await this.getLedgerInfo();
    return Number(info.block_height);
  }

  // ── Blocks ─────────────────────────────────────────────────

  /**
   * Fetch a block by height, optionally including its transactions.
   */
  async getBlockByHeight(
    height: number,
    withTransactions = true
  ): Promise<AptosBlock> {
    const params = withTransactions ? "?with_transactions=true" : "";
    return this.get<AptosBlock>(`/blocks/by_height/${height}${params}`);
  }

  // ── Transactions ───────────────────────────────────────────

  /**
   * Fetch a batch of transactions by ledger version range.
   */
  async getTransactions(
    start: number,
    limit = 100
  ): Promise<AptosTransaction[]> {
    const params = new URLSearchParams({
      start: String(start),
      limit: String(limit),
    });
    return this.get<AptosTransaction[]>(`/transactions?${params}`);
  }

  // ── Health ─────────────────────────────────────────────────

  /** Quick connectivity check */
  async healthCheck(): Promise<boolean> {
    try {
      await this.getLedgerInfo();
      return true;
    } catch {
      return false;
    }
  }

  // ── Internal ───────────────────────────────────────────────

  private async get<T>(path: string): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new AptosClientError(
          `Aptos RPC ${response.status}: ${path}`,
          response.status,
          body
        );
      }

      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof AptosClientError) throw error;
      const msg = error instanceof Error ? error.message : "Unknown error";
      throw new AptosClientError(`Aptos request failed: ${msg}`, 0);
    } finally {
      clearTimeout(timer);
    }
  }
}

export class AptosClientError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly responseBody?: string
  ) {
    super(message);
    this.name = "AptosClientError";
  }
}
