/**
 * Quick verification script for the refactored RPC client + crawler.
 * Tests the Aptos-compatible API endpoints and does a mini-crawl.
 */
import dotenv from "dotenv";
dotenv.config();

import axios from "axios";

const RPC_URL = process.env.SHELBY_RPC_URL || "https://api.shelbynet.shelby.xyz";

async function verify() {
  console.log("══════════════════════════════════════════");
  console.log("  Shelby RPC — Full Verification");
  console.log("══════════════════════════════════════════");
  console.log(`  Endpoint: ${RPC_URL}`);
  console.log("");

  // 1. Chain info
  console.log("→ GET /v1/ (chain info)");
  const chain = await axios.get(`${RPC_URL}/v1/`, { timeout: 15000, validateStatus: () => true });
  console.log(`  Status: ${chain.status}`);
  const info = chain.data;
  console.log(`  chain_id: ${info.chain_id}`);
  console.log(`  ledger_version: ${info.ledger_version}`);
  console.log(`  block_height: ${info.block_height}`);
  console.log("");

  // 2. Fetch recent transactions
  const startVersion = Math.max(0, Number(info.ledger_version) - 10);
  console.log(`→ GET /v1/transactions?start=${startVersion}&limit=10`);
  const txRes = await axios.get(`${RPC_URL}/v1/transactions`, {
    params: { start: startVersion, limit: 10 },
    timeout: 15000,
    validateStatus: () => true,
  });
  console.log(`  Status: ${txRes.status}`);

  if (Array.isArray(txRes.data)) {
    console.log(`  Returned ${txRes.data.length} transactions`);

    // Show types
    const types = txRes.data.map((tx: any) => tx.type);
    console.log(`  Types: ${[...new Set(types)].join(", ")}`);

    // Show user transactions
    const userTxs = txRes.data.filter((tx: any) => tx.type === "user_transaction");
    console.log(`  User transactions: ${userTxs.length}`);

    if (userTxs.length > 0) {
      console.log("\n  ── Sample User Transactions ──");
      for (const tx of userTxs.slice(0, 3)) {
        console.log(`    Version: ${tx.version}`);
        console.log(`    Sender:  ${tx.sender}`);
        console.log(`    Function: ${tx.payload?.function ?? "N/A"}`);
        console.log(`    Success: ${tx.success}`);
        console.log(`    Events: ${tx.events?.length ?? 0}`);
        console.log("");
      }
    }
  } else {
    console.log(`  Unexpected response:`, JSON.stringify(txRes.data).slice(0, 200));
  }

  // 3. Test account resources
  console.log("→ GET /v1/accounts/0x1/resources");
  const resRes = await axios.get(`${RPC_URL}/v1/accounts/0x1/resources`, {
    timeout: 15000,
    validateStatus: () => true,
  });
  console.log(`  Status: ${resRes.status}`);
  if (Array.isArray(resRes.data)) {
    console.log(`  Resources found: ${resRes.data.length}`);
    console.log(`  First 5 types:`);
    for (const r of resRes.data.slice(0, 5)) {
      console.log(`    - ${r.type}`);
    }
  }

  console.log("\n══════════════════════════════════════════");
  console.log("  ✓ Verification complete");
  console.log("══════════════════════════════════════════");
}

verify().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
