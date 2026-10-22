/** Wall time while this source is busy, including retries. Parallel requests
 * share the clock; waiting for other sources does not spend this budget. */
export class SourceBudget {
  private remaining: number;
  private active = 0;
  private started = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private readonly deadline = new AbortController();
  readonly signal: AbortSignal;
  constructor(parent: AbortSignal, readonly limitMs: number) {
    this.remaining = limitMs;
    this.signal = AbortSignal.any([parent, this.deadline.signal]);
  }
  enter(): () => void {
    if (this.active++ === 0 && !this.signal.aborted) {
      this.started = performance.now();
      if (this.remaining <= 0) this.deadline.abort();
      else { this.timer = setTimeout(() => this.deadline.abort(), this.remaining); this.timer.unref?.(); }
    }
    return () => {
      if (--this.active === 0) {
        clearTimeout(this.timer);
        this.remaining -= performance.now() - this.started;
        if (this.remaining <= 0) this.deadline.abort();
      }
    };
  }
  dispose() { clearTimeout(this.timer); }
}
