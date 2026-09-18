import { afterEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { fixture } from "./test-support.js";
import { DayPlanning } from "./day-planning.js";
import { TimeReview } from "./time-review.js";
const hosts: Awaited<ReturnType<typeof fixture>>[] = [];
afterEach(async () => { for (const f of hosts.splice(0)) await f.harness.lifecycle.dispose(); });
async function setup() {
  const f = await fixture(); hosts.push(f); const task = await f.create();
  const days = new DayPlanning(f.repo, () => new Date("2026-09-18T18:00:00Z"));
  const review = new TimeReview(f.bb, days, () => ({ weeklyReportedTargetMinutes: 1200, weeklyReportedOverrides: '{"2026-09-14":960}', dailyTimeReviewHour: 20 }));
  const external = [{ id: "external:message1", taskId: null, source: "Teams", at: "2026-09-18T10:00:00Z", url: "https://example.com/message/1", text: "I reviewed the proposal and corrected the calculation." }];
  const prepare = () => review.prepare({ date: "2026-09-18", offset: 0, external });
  const submit = async () => review.submit({ requestId: randomUUID(), contextId: (await prepare()).id, suggestions: [{ taskId: task.id, minutes: 35, reason: "Review and correction; estimated human effort.", question: null, evidenceRefs: [external[0].id] }] }).proposals[0];
  return { f, task, days, review, external, prepare, submit };
}
it("keeps external work pending without measured agent time, accepts an edited total exactly once and preserves the plan", async () => {
  const { review, submit, days, task } = await setup(); const proposal = await submit();
  expect(days.taskItem(task.id, proposal.date)).toBeNull();
  expect(review.view().weekly).toMatchObject({ reportedMinutes: 0, targetMinutes: 960, remainingMinutes: 960 });
  expect((await submit()).id).toBe(proposal.id);
  const decision = { requestId: randomUUID(), id: proposal.id, decision: "accept" as const, minutes: 42 };
  expect(review.decide(decision).status).toBe("accepted"); expect(review.decide(decision).status).toBe("accepted");
  expect(days.taskItem(task.id, proposal.date)).toMatchObject({ reportedMinutes: 42, plannedMinutes: null, reportedLocked: true });
  expect(review.view().weekly.reportedMinutes).toBe(42); expect(review.view().proposals).toHaveLength(0);
  expect(review.view("2026-09-21").weekly.targetMinutes).toBe(1200);
});
it("protects manual edits including explicitly blank and zero time, and rejects stale approvals", async () => {
  const { days, task, submit, review, prepare } = await setup();
  let item = days.add({ requestId: randomUUID(), taskId: task.id, date: "2026-09-18", plannedMinutes: 60 });
  const proposal = await submit();
  item = days.edit({ requestId: randomUUID(), id: item.id, revision: item.revision, reportedMinutes: null });
  expect(review.view().proposals[0].blockedReason).toBeTruthy();
  expect(() => review.decide({ requestId: randomUUID(), id: proposal.id, decision: "accept" })).toThrow(/changed/);
  expect((await prepare()).tasks).toHaveLength(0);
  days.edit({ requestId: randomUUID(), id: item.id, revision: item.revision, reportedMinutes: 0 });
  expect((await prepare()).tasks).toHaveLength(0);
  review.decide({ requestId: randomUUID(), id: proposal.id, decision: "reject" });
  expect(days.get(item.id).reportedMinutes).toBe(0);
});
it("validates frozen evidence, supersedes daily totals and does not resurrect rejected evidence", async () => {
  const { review, submit, external, prepare, task } = await setup(); const first = await submit();
  review.decide({ requestId: randomUUID(), id: first.id, decision: "reject" });
  expect((await submit()).status).toBe("rejected");
  external[0] = { ...external[0], id: "external:message2", text: "Another review" };
  const second = await submit();
  external[0] = { ...external[0], id: "external:message3" }; const third = await submit();
  expect(review.view().proposals.map(p => p.id)).toEqual([third.id]);
  expect(() => review.decide({ requestId: randomUUID(), id: second.id, decision: "accept" })).toThrow(/replaced/);
  const context = await prepare();
  expect(() => review.submit({ requestId: randomUUID(), contextId: context.id, suggestions: [{ taskId: task.id, minutes: 50, reason: "test", question: null, evidenceRefs: ["invented"] }] })).toThrow(/evidence/);
  await expect(review.prepare({ date: "2026-09-17", offset: 0, external })).rejects.toThrow(/date/);
});
it("asks for unknown duration, marks a day reviewed and reopens the review when the day changes", async () => {
  const { review, prepare, task, external, days } = await setup();
  const p = review.submit({ requestId: randomUUID(), contextId: (await prepare()).id, suggestions: [{ taskId: task.id, minutes: null, question: "How long did the review take?", reason: "Duration is unknown.", evidenceRefs: [external[0].id] }] }).proposals[0];
  expect(review.view().due).toBe(true);
  expect(() => review.complete({ requestId: randomUUID(), date: p.date, revision: review.view().revision })).toThrow(/pending/);
  expect(() => review.decide({ requestId: randomUUID(), id: p.id, decision: "accept" })).toThrow(/Enter/);
  review.decide({ requestId: randomUUID(), id: p.id, decision: "accept", minutes: 20 });
  const stale = review.view().revision;
  review.complete({ requestId: randomUUID(), date: p.date, revision: stale }); expect(review.view().due).toBe(false);
  const item = days.taskItem(task.id, p.date)!;
  days.edit({ requestId: randomUUID(), id: item.id, revision: item.revision, reportedMinutes: 25 });
  expect(review.view().due).toBe(true);
  expect(() => review.complete({ requestId: randomUUID(), date: p.date, revision: stale })).toThrow(/changed/);
});
it("collects dated worker messages across pages and prevents allocating the same evidence twice", async () => {
  const { f, review, task, external, prepare, submit } = await setup();
  const session = await f.start(task.id, task.revision);
  const row = { ...f.message(session.workerThreadId!, "user", "I checked the result and corrected the assumptions."), createdAt: Date.parse("2026-09-18T10:00:00Z") };
  f.harness.inspection.sdk.stub("threads.timeline", ({ beforeAnchorId }) => ({ rows: beforeAnchorId ? [row] : [], timelinePage: { hasOlderRows: !beforeAnchorId, olderCursor: beforeAnchorId ? null : { anchorId: "older", anchorSeq: 2 } } }));
  const context = await prepare();
  expect(context.evidence.some(e => e.taskId === task.id && e.text.includes("corrected the assumptions"))).toBe(true);
  await submit();
  const second = await f.create();
  const next = await prepare();
  expect(() => review.submit({ requestId: randomUUID(), contextId: next.id, suggestions: [{ taskId: second.id, minutes: 35, reason: "Repeated work", question: null, evidenceRefs: [external[0].id] }] })).toThrow(/already allocated/);
});
