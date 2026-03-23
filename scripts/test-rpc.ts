import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const RPC_URL = process.env.SHELBY_RPC_URL || "https://api.shelbynet.shelby.xyz";

async function testRPC() {
  console.log("──────────────────────────────────────");
  console.log("  Shelby RPC Connectivity Test");
  console.log("──────────────────────────────────────");
  console.log(`  Endpoint: ${RPC_URL}`);
  console.log("");

  try {
    // 1. Test base route
    console.log("→ Testing base route...");
    const baseRes = await axios.get(RPC_URL, { timeout: 15_000 });
    console.log(`  Status: ${baseRes.status} ${baseRes.statusText}`);
    console.log(`  Response:`, JSON.stringify(baseRes.data, null, 2));
  } catch (err: any) {
    if (err.response) {
      // Server responded with a non-2xx status — connectivity is still confirmed
      console.log(`  Status: ${err.response.status} ${err.response.statusText}`);
      console.log(`  Response:`, JSON.stringify(err.response.data, null, 2));
      console.log("  ⚠ Non-2xx response, but connectivity confirmed.");
    } else {
      console.error("  ✗ Connection failed:", err.message);
      process.exit(1);
    }
  }

  console.log("");

  // 2. Probe common API routes
  const routes = ["/shelby/v1", "/shelby/v1/blobs", "/v1/blobs"];

  for (const route of routes) {
    try {
      console.log(`→ Probing ${route} ...`);
      const res = await axios.get(`${RPC_URL}${route}`, { timeout: 15_000 });
      console.log(`  Status: ${res.status} — ${typeof res.data === "object" ? JSON.stringify(res.data, null, 2).slice(0, 500) : res.data}`);
    } catch (err: any) {
      if (err.response) {
        console.log(`  Status: ${err.response.status} — ${JSON.stringify(err.response.data ?? "").slice(0, 300)}`);
      } else {
        console.log(`  ✗ Unreachable: ${err.message}`);
      }
    }
  }

  console.log("");
  console.log("──────────────────────────────────────");
  console.log("  ✓ RPC connectivity test complete");
  console.log("──────────────────────────────────────");
}

testRPC();
