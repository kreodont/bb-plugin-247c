// Keep headroom below Google's published 6,000 units/minute/user quota.
// Reserve the more conservative full-body Gmail API costs because connector
// accounting may differ: https://developers.google.com/workspace/gmail/api/reference/quota
export const GMAIL_QUOTA_UNITS_PER_MINUTE = 4800;
export const GMAIL_QUOTA_COOLDOWN_MS = 60_000;

function queryCost(tool: string, args: Record<string, unknown>): number {
  if (tool === "search_threads") return 10;
  if (tool === "get_message") return args.messageFormat === "METADATA_ONLY" ? 20 : 60;
  return 120;
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    timer.unref?.();
    signal.addEventListener("abort", abort, { once: true });
  });
}

/** One gate for every Gmail call and retry in a collection, including recovery
 * of long threads. Waiting callers recheck the shared deadline after waking. */
export class GmailQuotaGate {
  private nextAt = 0;
  private cooldownUntil = 0;
  private readonly stopped = new AbortController();
  constructor(private readonly unitsPerMinute = GMAIL_QUOTA_UNITS_PER_MINUTE) {
    if (!(unitsPerMinute > 0)) throw new Error("Gmail quota pace must be positive.");
  }
  get isStopped() { return this.stopped.signal.aborted; }
  stop(error: Error) { this.stopped.abort(error); }
  cooldown(ms = GMAIL_QUOTA_COOLDOWN_MS) {
    this.cooldownUntil = Math.max(this.cooldownUntil, performance.now() + ms);
  }
  async acquire(tool: string, args: Record<string, unknown>, parent: AbortSignal): Promise<void> {
    const signal = AbortSignal.any([parent, this.stopped.signal]);
    for (;;) {
      signal.throwIfAborted();
      const now = performance.now(), remaining = Math.max(this.nextAt, this.cooldownUntil) - now;
      if (remaining <= 0) {
        // Reserve synchronously so concurrent callers cannot claim one slot.
        this.nextAt = now + queryCost(tool, args) * 60_000 / this.unitsPerMinute;
        return;
      }
      await wait(Math.ceil(remaining), signal);
    }
  }
}
