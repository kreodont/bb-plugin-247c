import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { UX_BUILD, UX_RETENTION_MS, uxBatchSchema, uxControlEventSchema, type UxState, type UxReport, type UxEvent, type UxPage } from "./ux-contracts.js";

import { summaryFileSchema, countEvents, emptyDay, type SummaryFile } from "./ux-summary.js";

const stateSchema = z.object({ recordingId: z.uuid().nullable(), endsAt: z.number().nullable(), lastSavedAt: z.number().nullable().default(null), controls: z.array(uxControlEventSchema).max(50).default([]) }).strict();
const storedBatch = uxBatchSchema.extend({ receivedAt: z.number(), build: z.string().min(1).max(64) });
type Batch = z.infer<typeof storedBatch>;
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_HOUR_BYTES = 512 * 1024;
const logName = /^\d{4}-\d{2}-\d{2}T\d{2}(?:-\d{6})?\.jsonl$/;
const logKey = (name: string) => name.replace(/T(\d{2})\.jsonl$/, "T$1-000000.jsonl");
const SUMMARY_RETENTION_MS = 90 * 86400000;

export class UxRecording {
  private available = false;
  private loaded = false;
  private lastSweep = 0;
  private seen = new Set<string>();
  private stateValue: z.infer<typeof stateSchema> = { recordingId: null, endsAt: null, lastSavedAt: null, controls: [] };
  constructor(readonly directory: string, private now = () => Date.now()) { this.recover(); this.sweep(true); }
  private files() { return readdirSync(this.directory).filter(n => logName.test(n)).sort((a,b) => logKey(a).localeCompare(logKey(b))); }
  private bytes() { return this.files().reduce((n, file) => n + statSync(join(this.directory, file)).size, 0); }
  private atomic(name: string, value: unknown) {
    const temp = join(this.directory, `${name}.tmp`);
    writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
    renameSync(temp, join(this.directory, name));
  }
  private withControl(reason: z.infer<typeof uxControlEventSchema>["reason"]) {
    return { ...this.stateValue, controls: [...this.stateValue.controls, { at: this.now(), reason }].slice(-50) };
  }
  private fail() {
    if (this.available) {
      this.stateValue = this.withControl("storage-error");
      try { this.atomic("state.json", this.stateValue); } catch { /* Retry when storage is writable again. */ }
    }
    this.available = false;
  }
  private recover() {
    if (this.available) return;
    try {
      mkdirSync(this.directory, { recursive: true, mode: 0o700 }); chmodSync(this.directory, 0o700);
      if (!this.loaded) {
        const file = join(this.directory, "state.json");
        if (existsSync(file)) this.stateValue = stateSchema.parse(JSON.parse(readFileSync(file, "utf8")));
        this.loaded = true;
      }
      const recovered = this.stateValue.controls.at(-1)?.reason === "storage-error";
      const next = recovered ? this.withControl("storage-recovered") : this.stateValue;
      // Probe a real write; readable storage does not imply recording can resume.
      this.atomic("state.json", next); this.stateValue = next; this.available = true;
    } catch { this.available = false; }
  }
  private summaries(): SummaryFile {
    const file = join(this.directory, "summaries.json");
    return existsSync(file) ? summaryFileSchema.parse(JSON.parse(readFileSync(file, "utf8"))) : { days: [] };
  }
  private batches(file: string): Batch[] {
    const batches: Batch[] = [], seen = new Set<string>();
    for (const line of readFileSync(join(this.directory, file), "utf8").split("\n")) {
      try { const batch = storedBatch.parse(JSON.parse(line)); if (!seen.has(batch.batchId)) { batches.push(batch); seen.add(batch.batchId); } }
      catch { /* Preserve complete batches before an interrupted append. */ }
    }
    return batches;
  }
  private retire(file: string) {
    const summary = this.summaries(), date = file.slice(0,10), key = logKey(file);
    let day = summary.days.find(d => d.date === date);
    if (!day) { day = { ...emptyDay(date), through: "" }; summary.days.push(day); }
    // Files retire oldest first. A durable high-water mark makes a crash between
    // saving counts and deleting a log safe to retry without double counting.
    if (key > day.through) {
      for (const batch of this.batches(file)) countEvents(day, batch.events);
      day.through = key;
      summary.days = summary.days.filter(d => Date.parse(d.date) > this.now() - SUMMARY_RETENTION_MS);
      this.atomic("summaries.json", summary);
    }
    unlinkSync(join(this.directory, file));
  }
  sweep(force = false) {
    this.recover();
    if (!this.available || !force && this.now() - this.lastSweep < 60000) return;
    try {
      const cutoff = this.now() - UX_RETENTION_MS;
      for (const file of this.files()) if (Date.parse(file.slice(0, 13) + ":00:00Z") <= cutoff) this.retire(file);
      const summary = this.summaries();
      const days = summary.days.filter(d => Date.parse(d.date) > this.now() - SUMMARY_RETENTION_MS);
      if (days.length !== summary.days.length) this.atomic("summaries.json", { days });
      this.lastSweep = this.now();
    } catch { this.fail(); }
  }
  state(): UxState {
    this.sweep();
    let bytes = 0;
    try { if (this.available) bytes = this.bytes(); } catch { this.fail(); }
    const requested = !!this.stateValue.recordingId;
    const expired = requested && this.stateValue.endsAt !== null && this.stateValue.endsAt <= this.now();
    return { enabled: this.available && requested && !expired, ...this.stateValue, bytes, storageAvailable: this.available, retentionDays: 7, build: UX_BUILD,
      status: !this.available ? "unavailable" : expired ? "expired" : requested ? "recording" : "paused" };
  }
  control(action: "start" | "pause" | "clear") {
    this.recover();
    if (!this.available) throw new Error("UX recording storage is unavailable. Task data is unaffected.");
    // Existing timed consent is never silently extended. Start explicitly opts
    // into continuous recording. Starting an already continuous run is idempotent.
    const next = { ...this.withControl(action === "start" ? "start" : action === "pause" ? "user-pause" : "user-clear"),
      recordingId: action === "start" ? this.stateValue.endsAt === null && this.stateValue.recordingId || randomUUID() : null, endsAt: null };
    try {
      this.atomic("state.json", next); this.stateValue = next;
      if (action === "clear") {
        for (const file of this.files()) unlinkSync(join(this.directory, file));
        this.atomic("summaries.json", { days: [] }); this.seen.clear();
        this.stateValue = { ...next, lastSavedAt: null }; this.atomic("state.json", this.stateValue);
      }
      return this.state();
    } catch (error) { this.fail(); throw error; }
  }
  record(input: z.infer<typeof uxBatchSchema>) {
    const batch = uxBatchSchema.parse(input), state = this.state();
    if (!state.storageAvailable) return { accepted: 0, reason: "unavailable" as const };
    if (!state.enabled || state.recordingId !== batch.recordingId) return { accepted: 0, reason: "paused" as const };
    const events = batch.events.filter(e => e.at <= this.now() + 60000 && e.at >= this.now() - 3600000);
    const hour = new Date(this.now()).toISOString().slice(0, 13);
    try {
      // Include the previous hour so a retry during hour rollover is idempotent.
      const recent = this.files().filter(n => Date.parse(n.slice(0,13) + ":00:00Z") >= this.now() - 7200000);
      if (this.seen.has(batch.batchId) || recent.some(n => readFileSync(join(this.directory, n), "utf8").includes(`"batchId":"${batch.batchId}"`))) return { accepted: 0, reason: "duplicate" as const };
      const line = JSON.stringify({ ...batch, events, receivedAt: this.now() }) + "\n", bytes = Buffer.byteLength(line) + 1;
      const previous = this.files().filter(n => n.startsWith(hour)).at(-1);
      const archived = this.summaries().days.find(d => d.date === hour.slice(0,10))?.through;
      const last = previous ? logKey(previous) : archived?.startsWith(hour) ? archived : null;
      let name = previous ?? `${hour}-${String(last ? Number(last.slice(14,20)) + 1 : 0).padStart(6,"0")}.jsonl`;
      if (previous && statSync(join(this.directory, previous)).size + bytes > MAX_HOUR_BYTES) name = `${hour}-${String(Number(logKey(previous).slice(14,20)) + 1).padStart(6,"0")}.jsonl`;
      // Rotate instead of suspending collection when the raw log budget fills.
      let total = state.bytes;
      for (const old of this.files()) {
        if (total + bytes <= MAX_BYTES) break;
        const size = statSync(join(this.directory, old)).size; this.retire(old); total -= size;
      }
      const file = join(this.directory, name);
      const separator = existsSync(file) && statSync(file).size > 0 && !readFileSync(file, "utf8").endsWith("\n") ? "\n" : "";
      appendFileSync(file, separator + line, { mode: 0o600 });
      this.stateValue = { ...this.stateValue, lastSavedAt: this.now() }; this.atomic("state.json", this.stateValue);
      this.seen.add(batch.batchId);
      if (this.seen.size > 2000) this.seen.delete(this.seen.values().next().value!);
      return { accepted: events.length, reason: "saved" as const };
    } catch { this.fail(); return { accepted: 0, reason: "unavailable" as const }; }
  }
  report(): UxReport {
    const state = this.state(), batches: Batch[] = [], seen = new Set<string>();
    const archived = state.storageAvailable ? this.summaries().days : [];
    if (state.storageAvailable) for (const file of this.files().filter(n => logKey(n) > (archived.find(d => d.date === n.slice(0,10))?.through ?? ""))) for (const line of readFileSync(join(this.directory, file), "utf8").split("\n")) {
      if (!line) continue;
      try { const batch = storedBatch.parse(JSON.parse(line)); if (batch.receivedAt >= this.now() - UX_RETENTION_MS && !seen.has(batch.batchId)) { seen.add(batch.batchId); batches.push(batch); } } catch { /* An interrupted append must not hide other complete batches. */ }
    }
    const events = batches.flatMap(b => b.events.map(e => ({ ...e, client: b.clientId.slice(0, 8), build: b.build, stream: `${b.recordingId}:${b.clientId}` }))).sort((a, b) => a.at - b.at);
    const actions = new Map<string, UxReport["actions"][number]>(), transitions = new Map<string, UxReport["transitions"][number]>();
    const results = new Map<string, { action: UxEvent["action"]; ok: number; errors: number; times: number[] }>();
    const pages = new Map<string, UxPage>(), clicks = new Map<string, typeof events[number]>();
    let repeats = 0;
    for (const e of events) {
      if (e.kind === "view") {
        const from = pages.get(e.stream);
        if (from && from !== e.page) { const key = `${from}:${e.page}`, item = transitions.get(key) ?? { from, to: e.page, count: 0 }; item.count++; transitions.set(key, item); }
        pages.set(e.stream, e.page);
      }
      if (e.kind === "click") {
        const key = `${e.page}:${e.action}`, item = actions.get(key) ?? { page: e.page, action: e.action, count: 0 }; item.count++; actions.set(key, item);
        const previous = clicks.get(e.stream);
        if (previous && previous.page === e.page && previous.action === e.action && e.at - previous.at < 750 && Math.abs((previous.x ?? 0) - (e.x ?? 0)) < .03 && Math.abs((previous.y ?? 0) - (e.y ?? 0)) < .03) repeats++;
        clicks.set(e.stream, e);
      }
      if (e.kind === "result") { const item = results.get(e.action) ?? { action: e.action, ok: 0, errors: 0, times: [] }; e.outcome === "ok" ? item.ok++ : item.errors++; item.times.push(e.durationMs ?? 0); results.set(e.action, item); }
    }
    const daily = new Map(archived.map(({ through: _through, ...day }) => [day.date, day]));
    for (const batch of batches) {
      const date = new Date(batch.receivedAt).toISOString().slice(0,10), day = daily.get(date) ?? emptyDay(date);
      countEvents(day, batch.events); daily.set(date, day);
    }
    return { state, daily: [...daily.values()].sort((a,b) => b.date.localeCompare(a.date)), events: events.length, clients: new Set(events.map(e => e.stream)).size, builds: [...new Set(events.map(e => e.build))], actions: [...actions.values()].sort((a,b) => b.count-a.count), transitions: [...transitions.values()].sort((a,b) => b.count-a.count).slice(0,50), results: [...results.values()].map(r => ({ action: r.action, ok: r.ok, errors: r.errors, medianMs: r.times.sort((a,b) => a-b)[Math.floor(r.times.length/2)] ?? 0 })), rapidRepeatClicks: repeats,
      timeline: events.filter(e => !["pointer", "scroll"].includes(e.kind)).slice(-200).reverse().map(({ stream: _stream, ...e }) => e) };
  }
}
