/**
 * Shared types for the Shelby Indexer.
 *
 * - Aptos types: for scanning blocks/transactions/events from Aptos RPC
 * - Shelby types: for blob retrieval from Shelby RPC
 * - Job types: for the BullMQ processing queue
 */

// ── Aptos Chain / Ledger ──────────────────────────────────────

/** Response from GET /v1/ — ledger info */
export interface LedgerInfo {
  chain_id: number;
  epoch: string;
  ledger_version: string;
  oldest_ledger_version: string;
  ledger_timestamp: string;
  node_role: string;
  oldest_block_height: string;
  block_height: string;
  git_hash: string;
}

// ── Aptos Blocks ──────────────────────────────────────────────

/** Response from GET /v1/blocks/by_height/{height}?with_transactions=true */
export interface AptosBlock {
  block_height: string;
  block_hash: string;
  block_timestamp: string;
  first_version: string;
  last_version: string;
  transactions?: AptosTransaction[];
}

// ── Aptos Transactions ───────────────────────────────────────

export interface AptosTransaction {
  type: string;
  version: string;
  hash: string;
  success: boolean;
  vm_status: string;
  timestamp?: string;
  sender?: string;
  sequence_number?: string;
  payload?: TransactionPayload;
  events?: TransactionEvent[];
}

export interface TransactionPayload {
  type: string;
  function?: string;
  type_arguments?: string[];
  arguments?: unknown[];
}

// ── Aptos Events ──────────────────────────────────────────────

export interface TransactionEvent {
  guid: {
    creation_number: string;
    account_address: string;
  };
  sequence_number: string;
  type: string;
  data: Record<string, unknown>;
}

// ── Shelby Blob Discovery ─────────────────────────────────────

/** A Shelby blob commit detected from an Aptos event */
export interface DiscoveredBlob {
  accountAddress: string;
  blobName: string;
  txHash: string;
  blockHeight: string;
  timestamp: string;
}

// ── Job Data ──────────────────────────────────────────────────

/** Job payload pushed to the BullMQ queue */
export interface BlobJobData {
  /** Storage account address on Shelby */
  accountAddress: string;
  /** Blob name / identifier */
  blobName: string;
  /** Aptos transaction hash where the commit was found */
  txHash: string;
  /** Block height where the event was detected */
  blockHeight: string;
  /** Timestamp from the block (microseconds since epoch) */
  timestamp: string;
}

// ── Shelby RPC Types ──────────────────────────────────────────

/** Response from Shelby RPC GET /v1/ — chain/ledger info */
export interface ChainInfo {
  chain_id: number;
  epoch: string;
  ledger_version: string;
  oldest_ledger_version: string;
  ledger_timestamp: string;
  node_role: string;
  oldest_block_height: string;
  block_height: string;
  git_hash: string;
}

/** Basic account info from GET /v1/accounts/{addr} */
export interface AccountInfo {
  sequence_number: string;
  authentication_key: string;
}

/** Account resource from GET /v1/accounts/{addr}/resources */
export interface AccountResource {
  type: string;
  data: Record<string, unknown>;
}
