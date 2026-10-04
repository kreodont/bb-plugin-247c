import { UX_BUILD, uxActionSchema, uxEventSchema, uxPageSchema, type UxEvent, type UxState, type UxAction } from "./ux-contracts.js";
import type { uxBatchSchema } from "./ux-contracts.js";
import type { z } from "zod";

type Batch = z.infer<typeof uxBatchSchema>;
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
  private clientId = crypto.randomUUID();
  private lastPointer = -Infinity;
  private lastScroll = -Infinity;
  private lastView = "";
  private cleanup: (() => void)[] = [];
  constructor(private send: (batch: Batch) => Promise<{ reason: string }>, private status: (message: string | null) => void, private trustedOnly = true, private now = () => Date.now()) {
    activeCollector = this;
    const listen = (target: EventTarget, kind: string, fn: EventListener) => { target.addEventListener(kind, fn, { capture: true, passive: true }); this.cleanup.push(() => target.removeEventListener(kind, fn, true)); };
    listen(document, "click", e => this.pointer(e as MouseEvent, "click"));
    listen(document, "pointermove", e => this.pointer(e as PointerEvent, "pointer"));
    listen(document, "scroll", e => this.scroll(e));
    listen(document, "visibilitychange", () => { this.presence(document.visibilityState === "hidden" ? "inactive" : "active"); void this.flush(); });
    listen(window, "focus", () => this.presence("active"));
    listen(window, "blur", () => { this.presence("inactive"); void this.flush(); });
    listen(window, "c247-ux-view", () => this.view());
    const timer = setInterval(() => { this.view(); void this.flush(); }, 5000);
    this.cleanup.push(() => clearInterval(timer));
  }
  update(state: UxState) {
    if (this.state?.recordingId !== state.recordingId || !state.enabled) { this.queue = []; this.pending = undefined; this.lastView = ""; }
    this.state = state;
    this.view();
  }
  private enabled() { return !this.disposed && (!this.trustedOnly || !navigator.webdriver) && this.state?.enabled && (this.state.endsAt ?? 0) > this.now(); }
  private scope(target?: EventTarget | null) {
    const element = target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
    if (element?.closest("[data-c247-ux-private]")) return null;
    const root = element ? element.closest<HTMLElement>(scopeSelector) : document.querySelector<HTMLElement>(scopeSelector);
    const page = uxPageSchema.safeParse(root?.dataset.c247UxPage);
    return root && page.success ? { root, page: page.data } : null;
  }
  private add(event: UxEvent) { if (this.enabled() && this.queue.length < 180) this.queue.push(event); }
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
  private presence(kind: "active" | "inactive") { const scope = this.scope(); if (scope) this.add({ ...this.base(scope), kind, action: "surface" }); }
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
    return (outcome: "ok" | "error" = "ok") => { if (scope && state?.recordingId === this.state?.recordingId) this.add({ ...this.base(scope), kind: "result", action, outcome, durationMs: Math.min(3600000, Math.max(0, this.now() - start)) }); };
  }
  feedback(note: string) {
    const scope = this.scope(); if (!scope || !this.enabled()) return false;
    this.add({ ...this.base(scope), kind: "feedback", action: "feedback", ...(note.trim() ? { note: note.trim().slice(0,500) } : {}) });
    void this.flush(); return true;
  }
  async flush() {
    if (this.sending || !this.enabled()) return;
    if (!this.pending && this.queue.length) this.pending = { recordingId: this.state!.recordingId!, batchId: crypto.randomUUID(), clientId: this.clientId, build: UX_BUILD, events: this.queue.splice(0,60).map(e => uxEventSchema.parse(e)) };
    const batch = this.pending; if (!batch) return;
    this.sending = true;
    try {
      const result = await this.send(batch);
      if (this.pending === batch) this.pending = undefined;
      if (!this.disposed) this.status(["saved", "duplicate", "paused"].includes(result.reason) ? null : "Recording storage is full or unavailable");
    } catch { if (!this.disposed) this.status("Recording could not be saved; retrying"); }
    finally { this.sending = false; }
  }
  dispose() {
    void this.flush();
    this.disposed = true;
    for (const cleanup of this.cleanup.splice(0)) cleanup();
    if (activeCollector === this) activeCollector = undefined;
    this.queue = [];
  }
}
