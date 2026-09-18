import { afterEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { fixture } from "./test-support.js";
import { sessionSchema, type Extraction } from "./contracts.js";
import { DayPlanning } from "./day-planning.js";
import { proposalParts } from "./proposal-parts.js";
import { validateExtraction } from "./conversation.js";

const hosts: Awaited<ReturnType<typeof fixture>>[] = [];
afterEach(async () => { for (const f of hosts.splice(0)) await f.harness.lifecycle.dispose(); });
async function finished(before?: number) {
  const f = await fixture(); hosts.push(f);
  const task = await f.create("Review a mapping and prepare a tested correction.");
  const days = new DayPlanning(f.repo);
  if (before !== undefined) days.add({ taskId: task.id, date: days.today(), reportedMinutes: before, plannedMinutes: 120, requestId: randomUUID() });
  const session = sessionSchema.parse(await f.harness.behavior.callRpc("start", { ...f.startInput(task.id, task.revision), criteria: [] }));
  const quote = "Reviewed the mapping and checked the correction against three examples.";
  await f.idle(session.workerThreadId!, quote);
  await f.harness.behavior.callRpc("finish", { sessionId: session.id });
  const current = f.repo.session(session.id), transcript = f.repo.transcript(session.id)!;
  const ref = transcript.messages.find(m => m.text === quote)!.ref;
  const extraction: Extraction = { rationale: "Record the checked correction and estimate session work.",
    facts: [{ kind: "progress", text: quote, citations: [{ messageRef: ref, quote }] }],
    changes: { status: { value: "done", evidenceRefs: ["fact:0"] } }, knowledge: [],
    reportedTime: { minutes: 35, reason: "Mapping review and three checks, including human reading. Estimated, not measured.", evidenceRefs: ["fact:0"] } };
  await f.idle(current.reviewerThreadId!, extraction);
  const reviewed = f.repo.session(session.id);
  expect(reviewed.status).toBe("awaiting_approval");
  return { f, task, session: reviewed, days, extraction, date: current.reportedTimeContext!.date };
}
const partInput = (id: string, revision: number, parts: string[], decision: "accept" | "reject" = "accept") => ({
  kind: "proposal" as const, id, revision, parts, decision, requestId: randomUUID(),
});

it("adds time only on normal proposal acceptance and preserves planned time", async () => {
  const { f, task, session, days, date } = await finished(50);
  expect(days.taskItem(task.id, date)?.reportedMinutes).toBe(50);
  expect(f.repo.pendingTotal()).toBe(1);
  const packet = f.harness.inspection.sdk.callsTo("threads.spawn").at(-1)?.[0];
  expect(JSON.stringify(packet)).toContain("reportedTimeContext");
  await f.harness.behavior.callRpc("accept", { proposalId: session.proposalId!, revision: task.revision });
  expect(days.taskItem(task.id, date)).toMatchObject({ reportedMinutes: 85, plannedMinutes: 120, reportedLocked: true });
  expect(f.repo.kernel.getTask(task.id).status).toBe("done");
  await f.reload();
  await f.harness.behavior.callRpc("accept", { proposalId: session.proposalId!, revision: task.revision });
  expect(new DayPlanning(f.repo).taskItem(task.id, date)?.reportedMinutes).toBe(85);
});

it("allows time to remain pending after task completion and applies it exactly once", async () => {
  const { f, task, session, days, date } = await finished();
  const result = f.repo.reviewParts(partInput(session.proposalId!, task.revision, ["field:status", "fact:0"]));
  expect(f.repo.kernel.getTask(task.id).status).toBe("done");
  expect(days.taskItem(task.id, date)).toBeNull();
  const remaining = f.repo.detail(task.id).sessionUpdates.find(u => u.proposalId === result.remainingId)!;
  expect(proposalParts({}, remaining.extraction)).toEqual(["reportedTime"]);
  expect(remaining.extraction.reportedTime?.evidenceRefs).toEqual([`review:${session.proposalId}:fact:0`]);
  f.repo.accept(result.remainingId!, f.repo.kernel.getTask(task.id).revision);
  expect(days.taskItem(task.id, date)?.reportedMinutes).toBe(35);
  expect(f.repo.pendingTotal()).toBe(0);
});

it("accepts time first and never carries it into the remaining proposal", async () => {
  const { f, task, session, days, date } = await finished(0);
  const request = partInput(session.proposalId!, task.revision, ["reportedTime"]);
  const result = f.repo.reviewParts(request);
  expect(f.repo.reviewParts(request)).toEqual(result);
  expect(days.taskItem(task.id, date)?.reportedMinutes).toBe(35);
  f.repo.accept(result.remainingId!, f.repo.kernel.getTask(task.id).revision);
  expect(days.taskItem(task.id, date)?.reportedMinutes).toBe(35);
});

it("rejects the time part while allowing the normal task proposal", async () => {
  const { f, task, session, days, date } = await finished(50);
  const result = f.repo.reviewParts(partInput(session.proposalId!, task.revision, ["reportedTime"], "reject"));
  f.repo.accept(result.remainingId!, task.revision);
  expect(days.taskItem(task.id, date)?.reportedMinutes).toBe(50);
});

it("rolls back every part if reported time changed, but permits excluding time", async () => {
  const { f, task, session, days, date } = await finished(50);
  const item = days.taskItem(task.id, date)!;
  days.edit({ id: item.id, revision: item.revision, reportedMinutes: 70, requestId: randomUUID() });
  expect(() => f.repo.accept(session.proposalId!, task.revision)).toThrow(/Reported time changed/);
  expect(f.repo.kernel.getTask(task.id)).toEqual(task);
  expect(f.repo.kernel.getProposal(session.proposalId!).status).toBe("pending");
  expect(days.taskItem(task.id, date)?.reportedMinutes).toBe(70);
  f.repo.reviewParts(partInput(session.proposalId!, task.revision, ["field:status", "fact:0"]));
  expect(f.repo.kernel.getTask(task.id).status).toBe("done");
});

it("ignores planned and measured runtime changes when checking the reported baseline", async () => {
  const { f, task, session, days, date } = await finished(50);
  const item = days.taskItem(task.id, date)!;
  days.edit({ id: item.id, revision: item.revision, plannedMinutes: 60, requestId: randomUUID() });
  days.reconcileActual([{ taskId: task.id, date, minutes: 0.1 }]);
  f.repo.accept(session.proposalId!, task.revision);
  expect(days.taskItem(task.id, date)).toMatchObject({ reportedMinutes: 85, plannedMinutes: 60, actualMinutes: 0.1 });
});

it("allows a blank measured-time row created during review without treating it as a manual correction", async () => {
  const { f, task, session, days, date } = await finished();
  days.reconcileActual([{ taskId: task.id, date, minutes: 0.2 }]);
  f.repo.accept(session.proposalId!, task.revision);
  expect(days.taskItem(task.id, date)).toMatchObject({ reportedMinutes: 35, actualMinutes: 0.2 });
});

it("tracks original work across review discussions and prevents double reporting", async () => {
  const { f, task, session, days, date, extraction } = await finished();
  f.repo.accept(session.proposalId!, task.revision);
  const continuation = f.repo.saveSession({ ...session, id: randomUUID(), continuedFrom: session.id, proposalId: null });
  const context = f.repo.sessionTime.capture(continuation);
  expect(context).toMatchObject({ sourceSessionId: session.id, date, alreadyReported: true });
  expect(() => validateExtraction(extraction, f.repo.transcript(session.id)!, context)).toThrow(/already accepted/);
  expect(() => f.repo.sessionTime.check(extraction, context, task.id)).toThrow(/already accepted/);
  expect(days.taskItem(task.id, date)?.reportedMinutes).toBe(35);
});

it("uses configured local date and refuses invented evidence", async () => {
  const { f, session, extraction } = await finished();
  const days = new DayPlanning(f.repo, () => new Date(), () => "Pacific/Auckland");
  const { SessionTime } = await import("./session-time.js");
  const context = new SessionTime(f.repo, days).capture({ ...session, reportedTimeContext: undefined, finishedAt: "2026-09-18T23:30:00Z" });
  expect(context.date).toBe("2026-09-19");
  expect(() => validateExtraction({ ...extraction, reportedTime: { ...extraction.reportedTime!, evidenceRefs: ["fact:99"] } }, f.repo.transcript(session.id)!)).toThrow(/missing conversation fact/);
});
