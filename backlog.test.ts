import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { fixture } from "./test-support.js";
import { backlogRpcContract, type BacklogRun } from "./backlog-contracts.js";
import { BacklogReview } from "./backlog.js";
import { ThreadRouting } from "./thread-routing.js";
import { connectorCall, sourceData } from "./source-sync-test-support.js";
import type { SyncRun } from "./contracts.js";

const hosts: Awaited<ReturnType<typeof fixture>>[] = [];
const settings = { backlogProvider: "claude-work", backlogModel: "claude-opus-5[1m]", threadProjectId: "proj_tasks", threadInstructions: "" };
async function setup() {
  const f = await fixture({ settings }); hosts.push(f);
  f.harness.inspection.sdk.stub("projects.get", ({ projectId }) => ({ id: projectId, kind: "standard", sources: [{ id: "source_tasks", type: "local_path", hostId: "host_test", path: "/work/tasks", isDefault: true }] }));
  return f;
}
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); for (const f of hosts.splice(0)) await f.harness.lifecycle.dispose(); });
type F = Awaited<ReturnType<typeof setup>>;
const start = async (f: F, taskIds: string[], requestId: string = randomUUID()) => backlogRpcContract.backlogStart.output.parse(await f.harness.behavior.callRpc("backlogStart", { taskIds, requestId }));
const state = async (f: F) => backlogRpcContract.backlogState.output.parse(await f.harness.behavior.callRpc("backlogState", {}));
async function tool(f: F, run: BacklogRun, name: string, input: unknown = {}) {
  const result = await f.harness.behavior.callAgentTool(`c247_backlog_${name}`, input, { threadId: run.threadId!, projectId: settings.threadProjectId, signal: new AbortController().signal });
  return JSON.parse(result as string);
}
const unread = (taskId: string) => ({ taskId, finding: { outcome: "unverified", summary: "Source is unavailable.", action: "Retry when access is restored.", sourceStatus: "unavailable", sourceDetail: "The source could not be loaded." }, facts: [], changes: null });
async function evidence(f: F, run: BacklogRun, taskId: string) {
  const data = await sourceData(f, { ...run, until: new Date().toISOString() } as unknown as SyncRun, taskId);
  const draft = data.input.suggestions[0];
  return { taskId, finding: { outcome: "ready", summary: draft.rationale, action: "Prepare the report.", sourceStatus: "checked", sourceDetail: "Read the current Gmail conversation." }, facts: draft.facts, changes: draft.changes };
}

it("starts exactly the selected tasks on the corporate account and replays a double click safely", async () => {
  const f = await setup(), a = await f.create(), b = await f.create(), other = await f.create();
  const requestId = randomUUID();
  const [first, replay] = await Promise.all([start(f, [a.id, b.id], requestId), start(f, [b.id, a.id], requestId)]);
  expect(first.id).toBe(replay.id);
  expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
  expect(f.harness.inspection.sdk.callsTo("threads.spawn")[0][0]).toMatchObject({ providerId: "claude-work", model: settings.backlogModel, projectId: settings.threadProjectId, visibility: "visible" });
  expect((await tool(f, first, "next", { includeIndex: true })).selectedTasks.map((t: { taskId: string }) => t.taskId).sort()).toEqual([a.id, b.id].sort());
  await expect(tool(f, first, "dossier", { taskId: other.id })).rejects.toThrow(/not selected/);
  await expect(start(f, [a.id])).rejects.toThrow(/already running/);
  await expect(start(f, [other.id], requestId)).rejects.toThrow(/different selection/);
});

it.each(["codex", "claude-code", "missing-provider"])("never falls back from an invalid corporate provider: %s", async provider => {
  const f = await setup(), task = await f.create();
  await f.harness.behavior.setSettings({ backlogProvider: provider });
  await expect(start(f, [task.id])).rejects.toThrow(/corporate|unavailable/i);
  expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
  expect((await state(f)).run).toBeNull();
});

it("retains partial findings across a plugin reload and rejects late submissions after stop", async () => {
  const f = await setup(), a = await f.create(), b = await f.create(), run = await start(f, [a.id, b.id]);
  await expect(tool(f, run, "submit", unread(a.id))).rejects.toThrow(/dossier/);
  await tool(f, run, "dossier", { taskId: a.id });
  await tool(f, run, "submit", unread(a.id));
  await f.reload();
  expect((await state(f)).run).toMatchObject({ id: run.id, checked: 1, total: 2, unverified: 1 });
  expect((await tool(f, run, "next")).task.taskId).toBe(b.id);
  await f.harness.behavior.callRpc("backlogStop", { runId: run.id });
  await expect(tool(f, run, "submit", unread(b.id))).rejects.toThrow(/stopped/);
  expect((await state(f)).run?.status).toBe("stopped");
  expect((await state(f)).items.find(i => i.taskId === b.id)?.result).toBeNull();
  expect(f.repo.kernel.getTask(a.id)).toEqual(a);
});

it("requires fresh source proof and leaves valid changes pending until human acceptance", async () => {
  const f = await setup(), task = await f.create(), run = await start(f, [task.id]);
  await tool(f, run, "dossier", { taskId: task.id });
  const input = await evidence(f, run, task.id);
  const forged = structuredClone(input); forged.facts[0].citations[0].quote = "Fabricated completion.";
  await expect(tool(f, run, "submit", forged)).rejects.toThrow(/quote is absent/);
  const result = await tool(f, run, "submit", input);
  expect(result).toMatchObject({ remaining: 0, canonicalTasksChanged: 0 });
  expect(f.repo.kernel.getTask(task.id)).toEqual(task);
  expect(f.repo.kernel.getProposal(result.proposalId).status).toBe("pending");
  expect((await state(f)).run?.status).toBe("completed");
  expect((await state(f)).items[0].sources[0].url).toContain("mail.google.com");
  expect(await tool(f, run, "submit", input)).toEqual(result);
  expect((await tool(f, run, "next")).remaining).toBe(0);
  f.repo.accept(result.proposalId, task.revision);
  expect(f.repo.kernel.getDossier(task.id).projection.nextStep).toBe(input.changes.nextStep!.value);
});

it.each(["clickup", "outlook", "teams"] as const)("uses verified %s reads in a backlog proposal", async source => {
  const f = await setup(), task = await f.create(), run = await start(f, [task.id]);
  await tool(f, run, "dossier", { taskId: task.id });
  const quote = "Please prepare the report.";
  const url = source === "clickup" ? "https://app.clickup.com/123/docs/doc/page"
    : source === "outlook" ? "https://outlook.cloud.microsoft/mail/id/message"
    : "https://teams.microsoft.com/l/message/chat/message";
  const args = source === "clickup" ? { document_id: "doc", page_ids: ["page"] }
    : { uri: source === "outlook" ? "mail:///messages/message" : "teams:///chats/chat/messages/message" };
  connectorCall(f, run.threadId!, source === "clickup" ? "claude_ai_ClickUp.clickup_get_document_pages" : "claude_ai_Microsoft_365.read_resource",
    args, { id: "message", chatId: "chat", webUrl: url, content: quote });
  const calls = await tool(f, run, "calls");
  expect(calls.calls).toHaveLength(1);
  expect(calls.calls[0]).toMatchObject({ source, read: true, completed: true, truncated: false });
  const citation = { callRef: calls.calls[0].ref, source, url, messageId: "message", occurredAt: new Date(run.startedAt - 1000).toISOString(), quote };
  const input = { taskId: task.id,
    finding: { outcome: "ready", summary: "The report was requested.", action: "Prepare the report.", sourceStatus: "checked", sourceDetail: "Read the linked source." },
    facts: [{ kind: "explicit_next_step", text: "Prepare the report.", citations: [citation] }],
    changes: { nextStep: { value: "Prepare the report.", evidenceRefs: ["fact:0"] } } };
  const forged = structuredClone(input); forged.facts[0].citations[0].quote = "Invented completion.";
  await expect(tool(f, run, "submit", forged)).rejects.toThrow(/quote is absent/);
  const badLink = structuredClone(input); badLink.facts[0].citations[0].url = "https://example.com/message";
  await expect(tool(f, run, "submit", badLink)).rejects.toThrow(/source link/);
  const saved = await tool(f, run, "submit", input);
  expect(saved).toMatchObject({ saved: true, canonicalTasksChanged: 0 });
  expect(f.repo.kernel.getProposal(saved.proposalId).status).toBe("pending");
  expect(f.repo.kernel.getTask(task.id)).toEqual(task);
  expect((await state(f)).items[0].sources).toEqual([{ url, label: source }]);
});

it("does not replace a pending proposal or repeat an unchanged rejected recommendation", async () => {
  const f = await setup(), task = await f.create(), first = await start(f, [task.id]);
  await tool(f, first, "dossier", { taskId: task.id });
  const input = await evidence(f, first, task.id), result = await tool(f, first, "submit", input);
  const second = await start(f, [task.id]);
  await tool(f, second, "dossier", { taskId: task.id });
  const same = await evidence(f, second, task.id);
  // Preserve source event timestamps, independent of the fresh connector receipt.
  same.facts.forEach((fact, i) => { fact.citations[0].occurredAt = input.facts[i].citations[0].occurredAt; });
  expect((await tool(f, second, "submit", same)).proposalId).toBe(result.proposalId);
  expect((await state(f)).items[0].proposalNote).toContain("did not create another");
  f.repo.reject(result.proposalId);
  const third = await start(f, [task.id]);
  await tool(f, third, "dossier", { taskId: task.id });
  const repeat = await evidence(f, third, task.id);
  repeat.facts.forEach((fact, i) => { fact.citations[0].occurredAt = input.facts[i].citations[0].occurredAt; });
  expect((await tool(f, third, "submit", repeat)).proposalId).toBe(result.proposalId);
  expect(f.repo.kernel.listProposals(task.id)).toHaveLength(1);
  expect((await state(f)).items[0].proposalStatus).toBe("rejected");
});

it("marks a revision changed during review unverified instead of overwriting it", async () => {
  const f = await setup(), task = await f.create(), run = await start(f, [task.id]);
  await tool(f, run, "dossier", { taskId: task.id });
  const change = f.repo.propose({ taskId: task.id, revision: task.revision, requestId: randomUUID(), draft: { rationale: "User correction", confidence: 1, changes: { summary: { value: "Edited by user", evidenceRefs: [f.repo.detail(task.id).facts[0].id] } } } }, "test");
  f.repo.accept(change.id, task.revision);
  await expect(tool(f, run, "submit", await evidence(f, run, task.id))).rejects.toThrow(/changed during review/);
  await tool(f, run, "submit", unread(task.id));
  expect((await state(f)).items[0]).toMatchObject({ stale: true, proposalId: null, result: { outcome: "unverified" } });
  expect(f.repo.kernel.getDossier(task.id).projection.summary).toBe("Edited by user");
});

it("requires complete linked chat pages and refuses fabricated source coverage", async () => {
  const f = await setup(), task = await f.create();
  const session = await f.start(task.id, task.revision);
  f.message(session.workerThreadId!, "assistant", "Still working. ".repeat(2000));
  const run = await start(f, [task.id]);
  await tool(f, run, "dossier", { taskId: task.id });
  const input = await evidence(f, run, task.id);
  await expect(tool(f, run, "submit", input)).rejects.toThrow(/Unread chats/);
  await expect(tool(f, run, "chat", { taskId: task.id, threadId: session.workerThreadId, offset: 16000 })).rejects.toThrow(/in order/);
  let offset = 0;
  do { offset = (await tool(f, run, "chat", { taskId: task.id, threadId: session.workerThreadId, offset })).nextOffset; } while (offset !== null);
  expect((await tool(f, run, "submit", input)).saved).toBe(true);
});

it("retains an uncertain launch without spawning a duplicate and recovers its thread", async () => {
  const f = await setup(), task = await f.create();
  f.harness.inspection.sdk.stub("threads.spawn", () => { throw new Error("Lost response"); });
  const run = await start(f, [task.id]);
  expect(run.status).toBe("starting");
  expect(run.error).toContain("could not be confirmed");
  await start(f, [task.id], run.requestId);
  expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
  const service = new BacklogReview(f.bb, f.repo, new ThreadRouting(f.bb, async () => settings.threadProjectId), () => settings);
  service.created({ id: "recovered", title: run.title, originPluginId: "247c", providerId: "claude-work" });
  expect((await state(f)).run).toMatchObject({ threadId: "recovered", status: "running", error: null });
});

it("records an interrupted review without losing findings", async () => {
  const f = await setup(), task = await f.create(), run = await start(f, [task.id]);
  await f.idle(run.threadId!, "Interrupted.");
  const service = new BacklogReview(f.bb, f.repo, new ThreadRouting(f.bb, async () => settings.threadProjectId), () => settings);
  vi.useFakeTimers({ toFake: ["Date"] }); await service.tick();
  vi.setSystemTime(Date.now() + 31000); await service.tick();
  expect((await state(f)).run).toMatchObject({ status: "partial", checked: 0 });
  expect((await state(f)).items[0].result).toBeNull();
});

it("paginates source call receipts without returning source bodies", async () => {
  const f = await setup(), task = await f.create(), run = await start(f, [task.id]);
  for (let i = 0; i < 21; i++) connectorCall(f, run.threadId!, "mcp__Gmail__get_thread", { threadId: `mail-${i}` }, "Private source body");
  const first = await tool(f, run, "calls");
  expect(first.calls).toHaveLength(20); expect(first.nextOffset).toBe(20);
  expect(JSON.stringify(first)).not.toContain("Private source body");
  expect((await tool(f, run, "calls", { offset: 20 })).calls).toHaveLength(1);
});

it("refreshes the local closure preference during an existing review without another model launch", async () => {
  const f = await setup(), task = await f.create(), run = await start(f, [task.id]);
  const first = await tool(f, run, "next");
  expect(first.reviewPolicy).not.toContain("Local review preference: prefer closure");
  await f.harness.behavior.setSettings({ backlogPreferClosure: true });
  expect((await tool(f, run, "next")).reviewPolicy).toContain("Local review preference: prefer closure");
  expect((await tool(f, run, "dossier", { taskId: task.id })).instructions).toContain("Resolve residual doubt in favor of closing");
  expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
});

it("clears an obsolete next step in a closure proposal and keeps retries idempotent", async () => {
  const f = await setup(), initial = await f.create();
  const step = f.repo.note({ taskId: initial.id, revision: initial.revision, kind: "explicit_next_step", text: "Independently verify the supplied link.", requestId: randomUUID() });
  const revision = f.repo.kernel.getTask(initial.id).revision;
  const previous = f.repo.propose({ taskId: initial.id, revision, requestId: randomUUID(), draft: { rationale: "Old step", confidence: 1, changes: { nextStep: { value: step.text, evidenceRefs: [step.id] } } } }, "test");
  f.repo.accept(previous.id, revision);
  const task = f.repo.kernel.getTask(initial.id), run = await start(f, [task.id]);
  await tool(f, run, "dossier", { taskId: task.id });
  const data = await evidence(f, run, task.id);
  const input = { ...data, finding: { ...data.finding, outcome: "close", summary: "Requested link supplied.", action: "Close task." }, changes: { status: { value: "done", evidenceRefs: ["fact:0"] } } };
  const result = await tool(f, run, "submit", input);
  expect(f.repo.kernel.getProposal(result.proposalId).changes.nextStep).toEqual({ value: null, evidenceRefs: ["fact:0"] });
  expect(f.repo.detail(task.id).projection.nextStep).toBe(step.text);
  expect(await tool(f, run, "submit", input)).toEqual(result);
  f.repo.accept(result.proposalId, task.revision);
  expect(f.repo.detail(task.id).projection.nextStep).toBeNull();
  expect((await state(f)).items[0].taskStatus).toBe("done");
});

it("refuses closing while explicitly proposing outstanding work", async () => {
  const f = await setup(), task = await f.create(), run = await start(f, [task.id]);
  await tool(f, run, "dossier", { taskId: task.id });
  const input = await evidence(f, run, task.id);
  input.finding.outcome = "close";
  input.changes.status = { value: "done", evidenceRefs: ["fact:0"] };
  await expect(tool(f, run, "submit", input)).rejects.toThrow(/no remaining next step/);
  expect(f.repo.kernel.listProposals(task.id)).toHaveLength(0);
});
