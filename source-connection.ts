import { setTimeout as delay } from "node:timers/promises";
import { sourceThrownFailure } from "./source-errors.js";

type Handshake = {
  connect(signal: AbortSignal): Promise<void>;
  listTools(signal: AbortSignal): Promise<readonly string[]>;
  close(): Promise<void>;
};

/** Retry setup on a fresh transport. Never retry permanent access failures or
 * reuse a half-initialized MCP session. The shared budget leaves time for reads.
 */
export async function establishSourceConnection<T extends Handshake>(create: () => T, required: readonly string[], parent: AbortSignal,
  options: { budgetMs?: number; retryDelayMs?: number } = {}): Promise<T> {
  const budgetMs = options.budgetMs ?? 45000;
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), budgetMs); timer.unref?.();
  const signal = AbortSignal.any([parent, deadline.signal]);
  let stage = "initialization";
  try {
    for (let attempt = 1; ; attempt++) {
      signal.throwIfAborted();
      const session = create();
      try {
        stage = "initialization";
        await session.connect(signal);
        signal.throwIfAborted();
        stage = "tool discovery";
        const tools = await session.listTools(signal);
        signal.throwIfAborted();
        if (!required.every(name => tools.includes(name))) throw new Error("The source tool set changed; the collector needs updating.");
        return session;
      } catch (cause) {
        await session.close().catch(() => {});
        const failure = sourceThrownFailure(cause);
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
