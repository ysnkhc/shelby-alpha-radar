import { env } from "../config/env.js";

/**
 * Shelby RPC Client
 *
 * Communicates with the Shelby storage RPC to retrieve blob data.
 * The Shelby RPC base URL (SHELBY_RPC_URL) points to the storage gateway,
 * NOT the Aptos fullnode (which is APTOS_RPC_URL).
 *
 * Confirmed working endpoint pattern (tested 2026-03-21):
 *   GET /shelby/v1/blobs/{owner}/{blobPath}
 *   → Returns raw blob content as application/octet-stream
 *
 * Uses the native `fetch` API (Node 18+).
 */
export class ShelbyRpcClient {
  private readonly baseUrl: string;
  private readonly timeout: number;

  constructor(baseUrl?: string, timeoutMs = 15_000) {
    this.baseUrl = (baseUrl ?? env.SHELBY_RPC_URL).replace(/\/+$/, "");
    this.timeout = timeoutMs;
  }

  // ── Blob Retrieval ─────────────────────────────────────────

  /**
   * Fetch blob content from the Shelby RPC.
   *
   * Confirmed URL pattern:
   *   GET /shelby/v1/blobs/{owner}/{blobPath}
   *
   * The blob_name from on-chain events has the format:
   *   @{ownerHex}/{filename}
   *
   * We extract the path part after `@{address}/` and use it as blobPath.
   *
   * @returns Blob info (size, content type) if found, null otherwise
   */
  async fetchBlobInfo(
    owner: string,
    blobName: string
  ): Promise<ShelbyBlobInfo | null> {
    // Ensure owner has 0x prefix
    const cleanOwner = owner.startsWith("0x") ? owner : `0x${owner}`;

    // Extract the file path part (remove @address/ prefix if present)
    const blobPath = blobName.startsWith("@")
      ? blobName.replace(/^@[^/]+\//, "")
      : blobName;

    // Confirmed working pattern: /shelby/v1/blobs/{owner}/{blobPath}
    const url = `${this.baseUrl}/shelby/v1/blobs/${cleanOwner}/${encodeURIComponent(blobPath)}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url, {
        method: "GET",
        headers: { Accept: "application/octet-stream, application/json, */*" },
        signal: controller.signal,
      });

      if (!response.ok) {
        if (response.status === 404) {
          // Blob not found — may not be propagated yet
          return null;
        }
        const body = await response.text().catch(() => "");
        throw new RpcError(
          `RPC ${response.status} ${response.statusText}: ${url}`,
          response.status,
          body
        );
      }

      const contentType = response.headers.get("content-type") ?? undefined;
      const contentLength = response.headers.get("content-length");

      // We do a HEAD-like approach: read the body to get size but don't store it
      const bodyBuffer = await response.arrayBuffer();
      const size = contentLength ? Number(contentLength) : bodyBuffer.byteLength;

      return {
        owner: cleanOwner,
        blobName,
        size,
        contentType,
      };
    } catch (error) {
      if (error instanceof RpcError) throw error;

      const message =
        error instanceof Error ? error.message : "Unknown RPC error";
      throw new RpcError(`RPC request to ${url} failed: ${message}`, 0);
    } finally {
      clearTimeout(timer);
    }
  }

  // ── Health ─────────────────────────────────────────────────

  /** Simple connectivity check — tests the Aptos fullnode endpoint */
  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/v1`, {
        signal: AbortSignal.timeout(5_000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}

/**
 * Blob info returned from the Shelby RPC.
 */
export interface ShelbyBlobInfo {
  owner: string;
  blobName: string;
  size?: number;
  contentType?: string;
}

/**
 * Custom error class for RPC failures.
 */
export class RpcError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly responseBody?: string
  ) {
    super(message);
    this.name = "RpcError";
  }
}
