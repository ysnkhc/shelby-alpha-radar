import type { BlobJobData } from "../types.js";

/**
 * Extracted metadata from a blob event.
 */
export interface ExtractedMetadata {
  title: string | null;
  description: string | null;
  tags: string[];
  fileType: string | null;
}

/**
 * Metadata Extractor
 *
 * Derives structured metadata from a blob job payload.
 * V1 uses the blob name and account address.
 * Future versions will fetch actual blob content from Shelby RPC
 * and perform deeper analysis.
 */
export function extractMetadata(data: BlobJobData): ExtractedMetadata {
  const title = deriveTitle(data);
  const description = deriveDescription(data);
  const tags = deriveTags(data);
  const fileType = detectFileType(data);

  return { title, description, tags, fileType };
}

// ── Internal helpers ───────────────────────────────────────────

function deriveTitle(data: BlobJobData): string | null {
  if (!data.blobName || data.blobName.startsWith("unknown-")) return null;

  // Clean up blob name: remove extension, replace separators
  return data.blobName
    .replace(/\.[^.]+$/, "")
    .replace(/[-_]+/g, " ")
    .trim() || null;
}

function deriveDescription(data: BlobJobData): string | null {
  const parts: string[] = [];

  parts.push(`Blob: ${data.blobName}`);
  parts.push(`Account: ${data.accountAddress.slice(0, 12)}...`);
  parts.push(`Block: ${data.blockHeight}`);
  parts.push(`Tx: ${data.txHash.slice(0, 16)}...`);

  return parts.join(" | ");
}

function deriveTags(data: BlobJobData): string[] {
  const tags: string[] = [];

  // Tag with blob name parts
  if (data.blobName && !data.blobName.startsWith("unknown-")) {
    // If blob name has an extension, tag it
    const ext = data.blobName.split(".").pop()?.toLowerCase();
    if (ext && ext !== data.blobName.toLowerCase()) {
      tags.push(ext);
    }
  }

  // Tag with account prefix
  if (data.accountAddress) {
    tags.push(`account:${data.accountAddress.slice(0, 10)}`);
  }

  return [...new Set(tags)];
}

function detectFileType(data: BlobJobData): string | null {
  if (!data.blobName) return null;

  const ext = data.blobName.split(".").pop()?.toLowerCase();
  if (ext && ext !== data.blobName.toLowerCase()) {
    return ext;
  }

  return null;
}
