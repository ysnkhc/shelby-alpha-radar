import { AptosClient } from "./aptosClient.js";
import { prisma } from "../database/db.js";
import type { AptosBlock, TransactionEvent, BlobJobData } from "../types.js";

/**
 * Shelby blob module address (discovered on-chain).
 * Events from this module signal blob commit operations.
 */
const SHELBY_MODULE_PREFIX =
  "0x85fdb9a176ab8ef1d9d9c1b60d60b3924f0800ac1de1cc2085fb0b8bb4988e6a";

/**
 * Confirmed Shelby blob event types (discovered via event scanning):
 *
 *  BlobWrittenEvent — emitted by `add_blob_acknowledgements`
 *    Data: { blob_name, owner, chunkset_count, creation_micros }
 *    → Indexed (blob fully written and available)
 */
const SHELBY_BLOB_WRITTEN_EVENT =
  `${SHELBY_MODULE_PREFIX}::blob_metadata::BlobWrittenEvent`;

/** Key used for the crawler_state table */
const CRAWLER_STATE_KEY = "last_processed_block";

/**
 * How many blocks behind chain tip to start when no saved state exists.
 * 1000 blocks ≈ ~17 minutes of history on Shelbynet (~1 block/s).
 */
const INITIAL_LOOKBACK = 1000;

/**
 * Crawler Service — Aptos Event Scanner
 *
 * Scans Shelbynet Aptos blocks for Shelby blob commit events.
 */
export class CrawlerService {
  private readonly aptos: AptosClient;
  private readonly pollIntervalMs: number;
  private readonly onBlobDiscovered: (blob: BlobJobData) => Promise<void>;

  private running = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private lastProcessedBlock = 0;

  constructor(
    onBlobDiscovered: (blob: BlobJobData) => Promise<void>,
    pollIntervalMs = 5_000,
    aptosClient?: AptosClient
  ) {
    this.aptos = aptosClient ?? new AptosClient();
    this.pollIntervalMs = pollIntervalMs;
    this.onBlobDiscovered = onBlobDiscovered;
  }

  // ── Lifecycle ───────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    // Restore last processed block from DB
    const savedBlock = await this.loadLastProcessedBlock();

    if (savedBlock > 0) {
      this.lastProcessedBlock = savedBlock;
      console.log(`[Crawler] Resuming from saved block ${savedBlock}`);
    } else {
      // First run — start near chain tip, not block 0!
      const latestBlock = await this.aptos.getLatestBlockHeight();
      this.lastProcessedBlock = Math.max(0, latestBlock - INITIAL_LOOKBACK);
      console.log(
        `[Crawler] First run — chain tip: ${latestBlock}, starting from block ${this.lastProcessedBlock}`
      );
    }

    void this.poll();
  }

  stop(): void {
    this.running = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    console.log(`[Crawler] Stopped at block ${this.lastProcessedBlock}`);
  }

  // ── Core loop ──────────────────────────────────────────────

  private async poll(): Promise<void> {
    if (!this.running) return;

    try {
      const latestBlock = await this.aptos.getLatestBlockHeight();

      if (this.lastProcessedBlock >= latestBlock) {
        // Nothing new yet
        this.schedulePoll();
        return;
      }

      const gap = latestBlock - this.lastProcessedBlock;
      // Process up to 10 blocks per cycle
      const batchSize = Math.min(10, gap);
      const nextBlock = this.lastProcessedBlock + 1;
      const endBlock = nextBlock + batchSize - 1;

      console.log(
        `[Crawler] Processing blocks ${nextBlock}–${endBlock} (gap: ${gap})`
      );

      let totalBlobs = 0;

      for (let height = nextBlock; height <= endBlock && this.running; height++) {
        const blobs = await this.processBlock(height);
        totalBlobs += blobs;

        // Rate limit: 200ms between block fetches
        if (height < endBlock) {
          await new Promise((r) => setTimeout(r, 200));
        }
      }

      // Persist progress
      this.lastProcessedBlock = endBlock;
      await this.saveLastProcessedBlock(endBlock);

      if (totalBlobs > 0) {
        console.log(
          `[Crawler] ✅ Blocks ${nextBlock}–${endBlock}: ${totalBlobs} blob events found`
        );
      }

      // If still behind, short delay; otherwise normal poll
      if (endBlock < latestBlock) {
        this.pollTimer = setTimeout(() => void this.poll(), 500);
      } else {
        this.schedulePoll();
      }
    } catch (error) {
      console.error(
        "[Crawler] ❌ Poll failed:",
        error instanceof Error ? error.message : error
      );
      // Longer delay after errors
      this.pollTimer = setTimeout(() => void this.poll(), 5_000);
    }
  }

  private schedulePoll(): void {
    if (this.running) {
      this.pollTimer = setTimeout(
        () => void this.poll(),
        this.pollIntervalMs
      );
    }
  }

  // ── Block Processing ───────────────────────────────────────

  private async processBlock(height: number): Promise<number> {
    let block: AptosBlock;
    try {
      block = await this.aptos.getBlockByHeight(height, true);
    } catch (error) {
      console.warn(
        `[Crawler] ⚠️ Block ${height} fetch failed:`,
        error instanceof Error ? error.message : error
      );
      return 0;
    }

    const transactions = block.transactions ?? [];
    let blobCount = 0;

    for (const tx of transactions) {
      if (tx.type !== "user_transaction" || !tx.events) continue;

      for (const event of tx.events) {
        // Log ALL event types for debugging (first 50 blocks only)
        if (height <= this.lastProcessedBlock + 50) {
          if (event.type.includes(SHELBY_MODULE_PREFIX)) {
            console.log(`[Event] Shelby event detected: ${event.type}`);
          }
        }

        if (this.isShelbyBlobEvent(event)) {
          console.log(
            `[Event] ✅ BlobWrittenEvent in block ${height}: owner=${event.data["owner"]}, blob=${event.data["blob_name"]}`
          );
          const jobData = this.extractBlobJob(event, tx.hash, block);
          if (jobData) {
            await this.onBlobDiscovered(jobData);
            blobCount++;
          }
        }
      }
    }

    return blobCount;
  }

  // ── Event Detection ────────────────────────────────────────

  private isShelbyBlobEvent(event: TransactionEvent): boolean {
    return event.type === SHELBY_BLOB_WRITTEN_EVENT;
  }

  private extractBlobJob(
    event: TransactionEvent,
    txHash: string,
    block: AptosBlock
  ): BlobJobData | null {
    const accountAddress =
      (event.data["owner"] as string) ??
      event.guid.account_address;

    const blobName =
      (event.data["blob_name"] as string) ??
      `unknown-${block.block_height}-${event.sequence_number}`;

    if (!accountAddress) return null;

    return {
      accountAddress,
      blobName: String(blobName),
      txHash,
      blockHeight: block.block_height,
      timestamp: block.block_timestamp,
    };
  }

  // ── State Persistence ──────────────────────────────────────

  private async loadLastProcessedBlock(): Promise<number> {
    try {
      const state = await prisma.crawlerState.findUnique({
        where: { key: CRAWLER_STATE_KEY },
      });
      return state ? Number(state.value) : 0;
    } catch {
      return 0;
    }
  }

  private async saveLastProcessedBlock(height: number): Promise<void> {
    try {
      await prisma.crawlerState.upsert({
        where: { key: CRAWLER_STATE_KEY },
        update: { value: String(height), updatedAt: new Date() },
        create: { key: CRAWLER_STATE_KEY, value: String(height) },
      });
    } catch (error) {
      console.warn(
        "[Crawler] ⚠️ Could not persist state:",
        error instanceof Error ? error.message : error
      );
    }
  }
}
