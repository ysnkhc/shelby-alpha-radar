import { prisma } from "../database/db.js";

/**
 * Dataset Builder — V1
 *
 * Transforms a Project's blobs into structured, typed rows with inferred schema.
 * Does NOT modify any existing project/blob data.
 */

// ── Types ─────────────────────────────────────────────────────

export interface DatasetSchema {
  fields: Record<string, "string" | "number" | "boolean" | "object" | "array" | "null">;
}

export interface BuildResult {
  rows: Record<string, unknown>[];
  schema: DatasetSchema;
  blobIds: string[];
  rowCount: number;
}

// ── Main Entry ────────────────────────────────────────────────

/**
 * Build a structured dataset from a project's blobs.
 *
 * Steps:
 *   1. Fetch all blobs for projectId (limit 200)
 *   2. Filter usable blobs (must have metadata + contentPreview or structured type)
 *   3. Extract rows from JSON/CSV/text content
 *   4. Infer schema from all rows
 *   5. Normalize rows (fill missing keys with null)
 */
export async function buildDatasetFromProject(
  projectId: string,
  _type?: string
): Promise<BuildResult> {
  console.log(`[DatasetBuilder] Starting build for project: ${projectId}`);

  // 1. Fetch blobs
  const blobs = await prisma.blob.findMany({
    where: { projectId },
    include: { metadata: true },
    orderBy: { createdAt: "asc" },
    take: 200,
  });

  console.log(`[DatasetBuilder] Fetched ${blobs.length} blobs`);

  // 2. Filter usable blobs
  const usable = blobs.filter(b => {
    if (!b.metadata) return false;
    const ft = b.metadata.fileType;
    const hasPreview = !!b.metadata.contentPreview;
    const isStructured = ft === "json" || ft === "csv";
    return hasPreview || isStructured;
  });

  console.log(`[DatasetBuilder] ${usable.length} usable blobs (of ${blobs.length} total)`);

  // 3. Extract rows
  const allRows: Record<string, unknown>[] = [];
  const blobIds: string[] = [];

  for (const blob of usable) {
    const preview = blob.metadata?.contentPreview ?? null;
    const fileType = blob.metadata?.fileType ?? null;
    if (!preview) continue;

    const rows = extractRows(preview, fileType);
    if (rows.length > 0) {
      blobIds.push(blob.blobId);
      allRows.push(...rows);
    }
  }

  console.log(`[DatasetBuilder] Extracted ${allRows.length} rows from ${blobIds.length} blobs`);

  // 4. Infer schema
  const schema = inferSchema(allRows);
  console.log(`[DatasetBuilder] Schema: ${JSON.stringify(schema)}`);

  // 5. Normalize rows
  const normalizedRows = normalizeRows(allRows, schema);

  return {
    rows: normalizedRows,
    schema,
    blobIds,
    rowCount: normalizedRows.length,
  };
}

// ── Row Extraction ────────────────────────────────────────────

function extractRows(content: string, fileType: string | null): Record<string, unknown>[] {
  const text = content.trim();
  if (!text) return [];

  // JSON
  if (fileType === "json" || text.startsWith("{") || text.startsWith("[")) {
    return extractJsonRows(text);
  }

  // CSV
  if (fileType === "csv" || (text.includes(",") && text.includes("\n"))) {
    return extractCsvRows(text);
  }

  // Text — treat as single row with text field
  if (text.length > 0) {
    return [{ text: text.slice(0, 1000) }];
  }

  return [];
}

function extractJsonRows(text: string): Record<string, unknown>[] {
  try {
    const parsed = JSON.parse(text);

    if (Array.isArray(parsed)) {
      // Array of objects → each item = row
      return parsed
        .filter(item => typeof item === "object" && item !== null && !Array.isArray(item))
        .map(item => item as Record<string, unknown>);
    }

    if (typeof parsed === "object" && parsed !== null) {
      // Single object → single row
      return [parsed as Record<string, unknown>];
    }
  } catch {
    // Invalid JSON
  }
  return [];
}

function extractCsvRows(text: string): Record<string, unknown>[] {
  const lines = text.split("\n").filter(l => l.trim());
  if (lines.length < 2) return [];

  const headers = lines[0].split(",").map(h => h.trim().replace(/^"|"$/g, ""));
  const rows: Record<string, unknown>[] = [];

  for (let i = 1; i < lines.length; i++) {
    const vals = lines[i].split(",").map(v => v.trim().replace(/^"|"$/g, ""));
    const row: Record<string, unknown> = {};
    for (let j = 0; j < headers.length; j++) {
      const val = vals[j] ?? "";
      // Try to parse numbers
      const num = Number(val);
      if (val !== "" && !isNaN(num)) {
        row[headers[j]] = num;
      } else if (val === "true" || val === "false") {
        row[headers[j]] = val === "true";
      } else {
        row[headers[j]] = val;
      }
    }
    rows.push(row);
  }

  return rows;
}

// ── Schema Inference ──────────────────────────────────────────

function inferSchema(rows: Record<string, unknown>[]): DatasetSchema {
  const fields: Record<string, "string" | "number" | "boolean" | "object" | "array" | "null"> = {};

  for (const row of rows) {
    for (const [key, value] of Object.entries(row)) {
      if (key in fields) continue; // keep first inferred type

      if (value === null || value === undefined) {
        fields[key] = "null";
      } else if (Array.isArray(value)) {
        fields[key] = "array";
      } else if (typeof value === "number") {
        fields[key] = "number";
      } else if (typeof value === "boolean") {
        fields[key] = "boolean";
      } else if (typeof value === "object") {
        fields[key] = "object";
      } else {
        fields[key] = "string";
      }
    }
  }

  return { fields };
}

// ── Row Normalization ─────────────────────────────────────────

function normalizeRows(rows: Record<string, unknown>[], schema: DatasetSchema): Record<string, unknown>[] {
  const allKeys = Object.keys(schema.fields);

  return rows.map(row => {
    const normalized: Record<string, unknown> = {};
    for (const key of allKeys) {
      normalized[key] = key in row ? row[key] : null;
    }
    return normalized;
  });
}
