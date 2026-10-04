import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { UX_BUILD, UX_RETENTION_MS, uxBatchSchema, type UxState, type UxReport, type UxEvent, type UxPage } from "./ux-contracts.js";

const stateSchema = z.object({ recordingId: z.uuid().nullable(), endsAt: z.number().nullable() }).strict();
const storedBatch = uxBatchSchema.extend({ receivedAt: z.number(), build: z.string().min(1).max(64) });
type Batch = z.infer<typeof storedBatch>;
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_HOUR_BYTES = 512 * 1024;
const logName = /^\d{4}-\d{2}-\d{2}T\d{2}\.jsonl$/;

export class UxRecording {
  private available = true;
  private lastSweep = 0;
  private seen = new Set<string>();
  private stateValue: z.infer<typeof stateSchema> = { recordingId: null, endsAt: null };
  constructor(readonly directory: string, private now = () => Date.now()) {
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      chmodSync(directory, 0o700);
      const file = join(directory, "state.json");
      if (existsSync(file)) this.stateValue = stateSchema.parse(JSON.parse(readFileSync(file, "utf8")));
      this.sweep(true);
    } catch { this.available = false; }
  }
  private files() { return readdirSync(this.directory).filter(n => logName.test(n)).sort(); }
  private bytes() { return this.files().reduce((n, file) => n + statSync(join(this.directory, file)).size, 0); }
  sweep(force = false) {
    if (!this.available || !force && this.now() - this.lastSweep < 60000) return;
    try {
      const cutoff = this.now() - UX_RETENTION_MS;
      for (const file of this.files()) if (Date.parse(file.slice(0, 13) + ":00:00Z") <= cutoff) unlinkSync(join(this.directory, file));
      this.lastSweep = this.now();
    } catch { this.available = false; }
  }
  state(): UxState {
    this.sweep();
    let bytes = 0;
    try { if (this.available) bytes = this.bytes(); } catch { this.available = false; }
    return { enabled: this.available && !!this.stateValue.recordingId && (this.stateValue.endsAt ?? 0) > this.now(), ...this.stateValue, bytes, storageAvailable: this.available, retentionDays: 7, build: UX_BUILD };
  }
  control(action: "start" | "pause" | "clear") {
    if (!this.available) throw new Error("UX recording storage is unavailable. Task data is unaffected.");
    this.stateValue = action === "start" ? { recordingId: randomUUID(), endsAt: this.now() + UX_RETENTION_MS } : { recordingId: null, endsAt: null };
    const temp = join(this.directory, "state.tmp");
    writeFileSync(temp, JSON.stringify(this.stateValue), { mode: 0o600 });
    renameSync(temp, join(this.directory, "state.json"));
    if (action === "clear") { for (const file of this.files()) unlinkSync(join(this.directory, file)); this.seen.clear(); }
    return this.state();
  }
  record(input: z.infer<typeof uxBatchSchema>) {
    const batch = uxBatchSchema.parse(input), state = this.state();
    if (!state.storageAvailable) return { accepted: 0, reason: "unavailable" as const };
    if (!state.enabled || state.recordingId !== batch.recordingId) return { accepted: 0, reason: "paused" as const };
    const events = batch.events.filter(e => e.at <= this.now() + 60000 && e.at >= this.now() - 3600000);
    const file = join(this.directory, new Date(this.now()).toISOString().slice(0, 13) + ".jsonl");
    try {
      if (this.seen.has(batch.batchId) || existsSync(file) && readFileSync(file, "utf8").includes(`"batchId":"${batch.batchId}"`)) return { accepted: 0, reason: "duplicate" as const };
      const line = JSON.stringify({ ...batch, events, receivedAt: this.now() }) + "\n";
      const bytes = Buffer.byteLength(line);
      if (state.bytes + bytes > MAX_BYTES || (existsSync(file) ? statSync(file).size : 0) + bytes > MAX_HOUR_BYTES) return { accepted: 0, reason: "full" as const };
      appendFileSync(file, line, { mode: 0o600 });
      this.seen.add(batch.batchId);
      if (this.seen.size > 2000) this.seen.delete(this.seen.values().next().value!);
      return { accepted: events.length, reason: "saved" as const };
    } catch { this.available = false; return { accepted: 0, reason: "unavailable" as const }; }
  }
  report(): UxReport {
    const state = this.state(), batches: Batch[] = [], seen = new Set<string>();
    if (state.storageAvailable) for (const file of this.files()) for (const line of readFileSync(join(this.directory, file), "utf8").split("\n")) {
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
    return { state, events: events.length, clients: new Set(events.map(e => e.stream)).size, builds: [...new Set(events.map(e => e.build))], actions: [...actions.values()].sort((a,b) => b.count-a.count).slice(0, 50), transitions: [...transitions.values()].sort((a,b) => b.count-a.count).slice(0,50), results: [...results.values()].map(r => ({ action: r.action, ok: r.ok, errors: r.errors, medianMs: r.times.sort((a,b) => a-b)[Math.floor(r.times.length/2)] ?? 0 })), rapidRepeatClicks: repeats,
      timeline: events.filter(e => !["pointer", "scroll"].includes(e.kind)).slice(-200).reverse().map(({ stream: _stream, ...e }) => e) };
  }
}
