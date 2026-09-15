import { afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { fixture } from "./test-support.js";
import { SourceSyncRuntime, SourceSyncStore } from "./source-sync.js";
import { hourlyUpdateId, hourlyUpdateSlot, scheduledSourceUpdate, UPDATE_SCHEDULE } from "./source-schedule.js";
import { syncStartSchema } from "./contracts.js";
import * as collector from "./source-collector.js";

const hosts: Awaited<ReturnType<typeof fixture>>[] = [];
afterEach(async () => { for (const f of hosts.splice(0)) await f.harness.lifecycle.dispose(); vi.restoreAllMocks(); vi.useRealTimers(); });
async function setup() {
  const f = await fixture(); hosts.push(f);
  const sync = new SourceSyncRuntime(f.bb, f.repo), source = syncStartSchema.parse({ requestId: randomUUID(), since: null, request: f.startInput("unused", 0).request });
  source.request.model = "gpt-6-astra"; source.request.reasoningLevel = "max";
  const first = sync.store.insert(source); sync.store.save({ ...first, status: "completed", finishedAt: first.startedAt });
  return { f, sync, source, first };
}

it("selects exactly 08 through 20 every day in Athens, including winter and DST dates", () => {
  for (const day of ["2026-09-11", "2026-12-11", "2026-10-25", "2027-03-28"]) {
    const selected = [];
    for (let hour = 0; hour < 24; hour++) {
      const slot = hourlyUpdateSlot(new Date(`${day}T${String(hour).padStart(2, "0")}:00:00Z`));
      if (slot) selected.push(Number(slot.slice(-2)));
    }
    expect(selected).toEqual([8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
  }
  expect(hourlyUpdateSlot(new Date("2026-09-11T05:00:30Z"))).toBe("2026-09-11T08");
  expect(hourlyUpdateSlot(new Date("2026-09-11T05:01:00Z"))).toBeNull();
  expect(hourlyUpdateSlot(new Date("2026-12-11T06:00:00Z"))).toBe("2026-12-11T08");
});

it("reuses the last successful execution settings and resumes source checkpoints", async () => {
  const { f, sync } = await setup();
  const start = vi.spyOn(sync, "start").mockImplementation(async input => sync.store.insert(input));
  const at = new Date("2026-09-11T05:00:00Z");
  const id = await scheduledSourceUpdate(sync, async () => true, at);
  expect(id).toBe(hourlyUpdateId("2026-09-11T08")); expect(start).toHaveBeenCalledOnce();
  expect(start.mock.calls[0][0]).toMatchObject({ since: null, request: { providerId: "codex", model: "gpt-6-astra", reasoningLevel: "max", permissionMode: "accept-edits" } });
  const run = sync.store.run(id!); sync.store.save({ ...run, status: "completed", finishedAt: run.startedAt });
  await f.reload();
  const reloaded = new SourceSyncRuntime(f.bb, f.repo);
  expect(await scheduledSourceUpdate(reloaded, async () => true, at)).toBeNull();
  expect(new SourceSyncStore(f.repo).state().runs).toHaveLength(2);
});

it("does not launch when disabled, outside the window, or when a manual check is active", async () => {
  const { sync, source } = await setup(); const start = vi.spyOn(sync, "start");
  const at = new Date("2026-09-11T05:00:00Z");
  expect(await scheduledSourceUpdate(sync, async () => false, at)).toBeNull();
  expect(await scheduledSourceUpdate(sync, async () => true, new Date("2026-09-11T18:00:00Z"))).toBeNull();
  sync.store.insert({ ...source, requestId: randomUUID() });
  expect(await scheduledSourceUpdate(sync, async () => true, at)).toBeNull(); expect(start).not.toHaveBeenCalled();
});

it("keeps real start failures visible and safely skips a manual-start race", async () => {
  const { sync, source } = await setup(); const at = new Date("2026-09-11T05:00:00Z");
  const start = vi.spyOn(sync, "start").mockRejectedValue(new Error("Provider unavailable"));
  await expect(scheduledSourceUpdate(sync, async () => true, at)).rejects.toThrow("Provider unavailable");
  start.mockImplementation(async () => { sync.store.insert({ ...source, requestId: randomUUID() }); throw new Error("Already running"); });
  expect(await scheduledSourceUpdate(sync, async () => true, at)).toBeNull();
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

 it("uses configured time zones and inclusive overnight hour windows", () => {
  const schedule = { timeZone: "America/Los_Angeles", updateStartHour: 22, updateEndHour: 3 };
  expect(hourlyUpdateSlot(new Date("2026-09-15T05:00:00Z"), schedule)).toBe("2026-09-14T22");
  expect(hourlyUpdateSlot(new Date("2026-09-15T10:00:00Z"), schedule)).toBe("2026-09-15T03");
  expect(hourlyUpdateSlot(new Date("2026-09-15T11:00:00Z"), schedule)).toBeNull();
  expect(hourlyUpdateSlot(new Date("2026-09-15T05:01:00Z"), schedule)).toBeNull();
});
