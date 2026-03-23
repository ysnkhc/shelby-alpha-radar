import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const RPC_URL = (
  process.env.SHELBY_RPC_URL || "https://api.shelbynet.shelby.xyz"
).replace(/\/+$/, "");

const CANDIDATE_ROUTES = [
  "/v1/",
  "/v1/accounts",
  "/v1/accounts/0x1",
  "/v1/transactions",
  "/v1/events",
  "/v1/resources",
  "/v1/objects",
  "/v1/tables",
  "/v1/blobs",
  "/v1/storage",
  "/v1/data",
  "/v1/files",
];

interface RouteResult {
  route: string;
  status: number;
  isJson: boolean;
  snippet: string;
}

async function discoverRoutes() {
  console.log("══════════════════════════════════════════");
  console.log("  Shelby RPC — Route Discovery");
  console.log("══════════════════════════════════════════");
  console.log(`  Base: ${RPC_URL}`);
  console.log(`  Routes to probe: ${CANDIDATE_ROUTES.length}`);
  console.log("");

  const results: RouteResult[] = [];

  for (const route of CANDIDATE_ROUTES) {
    const url = `${RPC_URL}${route}`;
    process.stdout.write(`→ ${route.padEnd(25)}`);

    try {
      const res = await axios.get(url, {
        timeout: 15_000,
        // Accept any status so axios doesn't throw on 4xx
        validateStatus: () => true,
      });

      const contentType = res.headers["content-type"] || "";
      const isJson = contentType.includes("application/json");
      const body =
        typeof res.data === "object"
          ? JSON.stringify(res.data, null, 2)
          : String(res.data);
      const snippet = body.slice(0, 400);

      results.push({ route, status: res.status, isJson, snippet });

      const tag = res.status >= 200 && res.status < 300 ? "✓" : "✗";
      console.log(
        `${tag}  ${res.status}  json=${isJson}  ${snippet.split("\n")[0].slice(0, 80)}`
      );
    } catch (err: any) {
      console.log(`✗  ERR  ${err.message.slice(0, 80)}`);
      results.push({
        route,
        status: 0,
        isJson: false,
        snippet: err.message,
      });
    }
  }

  // ── Summary ──────────────────────────────────────────────
  console.log("");
  console.log("══════════════════════════════════════════");
  console.log("  Summary — Valid Endpoints");
  console.log("══════════════════════════════════════════");

  const valid = results.filter((r) => r.status >= 200 && r.status < 300);
  const jsonResponses = results.filter((r) => r.isJson);

  if (valid.length === 0 && jsonResponses.length === 0) {
    console.log("  No HTTP 200 or structured JSON routes found.");
    console.log("  The /v1 prefix is routed but needs correct sub-paths.");
  }

  if (valid.length > 0) {
    console.log("\n  HTTP 200 routes:");
    for (const r of valid) {
      console.log(`    ${r.route}  (json=${r.isJson})`);
    }
  }

  if (jsonResponses.length > 0) {
    console.log("\n  Routes returning JSON (any status):");
    for (const r of jsonResponses) {
      console.log(`    ${r.route}  → ${r.status}`);
    }
  }

  // ── Full detail for interesting routes ───────────────────
  const interesting = results.filter(
    (r) => (r.status >= 200 && r.status < 300) || r.isJson
  );
  if (interesting.length > 0) {
    console.log("\n══════════════════════════════════════════");
    console.log("  Full Responses — Interesting Routes");
    console.log("══════════════════════════════════════════");
    for (const r of interesting) {
      console.log(`\n  ── ${r.route} (${r.status}) ──`);
      console.log(r.snippet);
    }
  }

  console.log("\n══════════════════════════════════════════");
  console.log("  Discovery complete");
  console.log("══════════════════════════════════════════");
}

discoverRoutes();
