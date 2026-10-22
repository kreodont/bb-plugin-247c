import { z } from "zod";

const stage = z.enum(["authentication", "catalog", "availability", "initialization", "tool discovery"]);
const httpSchema = z.object({
  stage, elapsedMs: z.number().nonnegative(), status: z.number().int().min(100).max(599).optional(),
  retryAfterSeconds: z.number().nonnegative().optional(),
  rateLimitReason: z.enum(["jira-quota-global-based", "jira-quota-tenant-based", "jira-burst-based", "jira-per-issue-on-write", "other"]).optional(),
  failed: z.boolean().optional(),
}).strict();
export const connectionAttemptSchema = z.object({
  source: z.enum(["shared", "gmail", "slack", "jira"]), attempt: z.number().int().positive(),
  startedAt: z.string(), elapsedMs: z.number().nonnegative(), stage,
  outcome: z.enum(["connected", "failed", "timed_out", "cancelled"]),
  status: z.number().int().min(400).max(599).optional(),
  rateLimited: z.boolean(), retryable: z.boolean(),
  failure: z.enum(["request_timeout", "rate_limit", "access_denied", "tool_catalog_changed", "transport", "other"]).optional(),
  http: z.array(httpSchema).max(32),
}).strict();
export type ConnectionAttempt = z.infer<typeof connectionAttemptSchema>;
export type ConnectionHttp = z.infer<typeof httpSchema>;
export type HandshakeAttempt = Omit<ConnectionAttempt, "source">;

export function connectionFailure(failure: { message: string; status?: number; rateLimited: boolean }): NonNullable<ConnectionAttempt["failure"]> {
  if (failure.rateLimited) return "rate_limit";
  if (failure.status === 401 || failure.status === 403) return "access_denied";
  if (/timed?\s*out|timeout|-32001/i.test(failure.message)) return "request_timeout";
  if (/tool set changed/i.test(failure.message)) return "tool_catalog_changed";
  if (failure.status || /fetch failed|ECONNRESET|ECONNREFUSED|ENOTFOUND/i.test(failure.message)) return "transport";
  return "other";
}

/** Deliberately exclude URLs, bodies, credentials and arbitrary header text. */
export function connectionFetch(stage: () => ConnectionHttp["stage"], record: (event: ConnectionHttp) => void, request: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    const start = performance.now(), phase = stage();
    try {
      const response = await request(input, init);
      const raw = response.headers.get("retry-after"), reason = response.headers.get("ratelimit-reason");
      const seconds = raw && /^\d+(?:\.\d+)?$/.test(raw) ? Number(raw) : raw && Number.isFinite(Date.parse(raw)) ? Math.max(0, (Date.parse(raw) - Date.now()) / 1000) : undefined;
      const known = httpSchema.shape.rateLimitReason.unwrap().options;
      record({ stage: phase, elapsedMs: Math.round(performance.now() - start), status: response.status,
        ...(seconds !== undefined && Number.isFinite(seconds) ? { retryAfterSeconds: seconds } : {}),
        ...(reason ? { rateLimitReason: known.includes(reason as typeof known[number]) ? reason as typeof known[number] : "other" } : {}),
      });
      return response;
    } catch (error) {
      record({ stage: phase, elapsedMs: Math.round(performance.now() - start), failed: true });
      throw error;
    }
  };
}

export function connectionAttemptText(a: ConnectionAttempt): string {
  const statuses = [...new Set(a.http.flatMap(h => h.status ? [h.status] : []))];
  const waits = [...new Set(a.http.flatMap(h => h.retryAfterSeconds === undefined ? [] : [h.retryAfterSeconds]))];
  return `${a.source} #${a.attempt}: ${a.stage}, ${a.outcome.replaceAll("_", " ")}, ${(a.elapsedMs / 1000).toFixed(1)}s${a.failure ? `; ${a.failure.replaceAll("_", " ")}` : ""}${a.status ? `; failure HTTP ${a.status}` : ""}${statuses.length ? `; transport HTTP ${statuses.join(", ")}` : ""}${waits.length ? `; Retry-After ${waits.join(", ")}s` : ""}${a.rateLimited ? "; rate limit reported" : ""}`;
}
