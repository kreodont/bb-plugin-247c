import { afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { AgentTimeRuntime, dayStart, intervalDays, measuredIntervals, timeReceipt, type TimeReceipt } from "./agent-time.js";
import { DayPlanning, estimatedMinutes } from "./day-planning.js";
import { dayItemSchema } from "./day-contracts.js";
import { fixture } from "./test-support.js";
import { startSourceSync } from "./source-sync-test-support.js";
import { SourceSyncStore } from "./source-sync.js";
import { UPDATE_SCHEDULE } from "./source-schedule.js";

type Event = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["events"]["list"]>>[number];
const hosts: Awaited<ReturnType<typeof fixture>>[] = [];
afterEach(async () => { for (const f of hosts.splice(0)) await f.harness.lifecycle.dispose(); vi.restoreAllMocks(); vi.useRealTimers(); });
const at = Date.parse("2026-09-12T08:00:00Z"), date = "2026-09-12";
function r(seq: number, minute: number, kind: TimeReceipt["kind"], extra: Partial<TimeReceipt> = {}): TimeReceipt { return { seq, at: at + minute * 60000, turnId: "turn-a", kind, ...extra }; }
function event(threadId: string, seq: number, minute: number, type: "turn/started" | "turn/completed", turnId = "turn-a"): Event {
  return { id: `event-${seq}`, threadId, seq, createdAt: at + minute * 60000, scope: { kind: "turn", turnId }, type,
    data: type === "turn/started" ? { providerThreadId: "provider-session" } : { providerThreadId: "provider-session", status: "completed" } } as Event;
}
async function setup() {
  const f = await fixture(); hosts.push(f);
  const task = await f.create("Work context"), session = await f.harness.behavior.callRpc("start", { ...f.startInput(task.id, task.revision), criteria: [] }) as { workerThreadId: string };
  const days = new DayPlanning(f.repo, () => new Date("2026-09-12T20:00:00Z")), runtime = new AgentTimeRuntime(f.bb, days);
  const events = new Map<string, Event[]>([[session.workerThreadId, [event(session.workerThreadId, 1, 0, "turn/started"), event(session.workerThreadId, 2, 10, "turn/completed")]]]);
  f.harness.inspection.sdk.stub("threads.events.list", ({ threadId, afterSeq }) => (events.get(threadId) ?? []).filter(e => e.seq > Number(afterSeq ?? 0)).slice(0, 2));
  f.harness.inspection.sdk.stub("threads.list", (args: Parameters<BbPluginApi["sdk"]["threads"]["list"]>[0]) => {
    const { parentThreadId, archived, offset = 0, limit = 100 } = args ?? {};
    return [...f.threads.values()].filter(t => t.parentThreadId === parentThreadId && !!t.archivedAt === !!archived).slice(offset, offset + limit);
  });
  return { f, task, session, days, runtime, events };
}

it("subtracts overlapping approval waits once and excludes unfinished work and idle chat gaps", () => {
  const rows = [r(1, 0, "start"), r(2, 2, "block", { interaction: "a", blocked: true }), r(3, 3, "block", { interaction: "b", blocked: true }),
    r(4, 4, "block", { interaction: "a", blocked: false }), r(5, 6, "block", { interaction: "b", blocked: false }), r(6, 10, "end"),
    r(7, 120, "start", { turnId: "unfinished" })];
  expect(measuredIntervals([...rows, ...rows]).reduce((n, i) => n + i.end - i.start, 0) / 60000).toBe(6);
});

it("counts parallel embedded agents and distinct attempts, without a workflow duplicate", () => {
  const rows = [r(1, 0, "start"), r(2, 1, "start", { turnId: "child", parent: "call" }), r(3, 5, "end", { turnId: "child" }), r(4, 10, "end"),
    r(5, 10, "workflow", { parent: "call", agents: [{ key: "call:0:1", start: at + 60000, end: at + 300000 }] }),
    r(6, 15, "start"), r(7, 16, "end")];
  expect(measuredIntervals(rows).reduce((n, i) => n + i.end - i.start, 0) / 60000).toBe(15);
});

it.each([ ["2026-09-12", 24], ["2026-10-25", 25], ["2027-03-28", 23] ])("splits Athens days including DST: %s", (day, hours) => {
  const next = new Date(`${day}T12:00:00Z`); next.setUTCDate(next.getUTCDate() + 1);
  const endDate = next.toISOString().slice(0, 10), start = dayStart(String(day)), end = dayStart(endDate);
  expect((end - start) / 3600000).toBe(hours);
  const totals = intervalDays([{ key: "turn", start: end - 600000, end: end + 1200000 }], String(day), end + 3600000);
  expect([...totals]).toEqual([[day, 600000], [endDate, 1200000]]);
});

it("clips old work at the tracking date and does not turn a missing start into hours", () => {
  expect(measuredIntervals([r(2, 10, "end")])).toEqual([]);
  const start = dayStart(date);
  expect([...intervalDays([{ key: "old", start: start - 600000, end: start + 600000 }], date, start + 3600000)]).toEqual([[date, 600000]]);
});

it("normalizes provider pauses without retaining commands and ignores async plugin questions", () => {
  const base = event("thread", 3, 2, "turn/started");
  const blocked = { ...base, type: "system/interaction/lifecycle", data: { interaction: { id: "approval", origin: { kind: "provider", providerId: "codex", providerRequestId: "req" }, status: "pending", payload: { kind: "approval", subject: { command: "private command" } } } } } as Event;
  expect(timeReceipt(blocked)).toEqual(r(3, 2, "block", { interaction: "approval", blocked: true }));
  expect(JSON.stringify(timeReceipt(blocked))).not.toContain("private");
  const pluginQuestion = structuredClone(blocked) as Extract<Event, { type: "system/interaction/lifecycle" }>;
  pluginQuestion.data.interaction.origin = { kind: "plugin", pluginId: "example", rendererId: "question" };
  expect(timeReceipt(pluginQuestion)).toBeNull();
});

it("adds unplanned work once, includes hidden/archived children, and catches up after reload", async () => {
  const { f, task, session, days, runtime, events } = await setup();
  const before = f.repo.detail(task.id);
  const child = makeThreadResponse({ id: "child", parentThreadId: session.workerThreadId, visibility: "hidden", archivedAt: at + 3600000 });
  f.threads.set(child.id, child); events.set(child.id, [event(child.id, 1, 2, "turn/started"), event(child.id, 2, 7, "turn/completed")]);
  const result = await runtime.refresh(); expect(result.errors).toEqual([]);
  const item = days.taskItem(task.id, date)!;
  expect(item).toMatchObject({ plannedMinutes: 0, actualMinutes: 15, reportedMinutes: 19, reportedMode: "estimate" });
  await runtime.refresh(); expect(days.get(item.id)).toEqual(item); expect(days.history(item.id).items).toHaveLength(1);
  expect(f.repo.detail(task.id)).toEqual(before);
  await runtime.dispose(); await f.reload();
  f.harness.inspection.sdk.stub("threads.events.list", ({ threadId, afterSeq }) => (events.get(threadId) ?? []).filter(e => e.seq > Number(afterSeq ?? 0)).slice(0, 2));
  // The public RPC uses the same durable checkpoints after plugin reload.
  await f.harness.behavior.callRpc("agentTimeSync", {});
  expect(new DayPlanning(f.repo).get(item.id)).toEqual(item);
  events.get(session.workerThreadId)!.push(event(session.workerThreadId, 3, 120, "turn/started", "turn-b"), event(session.workerThreadId, 4, 125, "turn/completed", "turn-b"));
  await f.harness.behavior.callRpc("agentTimeSync", {});
  expect(new DayPlanning(f.repo).get(item.id).actualMinutes).toBe(20);
});

it("preserves plan, manual values including zero/blank, removals, and task status", async () => {
  const { task, days, runtime, events, session } = await setup();
  let item = days.add({ taskId: task.id, date, plannedMinutes: 90, reportedMinutes: 0, requestId: randomUUID() });
  await runtime.refresh(); item = days.get(item.id);
  expect(item).toMatchObject({ plannedMinutes: 90, actualMinutes: 10, reportedMinutes: 0, reportedMode: "manual" });
  item = days.edit({ id: item.id, revision: item.revision, reportedMinutes: null, requestId: randomUUID() });
  events.get(session.workerThreadId)!.push(event(session.workerThreadId, 3, 20, "turn/started", "b"), event(session.workerThreadId, 4, 25, "turn/completed", "b"));
  await runtime.refresh(); item = days.get(item.id); expect(item.reportedMinutes).toBeNull();
  item = days.edit({ id: item.id, revision: item.revision, removed: true, requestId: randomUUID() });
  await runtime.refresh(); expect(days.get(item.id)).toEqual(item);
});

it("keeps captured time on network/pagination failures and retries without losing receipts", async () => {
  const { f, task, days, runtime, events, session } = await setup();
  await runtime.refresh(); const before = days.taskItem(task.id, date)!;
  f.harness.inspection.sdk.stub("threads.events.list", () => { throw new Error("Host offline"); });
  expect((await runtime.refresh()).errors.join()).toContain("Host offline"); expect(days.get(before.id)).toEqual(before);
  const extra = event(session.workerThreadId, 3, 20, "turn/started", "new");
  f.harness.inspection.sdk.stub("threads.events.list", () => [extra]);
  expect((await runtime.refresh()).errors.join()).toContain("pagination");
  expect(f.repo.db.prepare("SELECT after_seq FROM agent_time_threads WHERE thread_id=?").get(session.workerThreadId)).toEqual({ after_seq: 2 });
  events.get(session.workerThreadId)!.push(extra, event(session.workerThreadId, 4, 30, "turn/completed", "new"));
  f.harness.inspection.sdk.stub("threads.events.list", ({ threadId, afterSeq }) => (events.get(threadId) ?? []).filter(e => e.seq > Number(afterSeq ?? 0)));
  expect((await runtime.refresh()).errors).toEqual([]); expect(days.get(before.id).actualMinutes).toBe(20);
});

it("serializes concurrent refreshes and stops safely during reload", async () => {
  const { f, runtime } = await setup();
  let release!: () => void;
  f.harness.inspection.sdk.stub("threads.list", () => new Promise(resolve => { release = () => resolve([]); }));
  const first = runtime.refresh(), second = runtime.refresh(); expect(first).toBe(second);
  const disposed = runtime.dispose(); release(); await expect(first).rejects.toThrow(); await disposed;
  expect(f.repo.db.prepare("SELECT count(*) AS n FROM day_items").get()).toEqual({ n: 0 });
});

it("enforces estimate caps in seconds, rounds within the cap, and locks a confirmed estimate", async () => {
  for (const actual of [0.001, 0.2, 1, 4.2, 80]) for (const factor of [1.01, 1.25, 2, 3]) {
    const value = estimatedMinutes(actual, factor); expect(value).toBeGreaterThan(actual); expect(value).toBeLessThanOrEqual(actual * 3);
  }
  const { task, days, runtime } = await setup(); await runtime.refresh(); let item = days.taskItem(task.id, date)!;
  const estimate = { id: item.id, revision: item.revision, factor: 2, reason: "Allow for checking the result; this is an estimate.", requestId: randomUUID() };
  item = days.estimate(estimate, "agent-time:test"); expect(days.estimate(estimate, "agent-time:test")).toEqual(item);
  expect(item.reportedMinutes).toBe(20);
  expect(() => days.estimate({ ...estimate, requestId: randomUUID(), revision: item.revision, factor: 3.1 }, "agent-time:test")).toThrow();
  expect(() => days.edit({ id: item.id, revision: item.revision, reportedMinutes: 31, requestId: randomUUID() })).toThrow(/3 × actual/);
  item = days.edit({ id: item.id, revision: item.revision, reportedMinutes: item.reportedMinutes, requestId: randomUUID() });
  expect(item.reportedLocked).toBe(true); expect(item.reportedMode).toBe("manual");
  expect(() => days.estimate({ ...estimate, requestId: randomUUID(), revision: item.revision }, "agent-time:test")).toThrow(/manual/);
  item = days.edit({ id: item.id, revision: item.revision, restoreAuto: "reported", requestId: randomUUID() });
  expect(item.reportedMode).toBe("estimate"); expect(item.reportedMinutes).toBe(13);
});

it("restricts estimate tools to the active analyst and leaves manual time tools restricted", async () => {
  const { f, days, runtime, task } = await setup(); await runtime.refresh(); const item = days.taskItem(task.id, date)!;
  const input = { requestId: randomUUID(), id: item.id, revision: item.revision, factor: 2, reason: "Estimated checking allowance." };
  await expect(f.harness.behavior.callAgentTool("c247_day_estimate", input, { threadId: "unrelated" })).rejects.toThrow(/active source analyst/);
  const { run } = await startSourceSync(f), ctx = { threadId: run.threadId! };
  expect(dayItemSchema.parse(JSON.parse(await f.harness.behavior.callAgentTool("c247_day_estimate", input, ctx) as string)).reportedMinutes).toBe(20);
  await expect(f.harness.behavior.callAgentTool("c247_time_edit", { id: item.id, revision: item.revision + 1, requestId: randomUUID(), reportedMinutes: 21 }, ctx)).rejects.toThrow(/cannot change manual/);
  new SourceSyncStore(f.repo).save({ ...run, status: "completed" });
  await expect(f.harness.behavior.callAgentTool("c247_day_review", {}, ctx)).rejects.toThrow(/active source analyst/);
});

it("keeps meeting actual equal to reported on manual correction and date moves", async () => {
  const { days } = await setup();
  const meeting = { key: "calendar:event", calendarId: "work@example.com", eventId: "meeting", occurrenceId: null, title: "Meeting", startAt: "2026-09-12T10:00:00Z", endAt: "2026-09-12T11:00:00Z", url: null, status: "confirmed" as const };
  days.mergeCalendar([meeting]); let item = days.calendarItems()[0]; expect(item.actualMinutes).toBe(60);
  item = days.edit({ id: item.id, revision: item.revision, reportedMinutes: 45, requestId: randomUUID() }); expect(item.actualMinutes).toBe(45);
  days.mergeCalendar([{ ...meeting, startAt: "2026-09-13T10:00:00Z", endAt: "2026-09-13T11:00:00Z" }]);
  expect(days.report({ date, period: "day" }).totals).toMatchObject({ actualMinutes: 45, reportedMinutes: 45 });
  expect(days.report({ date: "2026-09-13", period: "day" }).totals).toMatchObject({ actualMinutes: 0, reportedMinutes: 0 });
});

it("reconciles the day on an hourly check even when a source run is already active", async () => {
  const { f, task, days } = await setup(); await startSourceSync(f);
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-09-12T09:00:00Z"));
  await f.harness.behavior.runSchedule(UPDATE_SCHEDULE); expect(days.taskItem(task.id, date)).toBeNull();
  await f.harness.behavior.setSettings({ hourlyUpdates: true });
  const before = f.harness.inspection.sdk.callsTo("threads.spawn").length;
  await f.harness.behavior.runSchedule(UPDATE_SCHEDULE);
  expect(days.taskItem(task.id, date)?.actualMinutes).toBe(10);
  expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(before);
  const item = days.taskItem(task.id, date)!;
  await f.harness.behavior.runSchedule(UPDATE_SCHEDULE); expect(days.get(item.id)).toEqual(item);
});

it("does not count inherited fork receipts or unlinked threads as new work", async () => {
  const { f, task, session, days, runtime, events } = await setup();
  f.threads.set("unrelated", makeThreadResponse({ id: "unrelated", title: "Similar task title" }));
  events.set("unrelated", [event("unrelated", 1, 0, "turn/started"), event("unrelated", 2, 60, "turn/completed")]);
  events.get(session.workerThreadId)!.push(event("fork-source", 3, 20, "turn/started", "inherited"), event("fork-source", 4, 40, "turn/completed", "inherited"));
  await runtime.refresh(); expect(days.taskItem(task.id, date)?.actualMinutes).toBe(10);
  expect(f.repo.db.prepare("SELECT count(*) AS n FROM agent_time_threads WHERE thread_id='unrelated'").get()).toEqual({ n: 0 });
});

it("rolls automatic time and its history back together if auditing fails", async () => {
  const { f, task, days } = await setup();
  f.repo.db.exec("CREATE TRIGGER fail_time_audit BEFORE INSERT ON day_item_events BEGIN SELECT RAISE(ABORT,'audit failed'); END");
  expect(() => days.reconcileActual([{ taskId: task.id, date, minutes: 10 }])).toThrow(/audit failed/);
  expect(days.taskItem(task.id, date)).toBeNull();
});
