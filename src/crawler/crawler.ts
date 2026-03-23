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
 *  BlobRegisteredEvent — emitted by `register_multiple_blobs`
 *    Data: { blob_name, blob_commitment, blob_size, owner, ... }
 *    → NOT indexed (blob not yet fully written)
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
 * Crawler Service — Aptos Event Scanner
 *
 * Scans Shelbynet Aptos blocks for Shelby blob commit events.
 *
 * Flow:
 * 1. Read last processed block from the database
 * 2. Fetch new blocks from Shelbynet Aptos fullnode
 * 3. Inspect transaction events for Shelby module activity
 * 4. Extract account address + blob name from matching events
 * 5. Push discovered blobs to the processing queue
 * 6. Persist the latest processed block height
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
    pollIntervalMs = 10_000,
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
    this.lastProcessedBlock = await this.loadLastProcessedBlock();
    console.log(`🔍 Crawler started at block ${this.lastProcessedBlock}`);

    void this.poll();
  }

  stop(): void {
    this.running = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    console.log(`🛑 Crawler stopped at block ${this.lastProcessedBlock}`);
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

      // Process up to 5 blocks per cycle (rate-limited)
      const nextBlock = this.lastProcessedBlock + 1;
      const endBlock = Math.min(nextBlock + 4, latestBlock);

      let totalBlobs = 0;

      for (let height = nextBlock; height <= endBlock && this.running; height++) {
        const blobs = await this.processBlock(height);
        totalBlobs += blobs;

        // Rate limit: 500ms between block fetches to avoid 429
        if (height < endBlock) {
          await new Promise((r) => setTimeout(r, 500));
        }
      }

      // Persist progress
      this.lastProcessedBlock = endBlock;
      await this.saveLastProcessedBlock(endBlock);

      if (totalBlobs > 0) {
        console.log(
          `✅ Blocks ${nextBlock}–${endBlock}: ${totalBlobs} blob events found`
        );
      }

      // If more blocks remain, add a small delay before continuing (catch-up mode)
      if (endBlock < latestBlock) {
        this.pollTimer = setTimeout(
          () => void this.poll(),
          1_000 // 1s between catch-up cycles
        );
      } else {
        this.schedulePoll();
      }
    } catch (error) {
      console.error(
        "❌ Crawler poll failed:",
        error instanceof Error ? error.message : error
      );
      // Longer delay after errors (e.g. 429 rate limit)
      this.pollTimer = setTimeout(
        () => void this.poll(),
        5_000
      );
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

  /**
   * Fetch a block with transactions, scan events, and enqueue blobs.
   * Returns the number of blob events found.
   */
  private async processBlock(height: number): Promise<number> {
    let block: AptosBlock;
    try {
      block = await this.aptos.getBlockByHeight(height, true);
    } catch (error) {
      // Some blocks might not exist or timeout — skip gracefully
      console.warn(
        `⚠️  Block ${height} fetch failed:`,
        error instanceof Error ? error.message : error
      );
      return 0;
    }

    const transactions = block.transactions ?? [];
    let blobCount = 0;

    for (const tx of transactions) {
      if (tx.type !== "user_transaction" || !tx.events) continue;

      for (const event of tx.events) {
        if (this.isShelbyBlobEvent(event)) {
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

  /**
   * Check if an event is a confirmed Shelby blob event.
   * Matches against the exact event types discovered on Shelbynet.
   */
  private isShelbyBlobEvent(event: TransactionEvent): boolean {
    return event.type === SHELBY_BLOB_WRITTEN_EVENT;
  }

  /**
   * Extract account address and blob name from a Shelby event.
   *
   * BlobRegisteredEvent data:
   *   { blob_name, blob_commitment, blob_size, owner, ... }
   *
   * BlobWrittenEvent data:
   *   { blob_name, owner, chunkset_count, creation_micros }
   */
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
      // Table might not exist yet — start from 0
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
        "⚠️  Could not persist crawler state:",
        error instanceof Error ? error.message : error
      );
    }
  }
}
