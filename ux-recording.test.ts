import { afterEach, expect, it } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  expect(readdirSync(f.directory)).toEqual(["state.json"]);
});
it("expires both recording permission and files without requiring another event", () => {
  const f = setup(); f.store.control("start"); f.store.record(f.batch());
  f.advance(UX_RETENTION_MS + 1); f.store.sweep(true);
  expect(f.store.state().enabled).toBe(false); expect(f.store.report().events).toBe(0);
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
it("caps storage and fails closed when local storage is unavailable", () => {
  const f = setup(); f.store.control("start"); writeFileSync(join(f.directory, "2026-10-02T12.jsonl"), " ".repeat(512 * 1024));
  expect(f.store.record(f.batch()).reason).toBe("full");
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
