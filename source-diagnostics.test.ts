import { expect, it, vi } from "vitest";
import { establishSourceConnection } from "./source-connection.js";
import { connectionFetch, connectionAttemptSchema, type ConnectionHttp, type HandshakeAttempt } from "./source-diagnostics.js";

it("keeps both a throttled attempt and a later successful attempt with separate stages and durations", async () => {
  const attempts: HandshakeAttempt[] = []; let index = 0;
  await establishSourceConnection(() => {
    const first = ++index === 1;
    return { http: [{ stage: "initialization" as const, status: first ? 429 : 200, elapsedMs: 5, ...(first ? { retryAfterSeconds: 12 } : {}) }],
      connect: async () => { if (first) throw new Error("HTTP 429: Bearer private-secret"); },
      listTools: async () => ["read"], close: async () => {},
    };
  }, ["read"], new AbortController().signal, { retryDelayMs: 0, onAttempt: a => attempts.push(a) });
  expect(attempts).toMatchObject([
    { attempt: 1, stage: "initialization", outcome: "failed", status: 429, rateLimited: true, http: [{ status: 429, retryAfterSeconds: 12 }] },
    { attempt: 2, stage: "tool discovery", outcome: "connected", rateLimited: false, http: [{ status: 200 }] },
  ]);
  for (const a of attempts) { expect(a.elapsedMs).toBeGreaterThanOrEqual(0); connectionAttemptSchema.parse({ source: "jira", ...a }); }
  expect(JSON.stringify(attempts)).not.toContain("private-secret");
});

it("does not call HTTP 200 a successful MCP handshake when tool discovery times out", async () => {
  const attempts: HandshakeAttempt[] = [];
  await expect(establishSourceConnection(() => ({
    http: [{ stage: "initialization" as const, elapsedMs: 1, status: 200 }], connect: async () => {}, close: async () => {},
    listTools: async (signal: AbortSignal) => new Promise<readonly string[]>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })),
  }), ["read"], new AbortController().signal, { budgetMs: 10, onAttempt: a => attempts.push(a) })).rejects.toThrow("setup timed out");
  expect(attempts).toMatchObject([{ attempt: 1, stage: "tool discovery", outcome: "timed_out", rateLimited: false, http: [{ status: 200 }] }]);
});

it("retains SSE upstream failure status without recording the payload", async () => {
  const attempts: HandshakeAttempt[] = [];
  await expect(establishSourceConnection(() => ({ connect: async () => { throw new Error('event: message\ndata: {"status":503,"message":"upstream reset"}'); }, listTools: async () => ["read"], close: async () => {} }),
    ["read"], new AbortController().signal, { retryDelayMs: 0, onAttempt: a => attempts.push(a) })).rejects.toThrow("HTTP 503");
  expect(attempts).toHaveLength(2);
  expect(attempts.every(a => a.status === 503 && !a.rateLimited && a.retryable)).toBe(true);
});

it("records only allowlisted HTTP diagnostics and leaves the response readable", async () => {
  const events: ConnectionHttp[] = [], body = "private response body";
  const request = vi.fn<typeof fetch>(async () => new Response(body, { status: 429, headers: {
    "Retry-After": "15", "RateLimit-Reason": "jira-quota-tenant-based", "Authorization": "Bearer secret", "Set-Cookie": "private-cookie", "X-Secret": "private-value",
  } }));
  const response = await connectionFetch(() => "initialization", e => events.push(e), request)("https://example.com/private?token=private-token", { headers: { Authorization: "Bearer private-token" } });
  expect(await response.text()).toBe(body);
  expect(events).toMatchObject([{ status: 429, stage: "initialization", retryAfterSeconds: 15, rateLimitReason: "jira-quota-tenant-based" }]);
  expect(JSON.stringify(events)).not.toMatch(/private|secret|Authorization|Cookie|example/);
});

it("normalizes Retry-After dates and rejects arbitrary header values", async () => {
  const events: ConnectionHttp[] = [];
  const future = new Date(Date.now() + 60000).toUTCString();
  for (const retry of [future, "Bearer private-token"]) {
    await connectionFetch(() => "catalog", e => events.push(e), async () => new Response(null, { status: 503, headers: { "Retry-After": retry, "RateLimit-Reason": "private-data" } }))("https://example.com");
  }
  expect(events[0].retryAfterSeconds).toBeGreaterThan(58);
  expect(events[1].retryAfterSeconds).toBeUndefined();
  expect(events.every(e => e.rateLimitReason === "other")).toBe(true);
  expect(JSON.stringify(events)).not.toContain("private");
});
