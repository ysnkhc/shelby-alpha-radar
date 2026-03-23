/**
 * Shelby Indexer — Event Discovery Script
 *
 * Scans recent Aptos blocks to discover event patterns used by Shelby.
 *
 * Usage:  npx tsx scripts/discover-events.ts [--blocks=N]
 *
 * Steps:
 *   1. Fetch latest block height from Aptos RPC
 *   2. Scan the last N blocks (default 20)
 *   3. Log all events with type, account address, and data
 *   4. Identify candidate Shelby-related event types
 *   5. Print summary of findings
 */

import "dotenv/config";

// ── Config ────────────────────────────────────────────────────

const APTOS_RPC_URL = process.env.APTOS_RPC_URL ?? "https://fullnode.mainnet.aptoslabs.com/v1";
const BLOCKS_TO_SCAN = getArgInt("--blocks", 20);
const MAX_DATA_LENGTH = 200; // Truncate event data for readability

// Known Shelby module address from crawler config
const SHELBY_MODULE_PREFIX =
  "0x85fdb9a176ab8ef1d9d9c1b60d60b3924f0800ac1de1cc2085fb0b8bb4988e6a";

// Keywords that suggest storage/blob activity
const STORAGE_KEYWORDS = [
  "blob", "storage", "store", "size", "hash", "name",
  "commit", "register", "upload", "write", "create",
  "shelby", "content", "data", "object",
];

// ── Types ─────────────────────────────────────────────────────

interface LedgerInfo {
  block_height: string;
  ledger_version: string;
  [key: string]: unknown;
}

interface AptosBlock {
  block_height: string;
  block_hash: string;
  block_timestamp: string;
  first_version: string;
  last_version: string;
  transactions?: AptosTransaction[];
}

interface AptosTransaction {
  type: string;
  version: string;
  hash: string;
  success: boolean;
  sender?: string;
  events?: TransactionEvent[];
  payload?: { type: string; function?: string; [key: string]: unknown };
  [key: string]: unknown;
}

interface TransactionEvent {
  guid: { creation_number: string; account_address: string };
  sequence_number: string;
  type: string;
  data: Record<string, unknown>;
}

interface EventSummary {
  eventType: string;
  count: number;
  accountAddresses: Set<string>;
  sampleData: string[];
  txHashes: string[];
  matchedKeywords: string[];
}

// ── Aptos RPC helpers ─────────────────────────────────────────

async function aptosGet<T>(path: string): Promise<T> {
  const url = `${APTOS_RPC_URL.replace(/\/+$/, "")}${path}`;
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Aptos RPC ${res.status}: ${path} — ${body.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

async function getLatestBlockHeight(): Promise<number> {
  const info = await aptosGet<LedgerInfo>("/");
  return Number(info.block_height);
}

async function getBlockByHeight(height: number): Promise<AptosBlock> {
  return aptosGet<AptosBlock>(`/blocks/by_height/${height}?with_transactions=true`);
}

// ── Helpers ───────────────────────────────────────────────────

function truncate(obj: unknown, maxLen: number): string {
  const str = JSON.stringify(obj);
  return str.length > maxLen ? str.slice(0, maxLen) + "…" : str;
}

function getArgInt(flag: string, defaultVal: number): number {
  const arg = process.argv.find((a) => a.startsWith(flag + "="));
  if (!arg) return defaultVal;
  const val = parseInt(arg.split("=")[1], 10);
  return isNaN(val) ? defaultVal : val;
}

function matchesKeywords(text: string): string[] {
  const lower = text.toLowerCase();
  return STORAGE_KEYWORDS.filter((kw) => lower.includes(kw));
}

// ── Main ──────────────────────────────────────────────────────

async function main() {
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  Shelby Indexer — Event Discovery Script");
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`  RPC:            ${APTOS_RPC_URL}`);
  console.log(`  Blocks to scan: ${BLOCKS_TO_SCAN}`);
  console.log(`  Shelby module:  ${SHELBY_MODULE_PREFIX}`);
  console.log("");

  // 1. Get latest block height
  const latestBlock = await getLatestBlockHeight();
  const startBlock = Math.max(0, latestBlock - BLOCKS_TO_SCAN + 1);
  console.log(`📊 Latest block: ${latestBlock}`);
  console.log(`📊 Scanning blocks ${startBlock} → ${latestBlock}`);
  console.log("");

  // 2. Scan blocks and collect events
  const eventMap = new Map<string, EventSummary>();
  let totalTx = 0;
  let totalEvents = 0;
  let totalUserTx = 0;
  let blocksWithTx = 0;

  for (let height = startBlock; height <= latestBlock; height++) {
    process.stdout.write(`\r🔍 Scanning block ${height}/${latestBlock}...`);

    let block: AptosBlock;
    try {
      block = await getBlockByHeight(height);
    } catch (err) {
      console.warn(`\n⚠️  Block ${height} failed: ${(err as Error).message}`);
      continue;
    }

    const transactions = block.transactions ?? [];
    if (transactions.length > 0) blocksWithTx++;
    totalTx += transactions.length;

    for (const tx of transactions) {
      if (tx.type !== "user_transaction") continue;
      totalUserTx++;

      const events = tx.events ?? [];
      totalEvents += events.length;

      for (const event of events) {
        const eventType = event.type;
        const accountAddr = event.guid.account_address;
        const dataStr = truncate(event.data, MAX_DATA_LENGTH);

        // Check keywords in event type and data
        const typeKeywords = matchesKeywords(eventType);
        const dataKeywords = matchesKeywords(JSON.stringify(event.data));
        const allKeywords = [...new Set([...typeKeywords, ...dataKeywords])];

        // Accumulate in map
        let summary = eventMap.get(eventType);
        if (!summary) {
          summary = {
            eventType,
            count: 0,
            accountAddresses: new Set(),
            sampleData: [],
            txHashes: [],
            matchedKeywords: [],
          };
          eventMap.set(eventType, summary);
        }

        summary.count++;
        summary.accountAddresses.add(accountAddr);
        if (summary.sampleData.length < 3) summary.sampleData.push(dataStr);
        if (summary.txHashes.length < 3) summary.txHashes.push(tx.hash);
        if (allKeywords.length > 0) {
          for (const kw of allKeywords) {
            if (!summary.matchedKeywords.includes(kw)) {
              summary.matchedKeywords.push(kw);
            }
          }
        }
      }

      // Verbose per-event log for user transactions with events
      if (events.length > 0) {
        console.log(`\n\n── Block ${height} | Tx ${tx.hash.slice(0, 16)}… ──`);
        if (tx.payload?.function) {
          console.log(`   Function: ${tx.payload.function}`);
        }
        for (const event of events) {
          const isShelbyModule = event.type.toLowerCase().includes(SHELBY_MODULE_PREFIX.toLowerCase());
          const marker = isShelbyModule ? " 🟢 SHELBY MODULE" : "";
          console.log(`   📌 Event: ${event.type}${marker}`);
          console.log(`      Addr:  ${event.guid.account_address}`);
          console.log(`      Data:  ${truncate(event.data, MAX_DATA_LENGTH)}`);
        }
      }
    }
  }

  // 3. Print summary
  console.log("\n\n");
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  SCAN SUMMARY");
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`  Blocks scanned:       ${BLOCKS_TO_SCAN}`);
  console.log(`  Blocks with txns:     ${blocksWithTx}`);
  console.log(`  Total transactions:   ${totalTx}`);
  console.log(`  User transactions:    ${totalUserTx}`);
  console.log(`  Total events:         ${totalEvents}`);
  console.log(`  Unique event types:   ${eventMap.size}`);
  console.log("");

  // 4. All event types (sorted by count)
  const allEvents = [...eventMap.values()].sort((a, b) => b.count - a.count);

  console.log("───────────────────────────────────────────────────────────");
  console.log("  ALL EVENT TYPES (by frequency)");
  console.log("───────────────────────────────────────────────────────────");
  for (const ev of allEvents) {
    const addrs = [...ev.accountAddresses].slice(0, 3).join(", ");
    console.log(`  [${ev.count}x] ${ev.eventType}`);
    console.log(`        Accounts: ${addrs}`);
    if (ev.matchedKeywords.length > 0) {
      console.log(`        Keywords: ${ev.matchedKeywords.join(", ")}`);
    }
  }

  // 5. Candidate Shelby events
  console.log("\n");
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  🔎 POTENTIAL SHELBY EVENTS");
  console.log("═══════════════════════════════════════════════════════════");

  const candidates = allEvents.filter((ev) => {
    const type = ev.type ?? ev.eventType;
    const typeLower = type.toLowerCase();
    // Match if:  involves Shelby module address, OR has storage/blob keywords in type
    if (typeLower.includes(SHELBY_MODULE_PREFIX.toLowerCase())) return true;
    if (ev.matchedKeywords.some((kw) =>
      STORAGE_KEYWORDS.slice(0, 8).includes(kw) // blob, storage, store, size, hash, name, commit, register
    )) return true;
    return false;
  });

  if (candidates.length === 0) {
    console.log("  ⚠️  No obvious Shelby-related events found in the scanned blocks.");
    console.log("  Suggestions:");
    console.log("    • Try scanning more blocks: --blocks=50 or --blocks=100");
    console.log("    • Verify the Shelby module address is correct");
    console.log("    • Try during periods of known Shelby activity");
  } else {
    for (const ev of candidates) {
      console.log(`\n  🟢 CANDIDATE: ${ev.eventType}`);
      console.log(`     Count:      ${ev.count}`);
      console.log(`     Accounts:   ${[...ev.accountAddresses].join(", ")}`);
      console.log(`     Keywords:   ${ev.matchedKeywords.join(", ")}`);
      console.log(`     Tx hashes:  ${ev.txHashes.join(", ")}`);
      console.log(`     Sample data:`);
      for (const sample of ev.sampleData) {
        console.log(`       ${sample}`);
      }
    }
  }

  // 6. Also list all unique modules seen (extract module address from event types)
  console.log("\n");
  console.log("───────────────────────────────────────────────────────────");
  console.log("  UNIQUE MODULE ADDRESSES (from event types)");
  console.log("───────────────────────────────────────────────────────────");
  const moduleAddresses = new Set<string>();
  for (const ev of allEvents) {
    // Event types are like "0xABCD::module_name::EventName"
    const match = ev.eventType.match(/^(0x[a-fA-F0-9]+)::/);
    if (match) moduleAddresses.add(match[1]);
  }
  for (const addr of moduleAddresses) {
    const isShelby = addr.toLowerCase() === SHELBY_MODULE_PREFIX.toLowerCase();
    console.log(`  ${isShelby ? "🟢" : "  "} ${addr}${isShelby ? " ← SHELBY MODULE" : ""}`);
  }

  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("  Discovery complete.");
  console.log("═══════════════════════════════════════════════════════════\n");
}

main().catch((err) => {
  console.error("\n❌ Fatal error:", err);
  process.exit(1);
});
