import { DayPlanning } from "./day-planning.js";
import { readCalendar } from "./calendar-reader.js";
import { sourceError } from "./source-connectors.js";
import { dayDateSchema, shiftDay, weekStart } from "./day-contracts.js";

export class CalendarRuntime {
  private controller: AbortController | null = null;
  private disposed = false;
  private active: Promise<void> | null = null;
  constructor(readonly days: DayPlanning, readonly enabled: () => Promise<boolean>, readonly read = readCalendar) {}
  async start(raw = this.days.today(), externalSignal?: AbortSignal) {
    const date = dayDateSchema.parse(raw);
    if (this.disposed) throw new Error("The plugin is reloading.");
    if (this.active) return this.days.calendarState();
    externalSignal?.throwIfAborted();
    if (!await this.enabled()) return this.days.saveCalendarState({ ...this.days.calendarState(), status: "idle", message: "Meeting import is disabled in 247C settings." });
    externalSignal?.throwIfAborted();
    if (this.disposed) throw new Error("The plugin is reloading.");
    if (this.active) return this.days.calendarState();
    const from = weekStart(date), through = shiftDay(date, 7), controller = new AbortController();
    this.controller = controller;
    this.days.saveCalendarState({ ...this.days.calendarState(), status: "running", message: null, from, through, startedAt: this.days.now() });
    const abort = () => controller.abort(externalSignal?.reason);
    externalSignal?.addEventListener("abort", abort, { once: true });
    this.active = Promise.resolve().then(() => this.collect(from, through, controller)).finally(() => externalSignal?.removeEventListener("abort", abort));
    return this.days.calendarState();
  }
  private async collect(from: string, through: string, controller: AbortController) {
    try {
      const result = await this.read({ from, through, known: this.days.calendarItems(from, through), signal: controller.signal, timeZone: this.days.timeZone });
      if (this.disposed) return;
      controller.signal.throwIfAborted();
      this.days.mergeCalendar(result.events, "calendar:sync");
      this.days.saveCalendarState({ ...this.days.calendarState(), status: "complete", completedAt: this.days.now(), events: result.events.filter(e => e.status === "confirmed").length, message: null });
    } catch (error) {
      if (!this.disposed) this.days.saveCalendarState({ ...this.days.calendarState(), status: controller.signal.aborted ? "idle" : "error", message: controller.signal.aborted ? "Calendar check stopped. Previous meetings are preserved." : sourceError(error) });
    } finally { if (this.controller === controller) { this.controller = null; this.active = null; } }
  }
  async settled() { await this.active; }
  dispose() { this.disposed = true; this.controller?.abort(); }
}
