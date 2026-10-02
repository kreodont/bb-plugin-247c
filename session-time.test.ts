import { afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { fixture } from "./test-support.js";
import { sessionSchema, rpcContract, type Extraction } from "./contracts.js";
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
  f.repo.reviewParts(partInput(result.remainingId!, f.repo.kernel.getTask(task.id).revision, ["reportedTime"]));
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

it.each([70, 0, null])("automatically omits stale time after a manual correction to %s", async reportedMinutes => {
  const { f, task, session, days, date, extraction } = await finished(50);
  const item = days.taskItem(task.id, date)!;
  days.edit({ id: item.id, revision: item.revision, reportedMinutes, requestId: randomUUID() });
  expect(f.repo.kernel.getTask(task.id)).toEqual(task);
  const update = f.repo.detail(task.id).sessionUpdates[0];
  expect(update.extraction.reportedTime).toBeNull();
  expect(update.omittedReportedTime).toMatchObject({ estimate: extraction.reportedTime, reason: "reported_changed" });
  expect(f.repo.kernel.getProposal(session.proposalId!).status).toBe("pending");
  await f.harness.behavior.callRpc("accept", { proposalId: session.proposalId!, revision: task.revision });
  expect(f.repo.kernel.getTask(task.id).status).toBe("done");
  expect(days.taskItem(task.id, date)).toMatchObject({ reportedMinutes, reportedLocked: true, plannedMinutes: 120 });
  expect(f.repo.detail(task.id).facts.some(fact => fact.text === extraction.facts[0].text)).toBe(true);
  await f.reload();
  expect(f.repo.detail(task.id).sessionUpdates[0].omittedReportedTime).toBeTruthy();
  expect(f.repo.pendingTotal()).toBe(0);
});

it("accepts an old inbox selection without stale time or an unwanted pending remainder", async () => {
  const { f, task, session, days, date } = await finished(50);
  const selection = { kind: "proposal" as const, id: session.proposalId!, revision: task.revision, parts: ["field:status", "fact:0", "reportedTime"] };
  const item = days.taskItem(task.id, date)!;
  days.edit({ id: item.id, revision: item.revision, reportedMinutes: 70, requestId: randomUUID() });
  const result = rpcContract.acceptInbox.output.parse(await f.harness.behavior.callRpc("acceptInbox", { items: [selection] }));
  expect(result.failed).toEqual([]);
  expect(result.applied).toHaveLength(1);
  expect(f.repo.kernel.getTask(task.id).status).toBe("done");
  expect(days.taskItem(task.id, date)?.reportedMinutes).toBe(70);
  expect(f.repo.pendingTotal()).toBe(0);
});

it("does not accept unselected task fields when only stale time was selected", async () => {
  const { f, task, session, days, date } = await finished(50);
  const item = days.taskItem(task.id, date)!;
  days.edit({ id: item.id, revision: item.revision, reportedMinutes: 70, requestId: randomUUID() });
  const input = partInput(session.proposalId!, task.revision, ["reportedTime"]);
  expect(f.repo.reviewParts(input)).toEqual({ taskId: task.id, remainingId: session.proposalId });
  expect(f.repo.reviewParts(input)).toEqual({ taskId: task.id, remainingId: session.proposalId });
  expect(f.repo.kernel.getTask(task.id)).toEqual(task);
  expect(f.repo.pendingTotal()).toBe(1);
  expect(() => f.repo.reviewParts(partInput(session.proposalId!, task.revision, ["reportedTime", "unknown"]))).toThrow(/distinct parts/);
  expect(() => f.repo.reviewParts(partInput(session.proposalId!, task.revision, ["reportedTime", "reportedTime"]))).toThrow(/distinct parts/);
});

it("dismisses a stale time-only remainder without another task revision or approval", async () => {
  const { f, task, session, days, date } = await finished(50);
  const result = f.repo.reviewParts(partInput(session.proposalId!, task.revision, ["field:status", "fact:0"]));
  const completed = f.repo.kernel.getTask(task.id);
  const item = days.taskItem(task.id, date)!;
  days.edit({ id: item.id, revision: item.revision, reportedMinutes: 70, requestId: randomUUID() });
  const inbox = rpcContract.proposalInbox.output.parse(await f.harness.behavior.callRpc("proposalInbox", { offset: 0 }));
  expect(inbox.items).toEqual([]); expect(inbox.total).toBe(0);
  expect(f.repo.kernel.getTask(task.id)).toEqual(completed);
  expect(f.repo.session(session.id).status).toBe("applied");
  expect(f.repo.kernel.getProposal(result.remainingId!).status).toBe("rejected");
  await f.harness.behavior.callRpc("accept", { proposalId: result.remainingId!, revision: completed.revision });
  expect(f.repo.kernel.getTask(task.id)).toEqual(completed);
  expect(days.taskItem(task.id, date)?.reportedMinutes).toBe(70);
});

it("cleans existing proposals on reload without requiring a new manual edit", async () => {
  const { f, task, session, days, date } = await finished(50);
  // Simulate a manual correction written by the previous plugin version.
  const stop = vi.spyOn(f.repo.sessionTime, "reconcile").mockReturnValue(0);
  const item = days.taskItem(task.id, date)!;
  days.edit({ id: item.id, revision: item.revision, reportedMinutes: 70, requestId: randomUUID() });
  const row = f.repo.db.prepare("SELECT value_json FROM session_updates WHERE proposal_id=?").get(session.proposalId) as { value_json: string };
  const old = JSON.parse(row.value_json); delete old.reportedTimeContext.reportedEventSequence;
  f.repo.db.prepare("UPDATE session_updates SET value_json=? WHERE proposal_id=?").run(JSON.stringify(old), session.proposalId);
  stop.mockRestore(); await f.reload();
  const inbox = rpcContract.proposalInbox.output.parse(await f.harness.behavior.callRpc("proposalInbox", { offset: 0 }));
  const entry = inbox.items[0]; expect(entry.kind).toBe("proposal");
  if (entry.kind !== "proposal") throw new Error("Expected session proposal");
  expect(entry.dossier.sessionUpdates[0].extraction.reportedTime).toBeNull();
  expect(entry.blockedReason).toBeNull();
  expect(f.repo.kernel.getTask(task.id)).toEqual(task);
});

it("detects reported edits even if the total returns to its captured value", async () => {
  const { f, task, session, days, date } = await finished(50);
  const stop = vi.spyOn(f.repo.sessionTime, "reconcile").mockReturnValue(0);
  let item = days.taskItem(task.id, date)!;
  item = days.edit({ id: item.id, revision: item.revision, reportedMinutes: 70, requestId: randomUUID() });
  days.edit({ id: item.id, revision: item.revision, reportedMinutes: 50, requestId: randomUUID() });
  stop.mockRestore();
  f.repo.accept(session.proposalId!, task.revision);
  expect(days.taskItem(task.id, date)?.reportedMinutes).toBe(50);
  expect(f.repo.detail(task.id).sessionUpdates[0].omittedReportedTime).toBeTruthy();
});

it("preserves missing-context and task-revision checks", async () => {
  const { f, task, session } = await finished(50);
  const row = f.repo.db.prepare("SELECT value_json FROM session_updates WHERE proposal_id=?").get(session.proposalId) as { value_json: string };
  const broken = JSON.parse(row.value_json); delete broken.reportedTimeContext;
  f.repo.db.prepare("UPDATE session_updates SET value_json=? WHERE proposal_id=?").run(JSON.stringify(broken), session.proposalId);
  expect(() => f.repo.accept(session.proposalId!, task.revision)).toThrow(/no saved day context/);
  expect(f.repo.kernel.getTask(task.id)).toEqual(task);
  expect(f.repo.kernel.getProposal(session.proposalId!).status).toBe("pending");
  f.repo.note({ taskId: task.id, revision: task.revision, kind: "progress", text: "Later task correction", requestId: randomUUID() });
  expect(() => f.repo.accept(session.proposalId!, task.revision)).toThrow(/dossier changed/i);
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

it("names an accepted session estimate as its source, with the reason and conversation", async () => {
  const { f, task, session, days, date, extraction } = await finished(50);
  await f.harness.behavior.callRpc("accept", { proposalId: session.proposalId!, revision: task.revision });
  const item = days.day(date).items.find(i => i.taskId === task.id)!;
  expect(item.reportedMinutes).toBe(85);
  expect(item.reportedChanges.map(c => [c.source, c.from, c.to])).toEqual([["panel", null, 50], ["session_review", 50, 85]]);
  expect(item.reportedChanges.at(-1)).toMatchObject({ sessionId: session.id, proposalId: session.proposalId, threadId: session.workerThreadId,
    reason: extraction.reportedTime!.reason, label: "Session time estimate accepted in review" });
  expect(days.report({ date, period: "day" }).rows[0].days[0].reportedFrom).toEqual(["panel", "session_review"]);
});

it("names a session estimate that created the entry by itself", async () => {
  const { f, task, session, days, date } = await finished();
  await f.harness.behavior.callRpc("accept", { proposalId: session.proposalId!, revision: task.revision });
  const item = days.day(date).items.find(i => i.taskId === task.id)!;
  expect(item.plannedMinutes).toBeNull();
  expect(item.reportedChanges).toHaveLength(1);
  expect(item.reportedChanges[0]).toMatchObject({ source: "session_review", from: null, to: 35, threadId: session.workerThreadId });
  expect(days.report({ date, period: "day" }).rows[0].days[0].reportedFrom).toEqual(["session_review"]);
});

it("does not add a session estimate on top of time entered from that session's conversation", async () => {
  // Real case, 02.10: the user asked the agent to record 3 hours, then accepted a
  // review estimate of the same 3 hours, and the day showed 6.
  const f = await fixture(); hosts.push(f);
  const task = await f.create("Inventory legacy scripts and estimate the migration.");
  const days = new DayPlanning(f.repo);
  const session = sessionSchema.parse(await f.harness.behavior.callRpc("start", { ...f.startInput(task.id, task.revision), criteria: [] }));
  const quote = "Record three hours for the script inventory.";
  await f.idle(session.workerThreadId!, quote);
  days.add({ taskId: task.id, date: days.today(), reportedMinutes: 180, requestId: randomUUID() }, `bb-thread:${session.workerThreadId}`);
  await f.harness.behavior.callRpc("finish", { sessionId: session.id });
  const current = f.repo.session(session.id), transcript = f.repo.transcript(session.id)!;
  const ref = transcript.messages.find(m => m.text === quote)!.ref;
  await f.idle(current.reviewerThreadId!, { rationale: "Record the inventory.", facts: [{ kind: "progress", text: quote, citations: [{ messageRef: ref, quote }] }],
    changes: { status: { value: "done", evidenceRefs: ["fact:0"] } }, knowledge: [], reportedTime: { minutes: 180, reason: "The user asked to record 3 hours.", evidenceRefs: ["fact:0"] } } satisfies Extraction);
  const reviewed = f.repo.session(session.id);
  const detail = f.repo.detail(task.id);
  const update = detail.sessionUpdates.find(u => u.proposalId === reviewed.proposalId)!;
  expect(update.extraction.reportedTime).toBeNull();
  expect(update.omittedReportedTime?.reason).toBe("recorded_in_conversation");
  if (f.repo.kernel.getProposal(reviewed.proposalId!).status === "pending")
    await f.harness.behavior.callRpc("accept", { proposalId: reviewed.proposalId!, revision: f.repo.kernel.getTask(task.id).revision });
  expect(days.taskItem(task.id, days.today())?.reportedMinutes).toBe(180);
});

it("retires a pending estimate once time is entered from the session's conversation", async () => {
  const { f, task, session, days, date } = await finished(50);
  days.edit({ id: days.taskItem(task.id, date)!.id, revision: days.taskItem(task.id, date)!.revision, reportedMinutes: 90, requestId: randomUUID() }, `bb-thread:${session.workerThreadId}`);
  const update = f.repo.detail(task.id).sessionUpdates.find(u => u.sessionId === session.id)!;
  expect(update.omittedReportedTime?.reason).toBe("recorded_in_conversation");
  expect(days.taskItem(task.id, date)?.reportedMinutes).toBe(90);
});

it("still adds a session estimate when time was entered from an unrelated conversation", async () => {
  const { f, task, session, days, date } = await finished(50);
  days.edit({ id: days.taskItem(task.id, date)!.id, revision: days.taskItem(task.id, date)!.revision, reportedMinutes: 60, requestId: randomUUID() }, "bb-thread:thr_unrelated");
  // The unrelated edit changed the day total, so the estimate is stale for that reason instead.
  expect(f.repo.detail(task.id).sessionUpdates.find(u => u.sessionId === session.id)!.omittedReportedTime?.reason).toBe("reported_changed");
});
