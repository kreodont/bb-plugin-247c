import { afterEach, expect, it, vi } from "vitest";
import { readScriptCalendar, calendarCommandSchema } from "./calendar-script.js";
import * as scripts from "./calendar-script.js";
import * as google from "./calendar-reader.js";
import { fixture } from "./test-support.js";
import { DayPlanning } from "./day-planning.js";
import { randomUUID } from "node:crypto";

const input = () => ({ from: "2026-09-14", through: "2026-09-22", known: [], signal: new AbortController().signal });
const meeting = { key: "outlook:event", calendarId: "work@example.com", eventId: "event", occurrenceId: null,
  title: "Daily stand", startAt: "2026-09-15T07:30:00Z", endAt: "2026-09-15T07:45:00Z", status: "confirmed" as const, url: "https://outlook.office.com/calendar/item" };
const hosts: Awaited<ReturnType<typeof fixture>>[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const f of hosts.splice(0)) await f.harness.lifecycle.dispose(); });

it("passes structured input without shell interpretation and accepts valid reader output", async () => {
  const command = [process.execPath, "-e", `let text=''; process.stdin.on('data',d=>text+=d); process.stdin.on('end',()=>{const input=JSON.parse(text); if(input.from!=='2026-09-14')process.exit(2); process.stdout.write(JSON.stringify({events:[${JSON.stringify(meeting)}],readCount:1}));});`];
  expect(await readScriptCalendar(command, input())).toEqual({ events: [meeting], readCount: 1 });
  expect(() => calendarCommandSchema.parse(["node", "reader.js"])).toThrow(/absolute/);
});

it("rejects failed, malformed, duplicate and unsafe results before saving meetings", async () => {
  for (const result of ["not json", JSON.stringify({ events: [{ ...meeting, endAt: meeting.startAt }], readCount: 1 }),
    JSON.stringify({ events: [meeting, meeting], readCount: 2 }), JSON.stringify({ events: [{ ...meeting, url: "javascript:alert(1)" }], readCount: 1 })]) {
    await expect(readScriptCalendar([process.execPath, "-e", `process.stdout.write(${JSON.stringify(result)})`], input())).rejects.toThrow();
  }
  await expect(readScriptCalendar([process.execPath, "-e", "process.stderr.write('offline');process.exit(1)"], input())).rejects.toThrow(/offline/);
});

it("stops an interrupted reader", async () => {
  const controller = new AbortController();
  const work = readScriptCalendar([process.execPath, "-e", "setInterval(()=>{},1000)"], { ...input(), signal: controller.signal });
  const assertion = expect(work).rejects.toThrow();
  controller.abort();
  await assertion;
});

it("the configured reader feeds native meetings and preserves manual time on refresh", async () => {
  const read = vi.spyOn(scripts, "readScriptCalendar").mockResolvedValue({ events: [meeting], readCount: 1 });
  const oldReader = vi.spyOn(google, "readCalendar");
  const f = await fixture(); hosts.push(f);
  await f.harness.behavior.setSettings({ calendarMeetings: true, calendarReaderCommand: JSON.stringify([process.execPath, "/local/reader.js"]) });
  await f.harness.behavior.callRpc("calendarSync", { date: "2026-09-15" });
  const days = new DayPlanning(f.repo);
  await vi.waitFor(() => expect(days.calendarState().status).toBe("complete"));
  expect(read).toHaveBeenCalledOnce(); expect(oldReader).not.toHaveBeenCalled();
  let item = days.calendarItems()[0]!;
  expect(item).toMatchObject({ kind: "meeting", taskId: null, plannedMinutes: 15, plannedMode: "calendar" });
  item = days.edit({ id: item.id, revision: item.revision, plannedMinutes: 20, requestId: randomUUID() });
  read.mockResolvedValue({ events: [{ ...meeting, endAt: "2026-09-15T08:00:00Z" }], readCount: 1 });
  await f.harness.behavior.callRpc("calendarSync", { date: "2026-09-15" });
  await vi.waitFor(() => expect(days.calendarState().status).toBe("complete"));
  expect(days.calendarItems()).toHaveLength(1);
  expect(days.get(item.id)).toMatchObject({ plannedMinutes: 20, plannedMode: "manual", calendar: { endAt: "2026-09-15T08:00:00Z" } });
  expect(f.repo.list().total).toBe(0);
});
