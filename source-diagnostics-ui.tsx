import React from "react";
import { connectionAttemptText, type ConnectionAttempt } from "./source-diagnostics.js";

export function SourceConnectionDiagnostics({ attempts, date }: { attempts?: ConnectionAttempt[]; date: (value: string) => string }) {
  if (!attempts?.length) return null;
  return <details className="mt-3 rounded-lg border border-border p-3 text-xs text-muted-foreground">
    <summary className="cursor-pointer">Connection diagnostics · {attempts.length}</summary>
    <p className="mt-2">HTTP status describes the connector transport. A successful HTTP response does not confirm that MCP initialization finished.</p>
    <ol className="mt-2 space-y-2">{attempts.map((attempt, index) => <li key={index}>
      <p>{date(attempt.startedAt)} · {connectionAttemptText(attempt)}</p>
      {attempt.http.map((h, i) => <p key={i} className="ml-3">{h.stage}: {h.status ? `HTTP ${h.status}` : "transport failed"} · {h.elapsedMs} ms{h.retryAfterSeconds === undefined ? "" : ` · Retry-After ${h.retryAfterSeconds}s`}{h.rateLimitReason ? ` · ${h.rateLimitReason}` : ""}</p>)}
    </li>)}</ol>
  </details>;
}
