import { sourceError } from "./source-error-text.js";

type Json = Record<string, any>;
const RATE_LIMITED = /\b(?:rate[ _-]+limit(?:ed|ing)?(?:[ _-]+exceeded)?|ratelimited|too many requests)\b/i;
const TRANSIENT = /fetch failed|ECONNRESET|currently unavailable|temporarily unavailable|timed?\s*out|timeout|(?:^|\W)-32001\b/i;

function httpStatus(value: unknown): number | undefined {
  const status = typeof value === "number" ? value : typeof value === "string" && /^\d{3}$/.test(value) ? Number(value) : 0;
  return status >= 400 && status <= 599 ? status : undefined;
}

// Only diagnostic fields are evidence of an error. Quota counters, headers and
// issue contents may contain words or numbers that resemble transient failures.
function diagnostic(value: unknown, depth = 0): string {
  if (depth > 5 || value == null) return "";
  if (typeof value === "string") {
    try { return diagnostic(JSON.parse(value), depth + 1); } catch { return value; }
  }
  if (Array.isArray(value)) return value.map(v => diagnostic(v, depth + 1)).filter(Boolean).join("; ");
  if (typeof value !== "object") return "";
  const data = value as Json;
  const messages = ["message", "text", "errorMessages", "error", "code"].map(key => diagnostic(data[key], depth + 1));
  if (data.errors && typeof data.errors === "object") messages.push(...Object.values(data.errors).map(v => diagnostic(v, depth + 1)));
  return [...new Set(messages.filter(Boolean))].join("; ");
}

export class SourceRequestError extends Error {
  readonly rateLimited: boolean;
  readonly retryable: boolean;
  constructor(message: string, status?: number) {
    status ??= httpStatus(/(?:^|\b(?:HTTP(?:\s+error)?|status(?:\s+code)?))\s*[:=]?\s*(\d{3})\b/i.exec(message)?.[1]);
    super(sourceError(`${status && !new RegExp(`^HTTP ${status}\\b`, "i").test(message) ? `HTTP ${status}: ` : ""}${message || "The source request failed."}`));
    this.rateLimited = status ? status === 429 : RATE_LIMITED.test(message);
    this.retryable = status ? [429, 502, 503, 504].includes(status) : this.rateLimited || TRANSIENT.test(message);
  }
}

export function sourceResponseFailure(raw: Json, data: Json): SourceRequestError | null {
  const status = httpStatus(data?.statusCode) ?? httpStatus(raw?.statusCode);
  if (!raw?.isError && !data?.error && !status) return null;
  return new SourceRequestError(diagnostic(data) || diagnostic(raw), status);
}

export function sourceThrownFailure(cause: unknown): SourceRequestError {
  if (cause instanceof SourceRequestError) return cause;
  const message = sourceError(cause);
  // Transport exceptions may wrap an MCP response, including Slack's bare
  // "ratelimited" diagnostic. Prefer its parsed error fields when available.
  for (const line of message.split("\n")) {
    try {
      const parsed = JSON.parse(line.replace(/^data:\s*/, ""));
      const raw = parsed.result ?? parsed;
      // The MCP gateway can throw an SSE event containing {message, status}
      // instead of an MCP isError response. Use only its top-level status;
      // nested headers and quota counters are not HTTP failure evidence.
      const status = httpStatus(raw.statusCode) ?? httpStatus(raw.status);
      if (status) return new SourceRequestError(diagnostic(raw), status);
      if (raw.isError) {
        const text = (raw.content ?? []).filter((part: Json) => part.type === "text").map((part: Json) => part.text).join("\n");
        let data: Json = { text };
        try { data = JSON.parse(text); } catch { /* Keep a plain diagnostic. */ }
        return sourceResponseFailure(raw, data)!;
      }
    } catch { /* Plain transport diagnostics are also valid. */ }
  }
  return new SourceRequestError(message);
}
