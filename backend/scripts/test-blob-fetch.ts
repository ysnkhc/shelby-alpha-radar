/**
 * Shelby Indexer — Blob Fetch Test Script
 *
 * Verifies that blobs detected on-chain can be retrieved from the Shelby RPC.
 *
 * Usage:
 *   npx tsx scripts/test-blob-fetch.ts
 *
 * What it does:
 *   1. Tries to load a recent blob from the database (if DB is available)
 *   2. Falls back to real blob data discovered from on-chain events
 *   3. Attempts multiple Shelby RPC URL patterns
 *   4. Retries up to 3 times with delays
 *   5. Logs all results clearly
 */

import "dotenv/config";

// ── Configuration ─────────────────────────────────────────────

const SHELBY_RPC = process.env.SHELBY_RPC_URL ?? "https://api.shelbynet.shelby.xyz";

// Real blobs discovered from on-chain BlobWrittenEvent (shelbynet-discovery.txt)
const KNOWN_BLOBS = [
  {
    owner: "0xcf4df082408b24635e55b4e054cd723582c468e3766cabce92af6396765c34a4",
    blob_name: "@cf4df082408b24635e55b4e054cd723582c468e3766cabce92af6396765c34a4/baodautu (1).png",
  },
  {
    owner: "0x44d0bee68ef59ff0d81e7d0153b835612a9c971acefd2012c3febbeaf7fa2ae8",
    blob_name: "@44d0bee68ef59ff0d81e7d0153b835612a9c971acefd2012c3febbeaf7fa2ae8/in8rki02u7bhh19x.csv",
  },
  {
    owner: "0xa9e0ffcc52a5696535d8c38be18071a5d2a7499f9e24e59d1f6f0e0a75d93fbe",
    blob_name: "@a9e0ffcc52a5696535d8c38be18071a5d2a7499f9e24e59d1f6f0e0a75d93fbe/oqfe23wzmmbavflf.txt",
  },
];

// ── Helpers ───────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function banner(text: string): void {
  const line = "═".repeat(60);
  console.log(`\n${line}\n  ${text}\n${line}`);
}

// ── Step 1: Load blob from DB (if available) ─────────────────

async function loadBlobFromDB(): Promise<{ owner: string; blob_name: string } | null> {
  try {
    // Dynamic import so script doesn't crash if DB is offline
    const { PrismaClient } = await import("@prisma/client");
    const prisma = new PrismaClient({ log: ["warn", "error"] });

    const blob = await prisma.blob.findFirst({
      orderBy: { createdAt: "desc" },
      select: { wallet: true, blobId: true },
    });

    await prisma.$disconnect();

    if (blob) {
      // blobId format is "owner:blobName"
      const parts = blob.blobId.split(":");
      const blobName = parts.slice(1).join(":");
      return { owner: blob.wallet, blob_name: blobName };
    }

    return null;
  } catch (error) {
    console.log(
      "  ⚠️  DB not available:",
      error instanceof Error ? error.message.split("\n")[0] : error
    );
    return null;
  }
}

// ── Step 2: Build candidate URLs ─────────────────────────────

function buildCandidateUrls(owner: string, blobName: string): string[] {
  const cleanOwner = owner.startsWith("0x") ? owner.slice(2) : owner;
  const fullOwner = `0x${cleanOwner}`;

  // Extract the path part after @address/
  const pathOnly = blobName.startsWith("@")
    ? blobName.replace(/^@[^/]+\//, "")
    : blobName;

  return [
    // Pattern 1: /shelby/v1/blobs/{owner}/{path}
    `${SHELBY_RPC}/shelby/v1/blobs/${fullOwner}/${encodeURIComponent(pathOnly)}`,

    // Pattern 2: /shelby/v1/blobs with full blob_name
    `${SHELBY_RPC}/shelby/v1/blobs/${encodeURIComponent(blobName)}`,

    // Pattern 3: query string approach
    `${SHELBY_RPC}/shelby/v1/blob?owner=${encodeURIComponent(fullOwner)}&name=${encodeURIComponent(pathOnly)}`,

    // Pattern 4: using the full blob_name as path (with @)
    `${SHELBY_RPC}/shelby/v1/blobs/${encodeURIComponent(fullOwner)}/${encodeURIComponent(blobName)}`,

    // Pattern 5: direct read endpoint
    `${SHELBY_RPC}/shelby/v1/read/${encodeURIComponent(blobName)}`,
  ];
}

// ── Step 3: Attempt fetch with retries ───────────────────────

interface FetchResult {
  url: string;
  status: number;
  contentType: string | null;
  size: number;
  body: string;
  success: boolean;
}

async function tryFetchBlob(url: string, maxRetries = 3): Promise<FetchResult> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15_000);

      const response = await fetch(url, {
        method: "GET",
        headers: { Accept: "application/json, application/octet-stream, */*" },
        signal: controller.signal,
      });

      clearTimeout(timer);

      const contentType = response.headers.get("content-type");
      const bodyBuffer = await response.arrayBuffer();
      const bodyText = new TextDecoder().decode(bodyBuffer).slice(0, 1000);

      return {
        url,
        status: response.status,
        contentType,
        size: bodyBuffer.byteLength,
        body: bodyText,
        success: response.ok,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.log(`    ⚡ Attempt ${attempt}/${maxRetries} failed: ${msg}`);

      if (attempt < maxRetries) {
        const delay = attempt * 2000;
        console.log(`    ⏳ Waiting ${delay}ms before retry...`);
        await sleep(delay);
      } else {
        return {
          url,
          status: 0,
          contentType: null,
          size: 0,
          body: `Error after ${maxRetries} attempts: ${msg}`,
          success: false,
        };
      }
    }
  }

  // Unreachable, but TypeScript wants it
  return { url, status: 0, contentType: null, size: 0, body: "unreachable", success: false };
}

// ── Main ─────────────────────────────────────────────────────

async function main(): Promise<void> {
  banner("Shelby Indexer — Blob Fetch Test");
  console.log(`  RPC: ${SHELBY_RPC}`);

  // Step 1: Get a blob to test
  console.log("\n📋 Step 1: Loading blob data...");

  let testBlob: { owner: string; blob_name: string };

  console.log("  Trying database...");
  const dbBlob = await loadBlobFromDB();

  if (dbBlob) {
    testBlob = dbBlob;
    console.log("  ✅ Loaded from database");
  } else {
    testBlob = KNOWN_BLOBS[0];
    console.log("  📦 Using known blob from discovery output");
  }

  console.log(`\n  Owner:     ${testBlob.owner}`);
  console.log(`  Blob name: ${testBlob.blob_name}`);

  // Step 2: Build candidate URLs
  const urls = buildCandidateUrls(testBlob.owner, testBlob.blob_name);

  banner("Testing URL Patterns");

  const results: FetchResult[] = [];

  for (let i = 0; i < urls.length; i++) {
    console.log(`\n🔗 Pattern ${i + 1}/${urls.length}:`);
    console.log(`   ${urls[i]}`);

    const result = await tryFetchBlob(urls[i], 1); // 1 attempt per pattern first
    results.push(result);

    if (result.success) {
      console.log(`   ✅ SUCCESS — ${result.status}`);
      console.log(`   Content-Type: ${result.contentType}`);
      console.log(`   Size: ${result.size} bytes`);
      console.log(`   Body preview: ${result.body.slice(0, 200)}`);
    } else if (result.status === 404) {
      console.log(`   ❌ 404 Not Found`);
    } else if (result.status > 0) {
      console.log(`   ⚠️  HTTP ${result.status}`);
      console.log(`   Body: ${result.body.slice(0, 200)}`);
    } else {
      console.log(`   💥 Request failed: ${result.body.slice(0, 200)}`);
    }
  }

  // Step 3: Retry the best candidate
  const successResult = results.find((r) => r.success);
  const nonErrorResult = results.find((r) => r.status > 0 && r.status !== 404);

  if (successResult) {
    banner("✅ BLOB RETRIEVAL SUCCESSFUL");
    console.log(`  URL:          ${successResult.url}`);
    console.log(`  Status:       ${successResult.status}`);
    console.log(`  Content-Type: ${successResult.contentType}`);
    console.log(`  Size:         ${successResult.size} bytes`);
    console.log(`\n  Body preview:\n  ${successResult.body.slice(0, 500)}`);
  } else {
    // Retry the best non-404 candidate with full retries
    const retryTarget = nonErrorResult ?? results[0];

    banner("Retrying Best Candidate (3 attempts)");
    console.log(`  URL: ${retryTarget.url}`);

    const retryResult = await tryFetchBlob(retryTarget.url, 3);

    if (retryResult.success) {
      console.log(`\n  ✅ Success on retry!`);
      console.log(`  Status:       ${retryResult.status}`);
      console.log(`  Content-Type: ${retryResult.contentType}`);
      console.log(`  Size:         ${retryResult.size} bytes`);
    } else {
      banner("❌ ALL PATTERNS FAILED");
      console.log("\n  Summary of all attempts:\n");
      for (const r of results) {
        const statusLabel = r.status === 0 ? "ERR" : String(r.status);
        console.log(`    [${statusLabel}] ${r.url}`);
      }
      console.log(`\n  This likely means:`);
      console.log(`    • The Shelby RPC blob endpoint uses a different URL pattern`);
      console.log(`    • The blob has been wiped (shelbynet resets weekly)`);
      console.log(`    • The RPC requires authentication or SDK access`);
      console.log(`\n  Next step: check Shelby CLI/SDK docs for the correct blob read API`);
    }
  }

  // Step 4: Also test some known API discovery endpoints
  banner("API Discovery — Testing Other Endpoints");

  const discoveryUrls = [
    `${SHELBY_RPC}/shelby/v1`,
    `${SHELBY_RPC}/shelby/v1/health`,
    `${SHELBY_RPC}/shelby`,
    `${SHELBY_RPC}/v1`,
  ];

  for (const url of discoveryUrls) {
    try {
      const resp = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(5000),
      });
      const body = await resp.text();
      console.log(`  [${resp.status}] ${url}`);
      if (resp.ok) {
        console.log(`        ${body.slice(0, 200)}`);
      }
    } catch (e) {
      console.log(`  [ERR] ${url} — ${e instanceof Error ? e.message : e}`);
    }
  }

  banner("Test Complete");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
