/**
 * Content Analyzer — Blob Intelligence Layer
 *
 * Analyzes blob content to extract structured intelligence:
 *  - Tags:    dataset, config, logs, media, ai_data
 *  - Signals: ai_interaction, model_data, trading_data, agent_config
 *  - Preview: cleaned first ~500 chars of text content
 *
 * Only processes text-based content (JSON, CSV, text).
 * Binary/image files get tags from filename patterns only.
 */

// ── Public Types ──────────────────────────────────────────────

export interface ContentAnalysis {
  tags: string[];
  signals: string[];
  contentPreview: string | null;
  analysisStatus: "analyzed" | "skipped" | "error";
  detectedType: string | null;
}

// ── Main Entry Point ──────────────────────────────────────────

/**
 * Analyze blob content and filename to extract intelligence.
 *
 * @param blobName - Full blob name from on-chain event
 * @param buffer   - Content buffer (null if too large / binary / unavailable)
 * @param contentType - MIME type from RPC response headers
 */
export function analyzeContent(
  blobName: string,
  buffer: Buffer | null,
  contentType?: string
): ContentAnalysis {
  const tags = new Set<string>();
  const signals = new Set<string>();
  let contentPreview: string | null = null;
  let analysisStatus: ContentAnalysis["analysisStatus"] = "skipped";
  const detectedType = detectFileType(blobName, contentType);

  try {
    // ── Filename-based intelligence (always runs) ──────────────
    analyzeFilename(blobName, tags, signals);

    // ── Content-based intelligence (only for text + buffer) ────
    if (buffer && isTextType(detectedType)) {
      const text = buffer.toString("utf-8").trim();

      if (text.length > 0) {
        if (detectedType === "json") {
          analyzeJson(text, tags, signals);
        } else if (detectedType === "csv") {
          analyzeCsv(text, tags, signals);
        } else {
          analyzeText(text, tags, signals);
        }

        // Generate cleaned preview (first 500 chars)
        contentPreview = generatePreview(text, detectedType);
        analysisStatus = "analyzed";
      }
    } else if (!isTextType(detectedType)) {
      // Binary/image — tag from extension only
      analysisStatus = "skipped";
    } else {
      analysisStatus = "skipped";
    }
  } catch {
    analysisStatus = "error";
  }

  // Always add file type as a tag
  if (detectedType) {
    tags.add(detectedType);
  }

  return {
    tags: [...tags],
    signals: [...signals],
    contentPreview,
    analysisStatus,
    detectedType,
  };
}

// ── File Type Detection ───────────────────────────────────────

const TEXT_TYPES = new Set(["json", "csv", "txt", "md", "yaml", "yml", "toml", "xml", "html", "log"]);

function detectFileType(blobName: string, contentType?: string): string | null {
  // 1. Try extension
  const ext = blobName.split(".").pop()?.toLowerCase();
  if (ext && ext !== blobName.toLowerCase() && ext.length <= 10) {
    return ext;
  }

  // 2. Try content-type header
  if (contentType) {
    if (contentType.includes("json")) return "json";
    if (contentType.includes("csv")) return "csv";
    if (contentType.includes("text")) return "txt";
    if (contentType.includes("image")) return "image";
  }

  return null;
}

function isTextType(type: string | null): boolean {
  return type !== null && TEXT_TYPES.has(type);
}

// ── Filename Pattern Analysis ─────────────────────────────────

const FILENAME_PATTERNS: Array<{ pattern: RegExp; tags: string[]; signals: string[] }> = [
  // AI / ML
  { pattern: /model|weights|checkpoint|neural|transformer|llm|gpt|bert/i, tags: ["ai_data"], signals: ["model_data"] },
  { pattern: /agent|autogpt|langchain|crew|swarm/i, tags: ["ai_data"], signals: ["agent_config"] },
  { pattern: /prompt|instruction|system.?message/i, tags: ["ai_data"], signals: ["ai_interaction"] },
  { pattern: /training|finetune|dataset|corpus|embed/i, tags: ["dataset", "ai_data"], signals: ["model_data"] },

  // Trading / Finance
  { pattern: /trade|swap|order|position|portfolio|hedge/i, tags: ["config"], signals: ["trading_data"] },
  { pattern: /price|candle|ohlc|ticker|market/i, tags: ["dataset"], signals: ["trading_data"] },
  { pattern: /defi|yield|liquidity|amm|dex/i, tags: ["config"], signals: ["trading_data"] },

  // Infrastructure
  { pattern: /config|settings|\.env|params/i, tags: ["config"], signals: [] },
  { pattern: /deploy|manifest|docker|k8s|terraform/i, tags: ["config"], signals: ["agent_config"] },
  { pattern: /log|audit|trace|debug/i, tags: ["logs"], signals: [] },

  // Data
  { pattern: /data|export|dump|backup|snapshot/i, tags: ["dataset"], signals: [] },
  { pattern: /report|analytics|metrics|stats/i, tags: ["dataset"], signals: [] },

  // Media
  { pattern: /\.(jpg|jpeg|png|gif|webp|svg|bmp|ico)$/i, tags: ["media"], signals: [] },
  { pattern: /\.(mp4|mp3|wav|webm|ogg|avi)$/i, tags: ["media"], signals: [] },
  { pattern: /\.(pdf|doc|docx|ppt|pptx)$/i, tags: ["media"], signals: [] },
];

function analyzeFilename(blobName: string, tags: Set<string>, signals: Set<string>): void {
  // Extract just the filename part
  const filename = blobName.includes("/")
    ? blobName.split("/").pop() ?? blobName
    : blobName;

  for (const rule of FILENAME_PATTERNS) {
    if (rule.pattern.test(filename)) {
      rule.tags.forEach((t) => tags.add(t));
      rule.signals.forEach((s) => signals.add(s));
    }
  }
}

// ── JSON Analysis ─────────────────────────────────────────────

const AI_JSON_KEYS = new Set([
  "model", "prompt", "messages", "system_prompt", "temperature",
  "max_tokens", "top_p", "completion", "embedding", "agent",
  "tools", "functions", "chain", "memory", "llm", "weights",
  "layers", "neurons", "epochs", "learning_rate", "loss",
]);

const TRADING_JSON_KEYS = new Set([
  "price", "amount", "side", "pair", "symbol", "exchange",
  "bid", "ask", "volume", "open", "high", "low", "close",
  "strategy", "position", "leverage", "stop_loss", "take_profit",
]);

const CONFIG_JSON_KEYS = new Set([
  "name", "version", "description", "dependencies", "scripts",
  "config", "settings", "env", "database", "api_key", "endpoint",
]);

function analyzeJson(text: string, tags: Set<string>, signals: Set<string>): void {
  try {
    const parsed = JSON.parse(text);
    const keys = extractJsonKeys(parsed, 3);

    let aiScore = 0;
    let tradingScore = 0;
    let configScore = 0;

    for (const key of keys) {
      const k = key.toLowerCase();
      if (AI_JSON_KEYS.has(k)) aiScore++;
      if (TRADING_JSON_KEYS.has(k)) tradingScore++;
      if (CONFIG_JSON_KEYS.has(k)) configScore++;
    }

    if (aiScore >= 2) {
      tags.add("ai_data");
      signals.add("ai_interaction");
      if (keys.some((k) => /agent|tools|functions|chain/i.test(k))) {
        signals.add("agent_config");
      }
      if (keys.some((k) => /model|weights|layers|training/i.test(k))) {
        signals.add("model_data");
      }
    }

    if (tradingScore >= 2) {
      tags.add("dataset");
      signals.add("trading_data");
    }

    if (configScore >= 2) {
      tags.add("config");
    }

    // Detect arrays of objects (likely dataset)
    if (Array.isArray(parsed) && parsed.length > 5) {
      tags.add("dataset");
    }
  } catch {
    // Invalid JSON — treat as text
    analyzeText(text, tags, signals);
  }
}

function extractJsonKeys(obj: unknown, maxDepth: number, depth = 0): string[] {
  if (depth >= maxDepth || !obj || typeof obj !== "object") return [];

  const keys: string[] = [];
  if (Array.isArray(obj)) {
    // Sample first element
    if (obj.length > 0) {
      keys.push(...extractJsonKeys(obj[0], maxDepth, depth + 1));
    }
  } else {
    for (const key of Object.keys(obj as Record<string, unknown>)) {
      keys.push(key);
      keys.push(...extractJsonKeys((obj as Record<string, unknown>)[key], maxDepth, depth + 1));
    }
  }
  return keys;
}

// ── CSV Analysis ──────────────────────────────────────────────

function analyzeCsv(text: string, tags: Set<string>, signals: Set<string>): void {
  const lines = text.split("\n").filter((l) => l.trim());
  if (lines.length < 2) return;

  tags.add("dataset");

  // Analyze header row
  const headers = lines[0].toLowerCase();

  if (/price|volume|market|trade|swap|ticker/i.test(headers)) {
    signals.add("trading_data");
  }
  if (/model|accuracy|loss|epoch|prediction|score/i.test(headers)) {
    tags.add("ai_data");
    signals.add("model_data");
  }
  if (/user|address|wallet|account|tx/i.test(headers)) {
    tags.add("dataset");
  }

  // Large datasets are noteworthy
  if (lines.length > 100) {
    tags.add("dataset");
  }
}

// ── Text Analysis ─────────────────────────────────────────────

function analyzeText(text: string, tags: Set<string>, signals: Set<string>): void {
  const lower = text.toLowerCase();

  // AI-related content
  if (/\b(model|neural|training|inference|prompt|embedding|llm|gpt|transformer)\b/i.test(lower)) {
    tags.add("ai_data");
    signals.add("ai_interaction");
  }

  // Trading-related content
  if (/\b(trade|swap|liquidity|defi|price|market|portfolio|yield)\b/i.test(lower)) {
    signals.add("trading_data");
  }

  // Log-like content
  if (/\b(error|warn|info|debug|trace|exception|stack)\b/i.test(lower) && /\d{4}-\d{2}-\d{2}/.test(text)) {
    tags.add("logs");
  }
}

// ── Preview Generation ────────────────────────────────────────

function generatePreview(text: string, type: string | null): string | null {
  let preview: string;

  if (type === "json") {
    try {
      const parsed = JSON.parse(text);
      // Compact JSON preview
      preview = JSON.stringify(parsed, null, 0);
    } catch {
      preview = text;
    }
  } else if (type === "csv") {
    // First 3 lines (header + 2 rows)
    const lines = text.split("\n").slice(0, 3);
    preview = lines.join("\n");
  } else {
    preview = text;
  }

  // Clean and truncate
  preview = preview
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);

  return preview || null;
}
