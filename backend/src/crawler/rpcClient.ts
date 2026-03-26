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
   * Fetch blob info (metadata only — no content).
   */
  async fetchBlobInfo(
    owner: string,
    blobName: string
  ): Promise<ShelbyBlobInfo | null> {
    const result = await this.fetchBlobContent(owner, blobName);
    if (!result) return null;
    return {
      owner: result.owner,
      blobName: result.blobName,
      size: result.size,
      contentType: result.contentType,
    };
  }

  /**
   * Fetch blob content from the Shelby RPC.
   *
   * Only fetches content for text-based files under 300KB.
   * Returns the raw buffer + metadata for content analysis.
   *
   * @param owner - Owner address (hex with 0x prefix)
   * @param blobName - Full blob name from on-chain event
   * @param maxSizeBytes - Max content size to download (default 300KB)
   * @returns Blob content + metadata if found, null otherwise
   */
  async fetchBlobContent(
    owner: string,
    blobName: string,
    maxSizeBytes = 300 * 1024
  ): Promise<ShelbyBlobContent | null> {
    const cleanOwner = owner.startsWith("0x") ? owner : `0x${owner}`;

    // Extract the file path part (remove @address/ prefix if present)
    const blobPath = blobName.startsWith("@")
      ? blobName.replace(/^@[^/]+\//, "")
      : blobName;

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
        if (response.status === 404) return null;
        const body = await response.text().catch(() => "");
        throw new RpcError(
          `RPC ${response.status} ${response.statusText}: ${url}`,
          response.status,
          body
        );
      }

      const contentType = response.headers.get("content-type") ?? undefined;
      const contentLength = response.headers.get("content-length");
      const declaredSize = contentLength ? Number(contentLength) : undefined;

      // Skip content download if too large
      if (declaredSize && declaredSize > maxSizeBytes) {
        return {
          owner: cleanOwner,
          blobName,
          size: declaredSize,
          contentType,
          buffer: null, // Too large — metadata only
        };
      }

      const bodyBuffer = await response.arrayBuffer();
      const size = declaredSize ?? bodyBuffer.byteLength;

      // Return buffer only if within size limit
      const buffer = bodyBuffer.byteLength <= maxSizeBytes
        ? Buffer.from(bodyBuffer)
        : null;

      return {
        owner: cleanOwner,
        blobName,
        size,
        contentType,
        buffer,
      };
    } catch (error) {
      if (error instanceof RpcError) throw error;
      const message = error instanceof Error ? error.message : "Unknown RPC error";
      throw new RpcError(`RPC request to ${url} failed: ${message}`, 0);
    } finally {
      clearTimeout(timer);
    }
  }

  // ── Health ─────────────────────────────────────────────────

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
 * Blob info (metadata only).
 */
export interface ShelbyBlobInfo {
  owner: string;
  blobName: string;
  size?: number;
  contentType?: string;
}

/**
 * Blob content + metadata.
 */
export interface ShelbyBlobContent {
  owner: string;
  blobName: string;
  size: number;
  contentType?: string;
  /** Raw content buffer. null if file was too large or binary. */
  buffer: Buffer | null;
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
