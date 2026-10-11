import { afterEach, expect, it } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { UxRecording } from "./ux-recording.js";
import { UX_BUILD, UX_RETENTION_MS, uxBatchSchema } from "./ux-contracts.js";
import { fixture } from "./test-support.js";

const folders: string[] = [];
afterEach(() => { for (const p of folders.splice(0)) rmSync(p, { recursive: true, force: true }); });
function setup() {
  const directory = mkdtempSync(join(tmpdir(), "247c-ux-test-")); folders.push(directory);
  let now = Date.parse("2026-10-02T12:00:00Z");
  const store = new UxRecording(directory, () => now);
  const batch = () => uxBatchSchema.parse({ recordingId: store.state().recordingId ?? randomUUID(), batchId: randomUUID(), clientId: randomUUID(), build: UX_BUILD, events: [{ at: now, kind: "click", page: "tasks", action: "task-open", x: .5, y: .25 }] });
  return { store, directory, batch, advance: (ms: number) => { now += ms; }, now: () => now };
}
it("starts disabled, persists opt-in, deduplicates retries across restart and rejects stale clients after pause/clear", () => {
  const f = setup(); expect(f.store.state().enabled).toBe(false); expect(f.store.record(f.batch()).reason).toBe("paused");
  f.store.control("start"); const batch = f.batch();
  expect(f.store.record(batch)).toEqual({ accepted: 1, reason: "saved" });
  const restarted = new UxRecording(f.directory, f.now);
  expect(restarted.state().enabled).toBe(true); expect(restarted.record(batch).reason).toBe("duplicate");
  restarted.control("pause"); expect(restarted.record({ ...batch, batchId: randomUUID() }).reason).toBe("paused");
  restarted.control("start"); expect(restarted.record({ ...batch, batchId: randomUUID() }).reason).toBe("paused");
  restarted.control("clear"); expect(restarted.report().events).toBe(0); expect(restarted.state().enabled).toBe(false);
  expect(readdirSync(f.directory)).toEqual(["state.json", "summaries.json"]);
  expect(restarted.state().controls?.at(-1)?.reason).toBe("user-clear");
});
it("expires raw events while continuous opt-in and anonymous daily counts survive restart", () => {
  const f = setup(); f.store.control("start"); f.store.record(f.batch());
  f.advance(UX_RETENTION_MS + 1); f.store.sweep(true);
  expect(f.store.state().enabled).toBe(true); expect(f.store.report().events).toBe(0);
  expect(f.store.report().daily).toEqual([expect.objectContaining({ clicks: 1, events: 1 })]);
  const restarted = new UxRecording(f.directory, f.now);
  expect(restarted.state()).toMatchObject({ enabled: true, endsAt: null });
  expect(restarted.record(f.batch()).reason).toBe("saved");
  f.advance(90 * 86400000); f.store.sweep(true);
  expect(f.store.report().daily).toEqual([]);
  expect(readdirSync(f.directory).some(n => n.endsWith(".jsonl"))).toBe(false);
});
it("rejects page text, URLs, arbitrary actions, input values and notes outside explicit feedback", () => {
  const f = setup(); f.store.control("start"); const batch = f.batch();
  for (const extra of [{ text: "private chat" }, { url: "https://private.example" }, { value: "password" }, { action: "private task title" }, { note: "typed but not submitted" }]) {
    expect(() => f.store.record({ ...batch, events: [{ ...batch.events[0], ...extra }] } as never)).toThrow();
  }
  f.store.record({ ...batch, events: [{ ...batch.events[0], kind: "feedback", action: "feedback", note: "Too many clicks" }] });
  expect(f.store.report().timeline[0].note).toBe("Too many clicks");
});
it("separates clients, reports outcomes and handles an interrupted final line", () => {
  const f = setup(); f.store.control("start"); const batch = f.batch();
  f.store.record({ ...batch, events: [
    { at: f.now(), page: "tasks", action: "surface", kind: "view" },
    { at: f.now()+10, page: "thread", action: "surface", kind: "view" },
    { at: f.now()+20, page: "thread", action: "reported-save", kind: "result", outcome: "error", durationMs: 250 },
    { at: f.now()+30, page: "thread", action: "reported-save", kind: "result", outcome: "ok", durationMs: 450 },
  ] });
  f.store.record({ ...f.batch(), events: [{ at: f.now()+50, page: "day", action: "surface", kind: "view" }] });
  const file = join(f.directory, readdirSync(f.directory).find(n => n.endsWith("jsonl"))!);
  writeFileSync(file, readFileSync(file, "utf8") + '{"incomplete":');
  const report = f.store.report(); expect(report.events).toBe(5); expect(report.transitions).toEqual([{ from: "tasks", to: "thread", count: 1 }]);
  expect(report.results).toEqual([{ action: "reported-save", ok: 1, errors: 1, medianMs: 450 }]);
});
it("rotates full chunks without stopping and reports unavailable storage", () => {
  const f = setup(); f.store.control("start"); writeFileSync(join(f.directory, "2026-10-02T12.jsonl"), " ".repeat(512 * 1024));
  expect(f.store.record(f.batch()).reason).toBe("saved");
  expect(f.store.state().enabled).toBe(true);
  const bad = join(f.directory, "not-a-directory"); writeFileSync(bad, "x"); const store = new UxRecording(bad);
  expect(store.state().storageAvailable).toBe(false); expect(store.record(f.batch()).reason).toBe("unavailable");
});

it("registers local recording RPCs without starting agents or changing task data and keeps consent on reload", async () => {
  const f = await fixture();
  try {
    const call = f.harness.behavior.callRpc.bind(f.harness.behavior);
    const before = f.repo.list();
    expect(await call("uxState", {})).toMatchObject({ enabled: false, storageAvailable: true });
    const state = await call("uxControl", { action: "start" }) as { recordingId: string };
    expect(await call("uxRecord", { recordingId: state.recordingId, batchId: randomUUID(), clientId: randomUUID(), build: UX_BUILD, events: [{ at: Date.now(), page: "day", action: "day-edit", kind: "result", outcome: "ok", durationMs: 10 }] })).toEqual({ accepted: 1, reason: "saved" });
    expect(await call("uxReport", {})).toMatchObject({ events: 1 });
    expect(f.repo.list()).toEqual(before);
    expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
    await f.reload();
    expect(await f.harness.behavior.callRpc("uxState", {})).toMatchObject({ enabled: true, recordingId: state.recordingId });
  } finally { await f.harness.lifecycle.dispose(); }
});

it("preserves timed consent from old installations and never resumes an explicit pause", () => {
  const f = setup(), recordingId = randomUUID();
  writeFileSync(join(f.directory, "state.json"), JSON.stringify({ recordingId, endsAt: f.now() + 60000 }));
  const migrated = new UxRecording(f.directory, f.now);
  expect(migrated.state()).toMatchObject({ enabled: true, recordingId });
  f.advance(60001);
  expect(migrated.state()).toMatchObject({ enabled: false, status: "expired" });
  migrated.control("start");
  expect(migrated.state()).toMatchObject({ enabled: true, endsAt: null });
  migrated.control("pause");
  expect(new UxRecording(f.directory, f.now).state()).toMatchObject({ enabled: false, status: "paused", controls: expect.arrayContaining([expect.objectContaining({ reason: "user-pause" })]) });
});

it("recovers from a temporary append failure without losing opt-in or duplicating the retry", () => {
  const f = setup(); const state = f.store.control("start"), batch = f.batch();
  mkdirSync(join(f.directory, "state.json.tmp"));
  expect(f.store.record(batch).reason).toBe("unavailable"); // Append succeeds, state commit fails.
  expect(f.store.state()).toMatchObject({ enabled: false, recordingId: state.recordingId, storageAvailable: false });
  rmSync(join(f.directory, "state.json.tmp"), { recursive: true });
  expect(f.store.record(batch).reason).toBe("duplicate");
  expect(f.store.report()).toMatchObject({ events: 1, state: { enabled: true, recordingId: state.recordingId } });
  expect(f.store.state().controls?.map(c => c.reason)).toEqual(["start", "storage-error", "storage-recovered"]);
});

it("rotates a full raw budget, keeps daily counts once, and continues after restart", () => {
  const f = setup(); f.store.control("start");
  const old = f.batch(); f.store.record(old);
  const first = readdirSync(f.directory).find(n => n.endsWith("jsonl"))!;
  const content = readFileSync(join(f.directory, first), "utf8");
  writeFileSync(join(f.directory, first), content + " ".repeat(16 * 1024 * 1024));
  expect(f.store.record(f.batch()).reason).toBe("saved");
  expect(f.store.state().bytes).toBeLessThan(16 * 1024 * 1024);
  expect(f.store.report().daily?.[0]).toMatchObject({ clicks: 2, events: 2 });
  const restarted = new UxRecording(f.directory, f.now);
  expect(restarted.record(f.batch()).reason).toBe("saved");
  expect(restarted.report().daily?.[0]).toMatchObject({ clicks: 3, events: 3 });
  const summary = readFileSync(join(f.directory, "summaries.json"), "utf8");
  expect(summary).not.toContain(old.clientId); expect(summary).not.toContain(old.batchId);
});

it("keeps legacy client builds valid and deduplicates across hour rollover and restart", () => {
  const f = setup(); f.store.control("start"); f.advance(3599000);
  const batch = { ...f.batch(), build: "2026-10-04.1" };
  f.store.record(batch); f.advance(2000);
  const restarted = new UxRecording(f.directory, f.now);
  expect(restarted.record(batch).reason).toBe("duplicate");
  expect(restarted.record({ ...f.batch(), build: "0.5.999" }).reason).toBe("saved");
  expect(restarted.report().events).toBe(2);
});

it("does not double count if a retired file remains after its summary was committed", () => {
  const f = setup(); f.store.control("start"); f.store.record(f.batch());
  const file = readdirSync(f.directory).find(n => n.endsWith("jsonl"))!, text = readFileSync(join(f.directory, file), "utf8");
  f.advance(UX_RETENTION_MS + 1); f.store.sweep(true);
  writeFileSync(join(f.directory, file), text); // Simulate crash before unlink.
  expect(new UxRecording(f.directory, f.now).report().daily?.[0]).toMatchObject({ clicks: 1, events: 1 });
});

it("appends a valid batch after an interrupted line and fails closed for damaged consent", () => {
  const f = setup(); f.store.control("start"); f.store.record(f.batch());
  const file = join(f.directory, readdirSync(f.directory).find(n => n.endsWith("jsonl"))!);
  writeFileSync(file, readFileSync(file, "utf8") + '{"partial":');
  expect(f.store.record(f.batch()).reason).toBe("saved"); expect(f.store.report().events).toBe(2);
  writeFileSync(join(f.directory, "state.json"), '{"recordingId":');
  const restarted = new UxRecording(f.directory, f.now);
  expect(restarted.state()).toMatchObject({ enabled: false, storageAvailable: false });
  expect(readFileSync(join(f.directory, "state.json"), "utf8")).toBe('{"recordingId":');
});
