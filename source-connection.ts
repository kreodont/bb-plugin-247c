import { setTimeout as delay } from "node:timers/promises";
import { sourceThrownFailure } from "./source-errors.js";
import { connectionFailure, type ConnectionHttp, type HandshakeAttempt } from "./source-diagnostics.js";

type Handshake = {
  connect(signal: AbortSignal): Promise<void>;
  listTools(signal: AbortSignal): Promise<readonly string[]>;
  close(): Promise<void>;
  http?: ConnectionHttp[];
  stopDiagnostics?(): void;
};

/** Retry setup on a fresh transport. Never retry permanent access failures or
 * reuse a half-initialized MCP session. Setup has its own budget, separate from reads.
 */
export async function establishSourceConnection<T extends Handshake>(create: () => T, required: readonly string[], parent: AbortSignal,
  options: { budgetMs?: number; retryDelayMs?: number; onAttempt?: (attempt: HandshakeAttempt) => void } = {}): Promise<T> {
  const budgetMs = options.budgetMs ?? 45000;
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), budgetMs); timer.unref?.();
  const signal = AbortSignal.any([parent, deadline.signal]);
  let stage: HandshakeAttempt["stage"] = "initialization";
  try {
    for (let attempt = 1; ; attempt++) {
      signal.throwIfAborted();
      const session = create();
      const startedAt = new Date().toISOString(), start = performance.now();
      const report = (result: Pick<HandshakeAttempt, "outcome" | "retryable" | "rateLimited" | "status" | "failure">) => {
        session.stopDiagnostics?.();
        options.onAttempt?.({ attempt, startedAt, elapsedMs: Math.round(performance.now() - start), stage, http: (session.http ?? []).map(h => ({ ...h })), ...result });
      };
      try {
        stage = "initialization";
        await session.connect(signal);
        signal.throwIfAborted();
        stage = "tool discovery";
        const tools = await session.listTools(signal);
        signal.throwIfAborted();
        if (!required.every(name => tools.includes(name))) throw new Error("The source tool set changed; the collector needs updating.");
        report({ outcome: "connected", retryable: false, rateLimited: false });
        return session;
      } catch (cause) {
        const failure = sourceThrownFailure(cause);
        report({ outcome: parent.aborted ? "cancelled" : deadline.signal.aborted ? "timed_out" : "failed", failure: deadline.signal.aborted ? "request_timeout" : connectionFailure(failure), retryable: failure.retryable, rateLimited: failure.rateLimited, ...(failure.status ? { status: failure.status } : {}) });
        await session.close().catch(() => {});
        if (signal.aborted || attempt >= 2 || !failure.retryable) {
          throw new Error(`Source connection failed during ${stage} after ${attempt} attempt${attempt === 1 ? "" : "s"}: ${failure.message}. No source data was read.`);
        }
        await delay(options.retryDelayMs ?? (failure.rateLimited ? 5000 : 1000), undefined, { signal });
      }
    }
  } catch (cause) {
    if (parent.aborted) throw new Error(`Source connection stopped during ${stage}: the check was stopped before source reads began.`);
    if (deadline.signal.aborted) throw new Error(`Source connection setup timed out after ${budgetMs / 1000} seconds during ${stage}. No source data was read.`);
    throw cause;
  } finally { clearTimeout(timer); }
}
