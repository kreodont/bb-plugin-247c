import { afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { makePluginAgentConfigurationContext } from "@get-bb/plugin-sdk/testing";
import { fixture } from "./test-support.js";
import { AutomaticWork } from "./automatic-work.js";
import { SessionRuntime } from "./runtime.js";
import { DayPlanning } from "./day-planning.js";
import { SourceSyncStore } from "./source-sync.js";
import { SourceChatUpdates } from "./source-chat-updates.js";
import { sessionSchema, type Session, type Extraction } from "./contracts.js";
import { sourceData, startSourceSync, submitSourceData } from "./source-sync-test-support.js";
import { proposalParts } from "./proposal-parts.js";

const hosts: Awaited<ReturnType<typeof fixture>>[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const f of hosts.splice(0)) await f.harness.lifecycle.dispose(); });
async function setup(enabled = true) {
  const f = await fixture({ settings: { automaticProcessing: enabled, workProvider: "claude-work", workModel: "claude-opus-5[1m]" } }); hosts.push(f);
  const settings = { automaticProcessing: enabled, automaticMaximumWorkers: 1 };
  const runtime = new SessionRuntime(f.bb, f.repo, async () => ({ ...settings, codexReviewer: "gpt-5.6-sol", claudeReviewer: "claude-fable-5-1", maximumRepairs: 2, sessionMinutes: 20 }));
  const days = new DayPlanning(f.repo), store = new SourceSyncStore(f.repo), auto = new AutomaticWork(f.bb, f.repo, runtime, store, days, () => settings);
  auto.control();
  const chats = new SourceChatUpdates(f.bb, f.repo, runtime, () => ({ projectId: "proj_personal", providerId: "claude-work", model: "claude-opus-5[1m]" }), auto);
  return { f, runtime, days, store, auto, settings, chats };
}
// Preserve coverage for states saved by older plugin versions.
function legacyCheckpoint(s: Awaited<ReturnType<typeof setup>>, threadId: string, input: NonNullable<Session["automation"]> & { reason?: string }) {
  const session = s.f.repo.forThread(threadId)!;
  const lastUserSeq = Math.max(0, ...(s.f.conversations.get(threadId) ?? []).filter(r => r.kind === "conversation" && r.role === "user").map(r => r.sourceSeqEnd));
  const { reason: _, ...automation } = input;
  s.f.repo.saveSession({ ...session, automation: { ...automation, lastUserSeq } });
}
async function source(s: Awaited<ReturnType<typeof setup>>, taskId: string | null = null) {
  const { run } = await startSourceSync(s.f), { input } = await sourceData(s.f, run, taskId);
  await submitSourceData(s.f, run, input);
  s.store.save({ ...s.store.run(run.id), status: "completed" });
  return s.store.pendingCandidates().find(c => c.runId === run.id)!;
}
async function chat(s: Awaited<ReturnType<typeof setup>>) {
  const task = await s.f.create();
  const session = sessionSchema.parse(await s.f.harness.behavior.callRpc("start", { ...s.f.startInput(task.id, task.revision), criteria: [] }));
  return { task, session };
}
it("is opt-in, excludes old pending proposals and preserves the cutoff across restart", async () => {
  const s = await setup(false), old = await source(s);
  await s.auto.tick(); expect(s.store.candidate(old.id).status).toBe("pending");
  // Give the activation a strictly later timestamp than the old proposal.
  const clock = () => new Date(Date.parse(old.createdAt) + 1000);
  s.settings.automaticProcessing = true;
  const enabled = new AutomaticWork(s.f.bb, s.f.repo, s.runtime, s.store, s.days, () => s.settings, clock);
  enabled.control(); await enabled.tick(); expect(s.store.candidate(old.id).status).toBe("pending");
  const restored = new AutomaticWork(s.f.bb, s.f.repo, s.runtime, s.store, s.days, () => s.settings);
  expect(restored.control().since).toBe(clock().toISOString());
});
it("accepts new source events once with an automation receipt and starts a corporate chat once", async () => {
  const s = await setup(), candidate = await source(s);
  await s.auto.tick(); await s.chats.flush();
  const applied = s.store.candidate(candidate.id), taskId = applied.resultTaskId!;
  expect(applied.status).toBe("applied"); expect(applied.chatDelivery?.state).toBe("sent");
  expect(s.f.repo.active().filter(row => row.taskId === taskId)).toHaveLength(1);
  expect(s.f.threads.get(applied.chatDelivery!.threadId!)?.providerId).toBe("claude-work");
  const writes = s.f.harness.inspection.sdk.callsTo("threads.send").length;
  await s.auto.tick(); await s.chats.flush(); expect(s.f.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(writes);
  expect(JSON.stringify(s.f.repo.db.prepare("SELECT * FROM proposal_approvals").all())).toContain("automation:247c");
});
it("respects the worker cap, pause holds across dates, and disabled mode", async () => {
  const s = await setup(), first = await source(s); await s.auto.tick(); await s.chats.flush();
  const secondTask = await s.f.create("A different task"), second = await source(s, secondTask.id);
  await s.auto.tick(); await s.chats.flush(); expect(s.store.candidate(second.id).chatDelivery?.state).toBe("pending");
  const firstSession = s.f.repo.forThread(s.store.candidate(first.id).chatDelivery!.threadId!)!;
  s.f.threads.set(firstSession.workerThreadId!, { ...s.f.threads.get(firstSession.workerThreadId!)!, environmentId: "env_test" });
  s.f.message(firstSession.workerThreadId!, "assistant", "I checked the source and prepared the local change.");
  await s.auto.pause(firstSession.id); await s.chats.flush();
  expect(s.store.candidate(second.id).chatDelivery?.state).toBe("pending"); // review still uses the slot
  const tomorrow = new AutomaticWork(s.f.bb, s.f.repo, s.runtime, s.store, s.days, () => s.settings, () => new Date(Date.now() + 86400000));
  expect(tomorrow.state().paused.map(p => p.taskId)).toContain(firstSession.taskId);
  expect(tomorrow.allow(s.store.candidate(first.id))).toBe(false);
  s.settings.automaticProcessing = false;
  expect(tomorrow.allow(s.store.candidate(second.id))).toBe(false);
});
it("keeps legacy needs-input sessions open", async () => {
  const s = await setup(), { session } = await chat(s);
  await s.f.idle(session.workerThreadId!, "I need your approval before changing the external record.");
  legacyCheckpoint(s, session.workerThreadId!, { state: "needs_input", reason: "external_write", note: "Approve the prepared external change." });
  await s.auto.tick(); expect(s.f.repo.session(session.id).status).toBe("working");
  expect(s.auto.state().sessions[0].state).toBe("needs_input");
});
it("cancels an obsolete ready checkpoint after a new user message", async () => {
  const s = await setup(), { session } = await chat(s);
  await s.f.idle(session.workerThreadId!, "All work completed.");
  legacyCheckpoint(s, session.workerThreadId!, { state: "ready", outcome: "done", note: "All work completed." });
  s.f.message(session.workerThreadId!, "user", "Wait, keep the task open.");
  await s.auto.tick(); expect(s.f.repo.session(session.id)).toMatchObject({ status: "working", automation: { state: "working" } });
});
it.each(["done", "waiting"] as const)("keeps a ready %s session open across idle ticks and reload until manual Finish", async outcome => {
  const s = await setup(), { session } = await chat(s), threadId = session.workerThreadId!;
  await s.f.idle(threadId, "The work is ready.");
  legacyCheckpoint(s, threadId, { state: "ready", outcome, note: "The work is ready." });
  const finish = vi.spyOn(s.runtime, "finish");
  await s.auto.tick(); await s.auto.tick();
  expect(finish).not.toHaveBeenCalled();
  expect(s.f.repo.session(session.id)).toMatchObject({ status: "working", finishedAt: null, reviewerThreadId: null });
  expect(s.f.repo.transcript(session.id)).toBeNull();
  await s.f.reload();
  const runtime = new SessionRuntime(s.f.bb, s.f.repo, async () => ({ codexReviewer: "gpt-5.6-sol", claudeReviewer: "claude-fable-5-1", maximumRepairs: 2, sessionMinutes: 20 }));
  const restored = new AutomaticWork(s.f.bb, s.f.repo, runtime, new SourceSyncStore(s.f.repo), new DayPlanning(s.f.repo), () => s.settings);
  await restored.tick();
  expect(s.f.repo.session(session.id)).toMatchObject({ status: "working", finishedAt: null, automation: { state: "ready", outcome } });
  await s.f.harness.behavior.callRpc("finish", { sessionId: session.id });
  expect(s.f.repo.session(session.id)).toMatchObject({ status: "reviewing", finishMode: "resolve" });
});
it("lets another automatic worker start while a ready session waits for manual Finish", async () => {
  const s = await setup(), first = await source(s);
  await s.auto.tick(); await s.chats.flush();
  const threadId = s.store.candidate(first.id).chatDelivery!.threadId!;
  await s.f.idle(threadId, "Ready for review.");
  legacyCheckpoint(s, threadId, { state: "ready", outcome: "done", note: "Ready for review." });
  const secondTask = await s.f.create("Another task"), second = await source(s, secondTask.id);
  await s.auto.tick(); await s.chats.flush();
  expect(s.store.candidate(second.id).chatDelivery?.state).toBe("sent");
  expect(s.f.repo.forThread(threadId)).toMatchObject({ status: "working", finishedAt: null });
});
async function reviewed(paused = false) {
  const s = await setup(), { task, session } = await chat(s), date = s.days.today();
  s.days.add({ taskId: task.id, date, reportedMinutes: 50, plannedMinutes: 120, requestId: randomUUID() });
  const quote = "Reviewed the mapping and checked the correction against three examples. The whole request is complete.";
  await s.f.idle(session.workerThreadId!, quote);
  if (paused) await s.auto.pause(session.id); else await s.auto.finish(session.id);
  const current = s.f.repo.session(session.id), transcript = s.f.repo.transcript(session.id)!, ref = transcript.messages.find(m => m.text === quote)!.ref;
  const extraction: Extraction = { rationale: "Save the checked correction and estimate only this session.", facts: [{ kind: "progress", text: quote, citations: [{ messageRef: ref, quote }] }],
    changes: { status: { value: "done", evidenceRefs: ["fact:0"] }, summary: { value: quote, evidenceRefs: ["fact:0"] } }, knowledge: [],
    reportedTime: { minutes: 35, workSummary: "Reviewed the mapping and tested the correction.", reason: "Mapping review and three checks, including reading.", evidenceRefs: ["fact:0"] } };
  await s.f.idle(current.reviewerThreadId!, extraction);
  expect(s.f.repo.session(session.id).status).toBe("awaiting_approval");
  return { ...s, task, session, date };
}
it("automatically applies only non-time review parts, archives the chat and accepts time exactly once manually", async () => {
  const s = await reviewed(); await s.auto.tick();
  expect(s.f.repo.kernel.getTask(s.task.id).status).toBe("done");
  expect(s.days.taskItem(s.task.id, s.date)?.reportedMinutes).toBe(50);
  const current = s.f.repo.session(s.session.id);
  expect(current.automation?.appliedAt).toBeTruthy(); expect(current.status).toBe("awaiting_approval");
  expect(proposalParts(s.f.repo.kernel.getProposal(current.proposalId!).changes, current.extraction!)).toEqual(["reportedTime"]);
  expect(s.f.threads.get(current.workerThreadId!)?.archivedAt).toBeTruthy();
  await s.auto.tick(); expect(s.days.taskItem(s.task.id, s.date)?.reportedMinutes).toBe(50);
  await s.runtime.accept(current.proposalId!, s.f.repo.kernel.getTask(s.task.id).revision);
  expect(s.days.taskItem(s.task.id, s.date)?.reportedMinutes).toBe(85);
  await s.auto.tick(); expect(s.days.taskItem(s.task.id, s.date)?.reportedMinutes).toBe(85);
});
it("Pause keeps the task open even if the recorder proposes completion, without moving today's reported time", async () => {
  const s = await reviewed(true); await s.auto.tick();
  expect(s.f.repo.kernel.getTask(s.task.id).status).toBe("open");
  const until = s.auto.state().paused[0].until;
  expect(s.days.taskItem(s.task.id, s.date)).toMatchObject({ reportedMinutes: 50, state: "carried", carriedTo: until });
  expect(s.days.taskItem(s.task.id, until)?.reportedMinutes).toBeNull();
  expect(s.f.repo.session(s.session.id).reportedTimeContext?.date).toBe(s.date);
  s.auto.manualOpen(s.task.id); expect(s.auto.state().paused).toEqual([]);
});
it("preserves an existing tomorrow entry and its manual time on pause", async () => {
  const s = await setup(), { task, session } = await chat(s);
  const until = s.days.pauseUntilTomorrow(task.id, session.id), next = s.days.taskItem(task.id, until)!;
  s.days.edit({ id: next.id, revision: next.revision, plannedMinutes: 90, reportedMinutes: 10, requestId: randomUUID() });
  await s.auto.pause(session.id);
  expect(s.days.taskItem(task.id, until)).toMatchObject({ plannedMinutes: 90, reportedMinutes: 10 });
});
it("records a stale review conflict and never forces it over newer task edits", async () => {
  const s = await reviewed(); s.f.repo.status(s.task.id, "waiting", s.task.revision);
  await s.auto.tick(); expect(s.auto.state().errors).toHaveLength(1);
  expect(s.f.repo.kernel.getTask(s.task.id).status).toBe("waiting");
  expect(s.days.taskItem(s.task.id, s.date)?.reportedMinutes).toBe(50);
});
it("holds accepted source updates for a paused task until an explicit manual continuation", async () => {
  const s = await reviewed(true); await s.auto.tick();
  const candidate = await source(s, s.task.id); await s.auto.tick(); await s.chats.flush();
  expect(s.store.candidate(candidate.id).status).toBe("applied");
  expect(s.store.candidate(candidate.id).chatDelivery?.state).toBe("pending");
  s.auto.manualOpen(s.task.id); await s.chats.flush();
  expect(s.store.candidate(candidate.id).chatDelivery?.state).toBe("sent");
});
it("preserves a manual time correction made after review while applying the task result", async () => {
  const s = await reviewed(), item = s.days.taskItem(s.task.id, s.date)!;
  s.days.edit({ id: item.id, revision: item.revision, reportedMinutes: 90, requestId: randomUUID() });
  await s.auto.tick(); expect(s.f.repo.kernel.getTask(s.task.id).status).toBe("done");
  expect(s.days.taskItem(s.task.id, s.date)?.reportedMinutes).toBe(90);
  expect(s.f.repo.session(s.session.id).extraction?.reportedTime).toBeFalsy();
});
it("recovers a pending automatic review after plugin reload without a second approval or time addition", async () => {
  const s = await reviewed(); await s.f.reload();
  const runtime = new SessionRuntime(s.f.bb, s.f.repo, async () => ({ codexReviewer: "gpt-5.6-sol", claudeReviewer: "claude-fable-5-1", maximumRepairs: 2, sessionMinutes: 20 }));
  const restored = new AutomaticWork(s.f.bb, s.f.repo, runtime, new SourceSyncStore(s.f.repo), new DayPlanning(s.f.repo), () => s.settings);
  await restored.tick(); const revision = s.f.repo.kernel.getTask(s.task.id).revision;
  await restored.tick(); expect(s.f.repo.kernel.getTask(s.task.id).revision).toBe(revision);
  expect(new DayPlanning(s.f.repo).taskItem(s.task.id, s.date)?.reportedMinutes).toBe(50);
});
it.each(["codex", "claude-code", "claude-work"])("does not expose checkpoints to %s workers after reload", async providerId => {
  const s = await setup(), { session } = await chat(s);
  await s.f.reload();
  const config = await s.f.harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({
    thread: { id: session.workerThreadId! }, origin: { pluginId: "247c" }, provider: { id: providerId },
  }));
  expect(config.tools.map(tool => tool.name)).not.toContain("c247_work_checkpoint");
  expect(config.instructions).toContain("Do not use work checkpoints");
  await expect(s.f.harness.behavior.callAgentTool("c247_work_checkpoint", { state: "ready", outcome: "done", note: "Done" },
    { threadId: session.workerThreadId!, projectId: "proj_personal", signal: new AbortController().signal })).rejects.toThrow();
  expect(s.f.repo.session(session.id).status).toBe("working");
});

it("releases the automatic worker slot after a reply without a checkpoint or review", async () => {
  const s = await setup(), first = await source(s);
  await s.auto.tick(); await s.chats.flush();
  const session = s.f.repo.forThread(s.store.candidate(first.id).chatDelivery!.threadId!)!;
  await s.f.idle(session.workerThreadId!, "Here is the answer. Which option do you prefer?");
  const later = new AutomaticWork(s.f.bb, s.f.repo, s.runtime, s.store, s.days, () => s.settings, () => new Date(Date.now() + 60000));
  await later.tick();
  expect(s.f.repo.session(session.id)).toMatchObject({ status: "working", finishedAt: null, reviewerThreadId: null,
    automation: { state: "needs_input", note: "The worker has replied. Open the chat to continue or finish the session." } });
  expect(s.f.repo.transcript(session.id)).toBeNull();
  const nextTask = await s.f.create("Another task"), next = await source(s, nextTask.id);
  await later.tick(); await s.chats.flush();
  expect(s.store.candidate(next.id).chatDelivery?.state).toBe("sent");
});

it("preserves parts left pending by an explicit human partial review", async () => {
  const s = await reviewed(), current = s.f.repo.session(s.session.id), proposal = s.f.repo.kernel.getProposal(current.proposalId!);
  await s.runtime.reviewParts({ kind: "proposal", id: proposal.id, revision: proposal.baseRevision, decision: "reject", parts: ["field:status"], requestId: randomUUID() });
  await s.auto.tick();
  expect(s.f.repo.kernel.getTask(s.task.id).status).toBe("open");
  expect(s.f.repo.session(s.session.id).status).toBe("awaiting_approval");
  expect(s.f.repo.session(s.session.id).automation?.appliedAt).toBeUndefined();
});

it.each([true, false])("requires Finish to classify the task with automatic mode %s and repairs an omitted status", async enabled => {
  const s = await setup(enabled), { session } = await chat(s);
  const quote = "The report was prepared; confirmation from the recipient is still pending.";
  await s.f.idle(session.workerThreadId!, quote); await s.f.harness.behavior.callRpc("finish", { sessionId: session.id });
  const reviewing = s.f.repo.session(session.id), ref = s.f.repo.transcript(session.id)!.messages.find(m => m.text === quote)!.ref;
  expect(reviewing.finishMode).toBe("resolve");
  const draft: Extraction = { rationale: "Preserve the report.", facts: [{ kind: "progress", text: quote, citations: [{ messageRef: ref, quote }] }], changes: { summary: { value: quote, evidenceRefs: ["fact:0"] } }, knowledge: [] };
  await s.f.idle(reviewing.reviewerThreadId!, draft);
  const repair = s.f.repo.session(session.id);
  expect(repair.extractionRepair?.feedback).toContain("choose changes.status=done or waiting");
  expect(repair.proposalId).toBeNull();
  if (!enabled) {
    expect(reviewing.automation).toBeUndefined();
    await s.f.reload();
    expect(s.f.repo.session(session.id).finishMode).toBe("resolve");
  }
  if (enabled) await s.runtime.tick(session.id);
  else await s.f.harness.behavior.callRpc("retry", { sessionId: session.id });
  const retry = s.f.repo.session(session.id);
  await s.f.idle(retry.reviewerThreadId!, { ...draft, changes: { ...draft.changes, status: { value: "waiting", evidenceRefs: ["fact:0"] } } });
  expect(s.f.repo.session(session.id)).toMatchObject({ status: "awaiting_approval", error: null });
  if (enabled) await s.auto.tick();
  if (!enabled) {
    expect(s.f.repo.kernel.getTask(session.taskId).status).toBe("open");
    const proposal = s.f.repo.kernel.getProposal(s.f.repo.session(session.id).proposalId!);
    await s.f.harness.behavior.callRpc("accept", { proposalId: proposal.id, revision: proposal.baseRevision });
  }
  expect(s.f.repo.kernel.getTask(session.taskId).status).toBe("waiting");
});
it("records Done in manual Finish without enabling automatic acceptance or changing time", async () => {
  const s = await setup(false), { task, session } = await chat(s);
  const date = s.days.today();
  s.days.add({ taskId: task.id, date, reportedMinutes: 45, requestId: randomUUID() });
  const quote = "The requested investigation and recommendation are complete.";
  await s.f.idle(session.workerThreadId!, quote);
  await s.f.harness.behavior.callRpc("finish", { sessionId: session.id });
  const reviewing = s.f.repo.session(session.id), ref = s.f.repo.transcript(session.id)!.messages.find(m => m.text === quote)!.ref;
  expect(reviewing.finishMode).toBe("resolve");
  expect(reviewing.automation).toBeUndefined();
  await s.f.idle(reviewing.reviewerThreadId!, { rationale: "The request is complete.",
    facts: [{ kind: "progress", text: quote, citations: [{ messageRef: ref, quote }] }], knowledge: [], reportedTime: null,
    changes: { status: { value: "done", evidenceRefs: ["fact:0"] } } });
  await s.auto.tick();
  expect(s.f.repo.kernel.getTask(task.id).status).toBe("open");
  const proposal = s.f.repo.kernel.getProposal(s.f.repo.session(session.id).proposalId!);
  await s.f.harness.behavior.callRpc("accept", { proposalId: proposal.id, revision: proposal.baseRevision });
  expect(s.f.repo.kernel.getTask(task.id).status).toBe("done");
  expect(s.days.taskItem(task.id, date)?.reportedMinutes).toBe(45);
  expect(s.auto.control().enabled).toBe(false);
});
it("keeps Pause independent of status classification even with automatic mode off", async () => {
  const s = await setup(false), { task, session } = await chat(s);
  const quote = "The local fix is ready; deployment can be continued later.";
  await s.f.idle(session.workerThreadId!, quote); await s.auto.pause(session.id);
  const reviewing = s.f.repo.session(session.id), ref = s.f.repo.transcript(session.id)!.messages.find(m => m.text === quote)!.ref;
  const draft: Extraction = { rationale: "Save the local work.", facts: [{ kind: "progress", text: quote, citations: [{ messageRef: ref, quote }] }],
    changes: { status: { value: "done", evidenceRefs: ["fact:0"] }, summary: { value: quote, evidenceRefs: ["fact:0"] } }, knowledge: [],
    reportedTime: { minutes: 20, reason: "Preparing and checking the local fix.", workSummary: "Prepared and checked the local fix.", evidenceRefs: ["fact:0"] } };
  await s.f.idle(reviewing.reviewerThreadId!, draft);
  const reviewed = s.f.repo.session(session.id);
  expect(reviewed).toMatchObject({ finishMode: "pause", status: "awaiting_approval" });
  expect(reviewed.extraction?.changes?.status).toBeUndefined();
  expect(reviewed.extraction?.reportedTime?.minutes).toBe(20);
  await s.runtime.accept(reviewed.proposalId!, s.f.repo.kernel.getTask(task.id).revision);
  expect(s.f.repo.kernel.getTask(task.id).status).toBe("open");
});
it("can leave a finished session pending without inventing completed work", async () => {
  const s = await setup(), { task, session } = await chat(s);
  await s.auto.finish(session.id);
  expect(s.f.repo.transcript(session.id)?.messages.some(m => m.role === "assistant")).toBe(false);
  const reviewing = s.f.repo.session(session.id);
  await s.f.idle(reviewing.reviewerThreadId!, { rationale: "The task is not complete; keep it pending after Finish session.", facts: [], knowledge: [], reportedTime: null,
    changes: { status: { value: "waiting", evidenceRefs: ["session:finish:pending"] } } });
  expect(s.f.repo.session(session.id).status).toBe("awaiting_approval");
  await s.auto.tick(); expect(s.f.repo.kernel.getTask(task.id).status).toBe("waiting");
  expect(s.f.repo.detail(task.id).facts).toHaveLength(1); // original description only
  expect(s.days.taskItem(task.id, s.days.today())?.reportedMinutes ?? null).toBeNull();
});

async function resolvedSource(s: Awaited<ReturnType<typeof setup>>, taskId: string, status: "done" | "waiting" = "done") {
  const { run } = await startSourceSync(s.f), { input } = await sourceData(s.f, run, taskId);
  input.suggestions[0].changes = { status: { value: status, evidenceRefs: ["fact:0"] }, summary: { value: "Resolved by the latest source update.", evidenceRefs: ["fact:0"] }, nextStep: { value: null, evidenceRefs: ["fact:0"] } };
  await submitSourceData(s.f, run, input);
  s.store.save({ ...s.store.run(run.id), status: "completed" });
  return s.store.pendingCandidates().find(c => c.runId === run.id)!;
}
it("finishes an idle work session on source completion and keeps reported time pending", async () => {
  const s = await setup(), { task, session } = await chat(s), date = s.days.today();
  const quote = "Checked the report and prepared a local correction.";
  s.days.add({ taskId: task.id, date, reportedMinutes: 50, requestId: randomUUID() });
  await s.f.idle(session.workerThreadId!, quote);
  const candidate = await resolvedSource(s, task.id);
  const finish = vi.spyOn(s.runtime, "finish");
  await s.auto.tick(); await s.auto.tick();
  expect(finish).toHaveBeenCalledTimes(1);
  expect(s.store.candidate(candidate.id).status).toBe("applied");
  const reviewing = s.f.repo.session(session.id);
  expect(reviewing).toMatchObject({ finishMode: "source", status: "reviewing", automation: { state: "reviewing" } });
  const transcript = s.f.repo.transcript(session.id)!;
  const ref = transcript.messages.find(m => m.text === quote)!.ref;
  expect(JSON.stringify(s.f.conversations.get(reviewing.reviewerThreadId!)![0])).toContain("SOURCE RESOLUTION");
  await s.f.idle(reviewing.reviewerThreadId!, { rationale: "Record the local investigation.",
    facts: [{ kind: "progress", text: quote, citations: [{ messageRef: ref, quote }] }], knowledge: [],
    changes: { status: { value: "waiting", evidenceRefs: ["fact:0"] }, summary: { value: "Outdated pending context", evidenceRefs: ["fact:0"] } },
    reportedTime: { minutes: 25, reason: "Report investigation and local correction.", workSummary: "Checked the report and prepared a local correction.", evidenceRefs: ["fact:0"] } });
  await s.auto.tick();
  const reviewed = s.f.repo.session(session.id);
  expect(s.f.repo.kernel.getTask(task.id).status).toBe("done");
  expect(s.f.repo.kernel.getDossier(task.id).projection.summary).toBe("Resolved by the latest source update.");
  expect(s.days.taskItem(task.id, date)?.reportedMinutes).toBe(50);
  expect(proposalParts(s.f.repo.kernel.getProposal(reviewed.proposalId!).changes, reviewed.extraction!)).toEqual(["reportedTime"]);
  expect(s.f.threads.get(session.workerThreadId!)?.archivedAt).toBeTruthy();
  const revision = s.f.repo.kernel.getTask(task.id).revision;
  await s.auto.acceptSource(candidate.id); await s.auto.tick();
  expect(s.f.repo.kernel.getTask(task.id).revision).toBe(revision);
  expect(s.f.repo.sessions(task.id)).toHaveLength(1);
  expect(s.auto.state().errors).toEqual([]);
});
it("accepts Done in the shared inbox without a separate Finish click when automatic work is off", async () => {
  const s = await setup(false), { task, session } = await chat(s);
  await s.f.idle(session.workerThreadId!, "Checked the source.");
  const candidate = await resolvedSource(s, task.id);
  const page = await s.f.harness.behavior.callRpc("proposalInbox", { offset: 0 }) as { items: { blockedReason: string | null }[] };
  expect(page.items[0].blockedReason).toBeNull();
  const result = await s.f.harness.behavior.callRpc("acceptInbox", { items: [{ kind: "source", id: candidate.id, revision: candidate.baseRevision }] });
  expect(result).toMatchObject({ failed: [], applied: [{ id: candidate.id, taskId: task.id }] });
  expect(s.f.repo.session(session.id)).toMatchObject({ finishMode: "source", status: "reviewing" });
  expect(s.f.repo.kernel.getTask(task.id).status).toBe("done");
});
it("finishes when only Done is accepted while keeping the other source changes pending", async () => {
  const s = await setup(false), { task, session } = await chat(s);
  await s.f.idle(session.workerThreadId!, "Checked the source.");
  const candidate = await resolvedSource(s, task.id);
  const result = await s.f.harness.behavior.callRpc("reviewParts", { kind: "source", id: candidate.id, revision: candidate.baseRevision, decision: "accept", parts: ["field:status"], requestId: randomUUID() }) as { remainingId: string };
  expect(s.f.repo.kernel.getTask(task.id).status).toBe("done");
  expect(s.f.repo.session(session.id)).toMatchObject({ finishMode: "source", status: "reviewing" });
  expect(s.store.candidate(result.remainingId).changes.summary).toBeTruthy();
});
it("does not finish when Done is unselected or rejected", async () => {
  const s = await setup(false), { task, session } = await chat(s);
  await s.f.idle(session.workerThreadId!, "Checked the source.");
  const candidate = await resolvedSource(s, task.id);
  const result = await s.auto.reviewSourceParts({ kind: "source", id: candidate.id, revision: candidate.baseRevision, decision: "accept", parts: ["field:summary"], requestId: randomUUID() });
  expect(s.f.repo.session(session.id).finishedAt).toBeNull();
  const remaining = s.store.candidate(result.remainingId!);
  await s.auto.reviewSourceParts({ kind: "source", id: remaining.id, revision: remaining.baseRevision, decision: "reject", parts: ["field:status"], requestId: randomUUID() });
  expect(s.f.repo.kernel.getTask(task.id).status).toBe("open");
  expect(s.f.repo.session(session.id).finishedAt).toBeNull();
});
it("waits for active turns, queued messages, approvals and background agents", async () => {
  const s = await setup(), { task, session } = await chat(s), threadId = session.workerThreadId!;
  const candidate = await resolvedSource(s, task.id);
  await s.auto.tick(); expect(s.store.candidate(candidate.id).status).toBe("pending");
  await expect(s.auto.acceptSource(candidate.id)).rejects.toThrow(/busy/);
  await s.f.idle(threadId, "Checked the source.");
  s.f.queued.set(threadId, [{ id: "queued" }] as never);
  await s.auto.tick(); expect(s.f.repo.session(session.id).finishedAt).toBeNull();
  s.f.queued.set(threadId, []);
  s.f.harness.sdk.stub("threads.interactions.list", () => [{ id: "approval" }] as never);
  await s.auto.tick(); expect(s.f.repo.session(session.id).finishedAt).toBeNull();
  s.f.harness.sdk.stub("threads.interactions.list", () => []);
  s.f.threads.set(threadId, { ...s.f.threads.get(threadId)!, activeBackgroundAgentCount: 1 });
  await s.auto.tick(); expect(s.f.repo.session(session.id).finishedAt).toBeNull();
  s.f.threads.set(threadId, { ...s.f.threads.get(threadId)!, activeBackgroundAgentCount: 0 });
  s.f.repo.saveSession({ ...s.f.repo.session(session.id), automation: { state: "needs_input", note: "The worker has replied." } });
  await s.auto.tick(); expect(s.store.candidate(candidate.id).status).toBe("applied");
  expect(s.auto.state().errors).toEqual([]);
});
it("rechecks new user input during recorder selection before freezing a session", async () => {
  const s = await setup(), { task, session } = await chat(s), threadId = session.workerThreadId!;
  await s.f.idle(threadId, "Checked the source.");
  const candidate = await resolvedSource(s, task.id);
  const models = await s.f.bb.sdk.providers.models({ providerId: "codex" });
  s.f.harness.sdk.stub("providers.models", async () => { s.f.message(threadId, "user", "Wait, another issue."); return models; });
  await s.auto.tick();
  expect(s.f.repo.session(session.id).finishedAt).toBeNull();
  expect(s.store.candidate(candidate.id).status).toBe("pending");
});
it("rolls back finishing and time capture when the source becomes stale during model selection", async () => {
  const s = await setup(), { task, session } = await chat(s);
  await s.f.idle(session.workerThreadId!, "Checked the source.");
  const candidate = await resolvedSource(s, task.id);
  const models = await s.f.bb.sdk.providers.models({ providerId: "codex" });
  s.f.harness.sdk.stub("providers.models", async () => { s.f.repo.kernel.appendFact({ taskId: task.id, kind: "user_instruction", text: "Keep the new scope.", source: "human:test" }); return models; });
  await s.auto.tick();
  expect(s.f.repo.session(session.id)).toMatchObject({ status: "working", finishedAt: null });
  expect(s.f.repo.transcript(session.id)).toBeNull();
  expect(s.f.repo.session(session.id).reportedTimeContext).toBeUndefined();
  expect(s.store.candidate(candidate.id).status).toBe("pending");
  expect(s.f.repo.kernel.getTask(task.id).status).toBe("open");
  expect(s.auto.state().errors).toHaveLength(1);
});
it("retains source completion and the frozen transcript if review startup fails, and recovers after reload", async () => {
  const s = await setup(), { task, session } = await chat(s);
  await s.f.idle(session.workerThreadId!, "Checked the source.");
  const candidate = await resolvedSource(s, task.id);
  s.f.harness.sdk.stub("threads.spawn", async () => { throw new Error("Review runtime unavailable"); });
  await s.auto.tick();
  expect(s.store.candidate(candidate.id).status).toBe("applied");
  expect(s.f.repo.session(session.id)).toMatchObject({ finishMode: "source", status: "blocked" });
  const transcript = s.f.repo.transcript(session.id);
  expect(transcript?.messages.length).toBeGreaterThan(0);
  await s.f.reload();
  await s.f.harness.behavior.callRpc("retry", { sessionId: session.id, recorder: "auto" });
  expect(s.f.repo.session(session.id)).toMatchObject({ finishMode: "source", status: "reviewing" });
  expect(s.f.repo.kernel.getTask(task.id).status).toBe("done");
  expect(s.f.repo.transcript(session.id)).toEqual(transcript);
});
it("keeps legacy explicit input requests open until the user accepts the resolving source", async () => {
  const s = await setup(), { task, session } = await chat(s);
  await s.f.idle(session.workerThreadId!, "Please approve the external change.");
  legacyCheckpoint(s, session.workerThreadId!, { state: "needs_input", requestedAt: new Date().toISOString(), note: "Approve the prepared change." });
  const candidate = await resolvedSource(s, task.id);
  await s.auto.tick(); expect(s.f.repo.session(session.id).finishedAt).toBeNull();
  await s.auto.acceptSource(candidate.id);
  expect(s.f.repo.kernel.getTask(task.id).status).toBe("done");
});
it.each([true, false])("accepts a waiting source update without finishing the session, automatic=%s", async automatic => {
  const s = await setup(automatic), { task, session } = await chat(s);
  await s.f.idle(session.workerThreadId!, "Prepared the requested draft.");
  const candidate = await resolvedSource(s, task.id, "waiting");
  if (automatic) await s.auto.tick();
  else await s.auto.acceptSource(candidate.id);
  expect(s.store.candidate(candidate.id).status).toBe("applied");
  expect(s.f.repo.kernel.getTask(task.id).status).toBe("waiting");
  expect(s.f.repo.session(session.id)).toMatchObject({ status: "working", finishedAt: null, reviewerThreadId: null });
  expect(s.f.repo.transcript(session.id)).toBeNull();
});
it("can accept only the source waiting status without ending the conversation", async () => {
  const s = await setup(false), { task, session } = await chat(s);
  const candidate = await resolvedSource(s, task.id, "waiting");
  const result = await s.f.harness.behavior.callRpc("reviewParts", { kind: "source", id: candidate.id, revision: candidate.baseRevision, decision: "accept", parts: ["field:status"], requestId: randomUUID() }) as { remainingId: string };
  expect(s.f.repo.kernel.getTask(task.id).status).toBe("waiting");
  expect(s.store.candidate(result.remainingId).changes.summary).toBeTruthy();
  expect(s.f.repo.session(session.id)).toMatchObject({ status: "working", finishedAt: null, reviewerThreadId: null });
});
it("delivers ordinary incoming updates to a ready chat without finishing it", async () => {
  const s = await setup(), { task, session } = await chat(s), threadId = session.workerThreadId!;
  await s.f.idle(threadId, "The work is ready.");
  legacyCheckpoint(s, threadId, { state: "ready", outcome: "done", note: "The work is ready." });
  const candidate = await source(s, task.id);
  await s.auto.tick(); await s.chats.flush();
  expect(s.store.candidate(candidate.id)).toMatchObject({ status: "applied", chatDelivery: { state: "sent", threadId } });
  expect(s.f.repo.session(session.id)).toMatchObject({ status: "working", finishedAt: null, reviewerThreadId: null });
  expect(s.f.repo.sessions(task.id)).toHaveLength(1);
});
