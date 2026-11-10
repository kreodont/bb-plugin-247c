import { afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { fixture } from "./test-support.js";
import { SourceSyncRuntime, SourceSyncStore } from "./source-sync.js";
import { hourlyUpdateId, hourlyUpdateSlot, quickSourceUpdate, scheduledSourceUpdate, UPDATE_SCHEDULE } from "./source-schedule.js";
import { syncStartSchema } from "./contracts.js";
import * as collector from "./source-collector.js";

const athens = { timeZone: "Europe/Athens", updateStartHour: 8, updateEndHour: 20 };
const hosts: Awaited<ReturnType<typeof fixture>>[] = [];
afterEach(async () => { for (const f of hosts.splice(0)) await f.harness.lifecycle.dispose(); vi.restoreAllMocks(); vi.useRealTimers(); });
async function setup() {
  const f = await fixture(); hosts.push(f);
  const sync = new SourceSyncRuntime(f.bb, f.repo), source = syncStartSchema.parse({ requestId: randomUUID(), since: null, request: f.startInput("unused", 0).request });
  source.request.model = "gpt-6-astra"; source.request.reasoningLevel = "max";
  const first = sync.store.insert(source); sync.store.save({ ...first, status: "completed", finishedAt: first.startedAt });
  return { f, sync, source, first };
}

it("starts a manual incremental check with saved settings even outside the schedule", async () => {
  const { sync, source, first } = await setup();
  const start = vi.spyOn(sync, "start").mockImplementation(async (input, options) => sync.store.insert(input, undefined, options?.incremental));
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-09-20T23:37:00Z"));
  const checkpoint = "2026-09-18T17:00:00.000Z";
  sync.repo.db.prepare("INSERT OR REPLACE INTO source_sync_checkpoints VALUES (?,?)").run("gmail", checkpoint);
  const requestId = randomUUID();
  const result = await quickSourceUpdate(sync, requestId, { syncProvider: "codex", syncModel: "gpt-5.6-sol", syncReasoningLevel: "medium" });
  expect(result).toMatchObject({ alreadyRunning: false, run: { id: requestId, manualSince: null, ranges: { gmail: { since: checkpoint } } } });
  expect(start).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ since: null, request: expect.objectContaining({ ...source.request, model: "gpt-5.6-sol", reasoningLevel: "medium", input: expect.any(Array) }) }), { incremental: true });
  expect(start.mock.calls[0][0].request.input[0]).toMatchObject({ text: expect.stringContaining("Manual 247C update check") });
  expect(sync.store.request(requestId).incremental).toBe(true);
  expect(sync.store.request(first.id).input).toEqual(source);
  expect(await quickSourceUpdate(sync, requestId, {})).toEqual(result);
  expect(await quickSourceUpdate(sync, randomUUID(), {})).toEqual({ ...result, alreadyRunning: true });
  sync.store.save({ ...result.run, status: "completed", finishedAt: result.run.startedAt });
  expect((await quickSourceUpdate(sync, requestId, {})).run.status).toBe("completed");
  expect(start).toHaveBeenCalledOnce();
});

it("asks for initial setup and ignores external imports when choosing a saved launch", async () => {
  const { sync, first } = await setup();
  sync.repo.db.prepare("UPDATE source_sync_runs SET request_json=? WHERE id=?").run(JSON.stringify({ externalImport: { path: "bundle.json", sha256: "test" } }), first.id);
  const start = vi.spyOn(sync, "start");
  await expect(quickSourceUpdate(sync, randomUUID(), {})).rejects.toThrow("Run a Custom check first");
  expect(start).not.toHaveBeenCalled();
});

it("returns the running check after a start race and exposes genuine launch failures", async () => {
  const { sync, source } = await setup();
  const start = vi.spyOn(sync, "start").mockRejectedValue(new Error("Provider unavailable"));
  await expect(quickSourceUpdate(sync, randomUUID(), {})).rejects.toThrow("Provider unavailable");
  start.mockImplementation(async () => { sync.store.insert({ ...source, requestId: randomUUID() }); throw new Error("Already running"); });
  expect(await quickSourceUpdate(sync, randomUUID(), {})).toEqual({ run: sync.store.active()[0], alreadyRunning: true });
});

it("keeps the configured external updater authoritative for quick checks", async () => {
  const { f, sync } = await setup();
  await f.harness.behavior.setSettings({ sourceUpdaterProjectId: "proj_updater", sourceUpdaterAutomationId: "source-check" });
  await expect(f.harness.behavior.callRpc("syncQuickStart", { requestId: randomUUID() })).rejects.toThrow("A source updater automation is configured");
  expect(sync.store.state().runs).toHaveLength(1);
});

it("selects exactly 08 through 20 every day in the configured zone, including winter and DST dates", () => {
  for (const day of ["2026-09-11", "2026-12-11", "2026-10-25", "2027-03-28"]) {
    const selected = [];
    for (let hour = 0; hour < 24; hour++) {
      const slot = hourlyUpdateSlot(new Date(`${day}T${String(hour).padStart(2, "0")}:00:00Z`));
      if (slot) selected.push(Number(slot.slice(-2)));
    }
    expect(selected).toEqual([8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
  }
  expect(hourlyUpdateSlot(new Date("2026-09-11T05:00:30Z"), athens)).toBe("2026-09-11T08");
  expect(hourlyUpdateSlot(new Date("2026-09-11T05:01:00Z"), athens)).toBeNull();
  expect(hourlyUpdateSlot(new Date("2026-12-11T06:00:00Z"), athens)).toBe("2026-12-11T08");
});

it("skips local weekends, including overnight windows and UTC date boundaries, only when enabled", () => {
  const schedule = { timeZone: "Europe/Athens", updateStartHour: 0, updateEndHour: 23, updateWeekdaysOnly: true };
  expect(hourlyUpdateSlot(new Date("2026-09-18T20:00:00Z"), schedule)).toBe("2026-09-18T23");
  expect(hourlyUpdateSlot(new Date("2026-09-18T21:00:00Z"), schedule)).toBeNull();
  expect(hourlyUpdateSlot(new Date("2026-09-19T09:00:00Z"), schedule)).toBeNull();
  expect(hourlyUpdateSlot(new Date("2026-09-20T20:00:00Z"), schedule)).toBeNull();
  expect(hourlyUpdateSlot(new Date("2026-09-20T21:00:00Z"), schedule)).toBe("2026-09-21T00");
  expect(hourlyUpdateSlot(new Date("2026-09-19T09:00:00Z"), { ...schedule, updateWeekdaysOnly: false })).toBe("2026-09-19T12");
  const overnight = { ...schedule, timeZone: "America/Los_Angeles", updateStartHour: 22, updateEndHour: 3 };
  expect(hourlyUpdateSlot(new Date("2026-09-19T05:00:00Z"), overnight)).toBe("2026-09-18T22");
  expect(hourlyUpdateSlot(new Date("2026-09-19T07:00:00Z"), overnight)).toBeNull();
  expect(hourlyUpdateSlot(new Date("2026-10-25T06:00:00Z"), schedule)).toBeNull();
});

it("leaves source checkpoints untouched over the weekend and resumes Friday's interval on Monday", async () => {
  const { sync } = await setup();
  const checkpoint = "2026-09-18T17:00:00.000Z";
  for (const source of ["gmail", "slack", "jira"]) sync.repo.db.prepare("INSERT OR REPLACE INTO source_sync_checkpoints VALUES (?,?)").run(source, checkpoint);
  const before = sync.store.checkpoints(), start = vi.spyOn(sync, "start").mockImplementation(async input => sync.store.insert(input));
  const schedule = { timeZone: "Europe/Athens", updateStartHour: 8, updateEndHour: 20, updateWeekdaysOnly: true };
  for (const date of ["2026-09-19T05:00:00Z", "2026-09-20T17:00:00Z"]) expect(await scheduledSourceUpdate(sync, async () => true, new Date(date), schedule)).toBeNull();
  expect(start).not.toHaveBeenCalled(); expect(sync.store.checkpoints()).toEqual(before);
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-09-21T05:00:00Z"));
  const id = await scheduledSourceUpdate(sync, async () => true, new Date(), schedule);
  expect(start).toHaveBeenCalledOnce();
  for (const range of Object.values(sync.store.run(id!).ranges)) expect(range.since).toBe(checkpoint);
});

it("persists the weekday setting across reloads without preventing manual weekend checks", async () => {
  const { f, source } = await setup();
  const collect = vi.spyOn(collector, "collectSources").mockRejectedValue(new Error("Fixture collector finished"));
  await f.harness.behavior.setSettings({ hourlyUpdates: true, updateWeekdaysOnly: true }); await f.reload();
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-09-19T05:00:00Z"));
  await f.harness.behavior.runSchedule(UPDATE_SCHEDULE);
  expect(new SourceSyncStore(f.repo).state().runs).toHaveLength(1); expect(collect).not.toHaveBeenCalled();
  await f.harness.behavior.callRpc("syncStart", { ...source, requestId: randomUUID() });
  expect(new SourceSyncStore(f.repo).state().runs).toHaveLength(2);
  await vi.waitFor(() => expect(collect).toHaveBeenCalledOnce());
});

it("reuses the last successful execution settings and resumes source checkpoints", async () => {
  const { f, sync } = await setup();
  const start = vi.spyOn(sync, "start").mockImplementation(async input => sync.store.insert(input));
  const at = new Date("2026-09-11T05:00:00Z");
  const id = await scheduledSourceUpdate(sync, async () => true, at, athens);
  expect(id).toBe(hourlyUpdateId("2026-09-11T08")); expect(start).toHaveBeenCalledOnce();
  expect(start.mock.calls[0][0]).toMatchObject({ since: null, request: { providerId: "codex", model: "gpt-6-astra", reasoningLevel: "max", permissionMode: "accept-edits" } });
  const run = sync.store.run(id!); sync.store.save({ ...run, status: "completed", finishedAt: run.startedAt });
  await f.reload();
  const reloaded = new SourceSyncRuntime(f.bb, f.repo);
  expect(await scheduledSourceUpdate(reloaded, async () => true, at, athens)).toBeNull();
  expect(new SourceSyncStore(f.repo).state().runs).toHaveLength(2);
});

it("does not launch when disabled, outside the window, or when a manual check is active", async () => {
  const { sync, source } = await setup(); const start = vi.spyOn(sync, "start");
  const at = new Date("2026-09-11T05:00:00Z");
  expect(await scheduledSourceUpdate(sync, async () => false, at, athens)).toBeNull();
  expect(await scheduledSourceUpdate(sync, async () => true, new Date("2026-09-11T18:00:00Z"), athens)).toBeNull();
  sync.store.insert({ ...source, requestId: randomUUID() });
  expect(await scheduledSourceUpdate(sync, async () => true, at, athens)).toBeNull(); expect(start).not.toHaveBeenCalled();
});

it("overrides only configured execution fields and preserves historical requests", async () => {
  const { sync, source, first } = await setup();
  const start = vi.spyOn(sync, "start").mockImplementation(async input => sync.store.insert(input));
  await scheduledSourceUpdate(sync, async () => true, new Date("2026-09-11T05:00:00Z"), {
    timeZone: "Europe/Athens", updateStartHour: 8, updateEndHour: 20,
    syncProvider: "  ", syncModel: " gpt-5.6-sol ", syncReasoningLevel: "medium",
  });
  const request = start.mock.calls[0][0].request;
  expect(request).toMatchObject({ ...source.request, model: "gpt-5.6-sol", reasoningLevel: "medium", input: expect.any(Array) });
  expect(request.executionInputSources).toMatchObject({ model: "explicit", reasoningLevel: "explicit" });
  expect(sync.store.request(first.id).input).toEqual(source);
});

it("keeps real start failures visible and safely skips a manual-start race", async () => {
  const { sync, source } = await setup(); const at = new Date("2026-09-11T05:00:00Z");
  const start = vi.spyOn(sync, "start").mockRejectedValue(new Error("Provider unavailable"));
  await expect(scheduledSourceUpdate(sync, async () => true, at, athens)).rejects.toThrow("Provider unavailable");
  start.mockImplementation(async () => { sync.store.insert({ ...source, requestId: randomUUID() }); throw new Error("Already running"); });
  expect(await scheduledSourceUpdate(sync, async () => true, at, athens)).toBeNull();
});

it("wires the native schedule to settings and launches the existing collector without changing tasks", async () => {
  const { f, first } = await setup();
  vi.spyOn(collector, "collectSources").mockRejectedValue(new Error("Fixture collector finished"));
  const before = f.repo.list(true);
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-09-11T05:00:00Z"));
  await f.harness.behavior.runSchedule(UPDATE_SCHEDULE); expect(new SourceSyncStore(f.repo).state().runs).toHaveLength(1);
  await f.harness.behavior.setSettings({ hourlyUpdates: true }); await f.harness.behavior.runSchedule(UPDATE_SCHEDULE);
  const runs = new SourceSyncStore(f.repo).state().runs;
  expect(runs).toHaveLength(2); expect(runs.find(r => r.id !== first.id)?.model).toBe("gpt-6-astra");
  expect(f.repo.list(true)).toEqual(before);
});

it("uses current hourly model preferences after a reload instead of inheriting the last run's model", async () => {
  const { f, first, source } = await setup();
  vi.spyOn(collector, "collectSources").mockRejectedValue(new Error("Fixture collector finished"));
  await f.harness.behavior.setSettings({ hourlyUpdates: true, syncProvider: "codex", syncModel: "gpt-5.6-sol", syncReasoningLevel: "medium" });
  await f.reload();
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-09-11T05:00:00Z"));
  await f.harness.behavior.runSchedule(UPDATE_SCHEDULE);
  const store = new SourceSyncStore(f.repo), next = store.state().runs.find(run => run.id !== first.id)!;
  expect(next.model).toBe("gpt-5.6-sol");
  expect(store.request(next.id).input?.request).toMatchObject({ providerId: "codex", model: "gpt-5.6-sol", reasoningLevel: "medium" });
  expect(store.request(first.id).input).toEqual(source);
});

 it("uses configured time zones and inclusive overnight hour windows", () => {
  const schedule = { timeZone: "America/Los_Angeles", updateStartHour: 22, updateEndHour: 3 };
  expect(hourlyUpdateSlot(new Date("2026-09-15T05:00:00Z"), schedule)).toBe("2026-09-14T22");
  expect(hourlyUpdateSlot(new Date("2026-09-15T10:00:00Z"), schedule)).toBe("2026-09-15T03");
  expect(hourlyUpdateSlot(new Date("2026-09-15T11:00:00Z"), schedule)).toBeNull();
  expect(hourlyUpdateSlot(new Date("2026-09-15T05:01:00Z"), schedule)).toBeNull();
});
