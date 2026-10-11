import { UX_BUILD, uxActionSchema, uxEventSchema, uxPageSchema, type UxEvent, type UxState, type UxAction } from "./ux-contracts.js";
import { uxBatchSchema } from "./ux-contracts.js";
import type { z } from "zod";

type Batch = z.infer<typeof uxBatchSchema>;
const BUFFER_KEY = "247c-ux-buffer-v1";
const scopeSelector = "[data-c247-ux-page]";
let activeCollector: UxCollector | undefined;
export function beginUxAction(action: UxAction) { return activeCollector?.begin(action) ?? (() => {}); }
export function markUxFeedback(note = "") { return activeCollector?.feedback(note) ?? false; }
export function uxViewChanged() { window.dispatchEvent(new Event("c247-ux-view")); }

export class UxCollector {
  private state?: UxState;
  private queue: UxEvent[] = [];
  private pending?: Batch;
  private sending = false;
  private disposed = false;
  private clientId: string = crypto.randomUUID();
  private lastPointer = -Infinity;
  private lastScroll = -Infinity;
  private lastView = "";
  private lastPresence: "active" | "inactive" | undefined;
  private pendingPresence?: ReturnType<typeof setTimeout>;
  private restoredId?: string;
  private cleanup: (() => void)[] = [];
  constructor(private send: (batch: Batch) => Promise<{ reason: string }>, private status: (message: string | null) => void, private trustedOnly = true, private now = () => Date.now()) {
    activeCollector = this;
    // Session-local, bounded and expiring. Nothing from outside 247C scopes is stored.
    if (!trustedOnly || !navigator.webdriver) try {
      const saved = JSON.parse(sessionStorage.getItem(BUFFER_KEY) ?? "null");
      if (saved && saved.at >= this.now() - 3600000) {
        const pending = uxBatchSchema.safeParse(saved.pending);
        if (pending.success) { this.pending = pending.data; this.clientId = pending.data.clientId; }
        if (Array.isArray(saved.queue)) this.queue = saved.queue.slice(-180).flatMap((e: unknown) => { const parsed = uxEventSchema.safeParse(e); return parsed.success && parsed.data.at >= this.now() - 3600000 ? [parsed.data] : []; });
        this.restoredId = typeof saved.recordingId === "string" ? saved.recordingId : undefined;
      }
    } catch { /* Browser storage is optional. */ }
    const listen = (target: EventTarget, kind: string, fn: EventListener) => { target.addEventListener(kind, fn, { capture: true, passive: true }); this.cleanup.push(() => target.removeEventListener(kind, fn, true)); };
    listen(document, "click", e => this.pointer(e as MouseEvent, "click"));
    listen(document, "pointermove", e => this.pointer(e as PointerEvent, "pointer"));
    listen(document, "scroll", e => this.scroll(e));
    listen(document, "visibilitychange", () => { this.presence(document.visibilityState === "hidden" ? "inactive" : "active"); void this.flush(); });
    listen(window, "focus", () => this.presence("active"));
    listen(window, "blur", () => { this.presence("inactive"); void this.flush(); });
    listen(window, "pagehide", () => { this.persist(); void this.flush(); });
    listen(window, "c247-ux-view", () => this.view());
    const timer = setInterval(() => { this.view(); void this.flush(); }, 5000);
    this.cleanup.push(() => clearInterval(timer));
  }
  update(state: UxState) {
    if ((this.state?.recordingId ?? this.restoredId) !== state.recordingId || !state.recordingId || state.endsAt !== null && state.endsAt <= this.now()) { this.queue = []; this.pending = undefined; this.lastView = ""; this.lastPresence = undefined; }
    this.state = state; this.restoredId = undefined; this.persist();
    this.view();
  }
  private enabled() { return !this.disposed && (!this.trustedOnly || !navigator.webdriver) && !!this.state?.recordingId && (this.state.endsAt === null || this.state.endsAt > this.now()); }
  private persist() {
    if (this.disposed || this.trustedOnly && navigator.webdriver) return;
    try {
      if (!this.queue.length && !this.pending) sessionStorage.removeItem(BUFFER_KEY);
      else sessionStorage.setItem(BUFFER_KEY, JSON.stringify({ at: this.now(), recordingId: this.state?.recordingId ?? this.restoredId, pending: this.pending, queue: this.queue }));
    } catch { /* Recording still works without browser storage. */ }
  }
  private scope(target?: EventTarget | null) {
    const element = target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
    if (element?.closest("[data-c247-ux-private]")) return null;
    const root = element ? element.closest<HTMLElement>(scopeSelector) : document.querySelector<HTMLElement>(`[role="dialog"] ${scopeSelector}`) ?? document.querySelector<HTMLElement>(scopeSelector);
    const page = uxPageSchema.safeParse(root?.dataset.c247UxPage);
    return root && page.success ? { root, page: page.data } : null;
  }
  private add(event: UxEvent) {
    if (!this.enabled()) return;
    if (this.queue.length >= 180) {
      const noise = this.queue.findIndex(e => ["pointer", "scroll", "active", "inactive"].includes(e.kind));
      this.queue.splice(noise < 0 ? 0 : noise, 1);
      this.status("Recording buffer is full; oldest samples were dropped");
    }
    this.queue.push(event); this.persist();
  }
  private base(scope: NonNullable<ReturnType<UxCollector["scope"]>>): Pick<UxEvent, "at" | "page" | "width" | "height" | "layout"> {
    const layout = scope.root.querySelector<HTMLElement>("[data-c247-task-layout]")?.dataset.c247TaskLayout;
    return { at: this.now(), page: scope.page, width: Math.min(20000, Math.max(1, window.innerWidth)), height: Math.min(20000, Math.max(1, window.innerHeight)), ...(layout === "list" || layout === "cards" ? { layout } : {}) };
  }
  view() {
    if (!this.enabled() || document.visibilityState === "hidden") return;
    const scope = this.scope();
    if (!scope) { this.lastView = ""; return; }
    const key = `${scope.page}:${scope.root.dataset.c247UxView ?? ""}`;
    if (key === this.lastView) return;
    this.lastView = key;
    this.add({ ...this.base(scope), kind: "view", action: "surface" });
  }
  private presence(kind: "active" | "inactive") {
    if (this.pendingPresence) clearTimeout(this.pendingPresence);
    // Ignore quick focus churn between host controls and plugin portals.
    this.pendingPresence = setTimeout(() => {
      const scope = this.scope();
      if (scope && kind !== this.lastPresence && this.enabled()) { this.lastPresence = kind; this.add({ ...this.base(scope), kind, action: "surface" }); }
    }, 1000);
  }
  private pointer(event: MouseEvent, kind: "click" | "pointer") {
    if (!this.enabled() || document.visibilityState === "hidden" || this.trustedOnly && !event.isTrusted) return;
    const scope = this.scope(event.target); if (!scope) return;
    if (kind === "pointer" && this.now() - this.lastPointer < 1000) return;
    if (kind === "pointer") this.lastPointer = this.now();
    const element = event.target as Element;
    const explicit = uxActionSchema.safeParse(element.closest<HTMLElement>("[data-c247-ux-action]")?.dataset.c247UxAction);
    const tag = element.closest("button,a,input,select,textarea,[role=button]")?.tagName.toLowerCase();
    const action: UxAction = explicit.success ? explicit.data : tag === "a" ? "link" : tag === "input" || tag === "textarea" ? "field" : tag === "select" ? "select" : tag ? "button" : "surface";
    this.view();
    this.add({ ...this.base(scope), kind, action, x: Math.max(0, Math.min(1, event.clientX / window.innerWidth)), y: Math.max(0, Math.min(1, event.clientY / window.innerHeight)) });
  }
  private scroll(event: Event) {
    if (!this.enabled() || document.visibilityState === "hidden" || this.now() - this.lastScroll < 1000 || this.trustedOnly && !event.isTrusted) return;
    const scope = this.scope(event.target); if (!scope || !(event.target instanceof HTMLElement)) return;
    this.lastScroll = this.now();
    this.add({ ...this.base(scope), kind: "scroll", action: "surface", scroll: Math.max(0, Math.min(1, event.target.scrollTop / Math.max(1, event.target.scrollHeight - event.target.clientHeight))) });
  }
  begin(action: UxAction) {
    const scope = this.scope(), state = this.state, start = this.now();
    let finished = false;
    return (outcome: "ok" | "error" = "ok") => { if (finished) return; finished = true; if (scope && state?.recordingId === this.state?.recordingId) this.add({ ...this.base(scope), kind: "result", action, outcome, durationMs: Math.min(3600000, Math.max(0, this.now() - start)) }); };
  }
  feedback(note: string) {
    const scope = this.scope(); if (!scope || !this.enabled()) return false;
    this.add({ ...this.base(scope), kind: "feedback", action: "feedback", ...(note.trim() ? { note: note.trim().slice(0,500) } : {}) });
    void this.flush(); return true;
  }
  async flush() {
    if (this.sending || !this.enabled()) return;
    if (!this.pending && this.queue.length) this.pending = { recordingId: this.state!.recordingId!, batchId: crypto.randomUUID(), clientId: this.clientId, build: UX_BUILD, events: this.queue.splice(0,60).map(e => uxEventSchema.parse(e)) };
    this.persist();
    const batch = this.pending; if (!batch) return;
    this.sending = true;
    try {
      const result = await this.send(batch);
      if (["saved", "duplicate", "paused"].includes(result.reason) && this.pending === batch) this.pending = undefined;
      if (result.reason === "paused" && this.state?.recordingId === batch.recordingId) {
        this.queue = []; this.state = { ...this.state, enabled: false, recordingId: null };
        // Refresh immediately after a server-side pause; do not silently keep sampling.
        window.dispatchEvent(new Event("c247-ux-refresh"));
      }
      this.persist();
      if (!this.disposed) this.status(["saved", "duplicate"].includes(result.reason) ? null : result.reason === "paused" ? "Recording paused; refreshing status" : "Recording could not be saved; retrying");
    } catch { if (!this.disposed) this.status("Recording could not be saved; retrying"); }
    finally { this.sending = false; }
  }
  dispose() {
    void this.flush();
    this.persist(); this.disposed = true;
    if (this.pendingPresence) clearTimeout(this.pendingPresence);
    for (const cleanup of this.cleanup.splice(0)) cleanup();
    if (activeCollector === this) activeCollector = undefined;
    this.queue = [];
  }
}
