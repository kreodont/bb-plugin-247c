// @vitest-environment jsdom
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import * as collector from "./source-collector.js";
import { act, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { CapturedPluginApp, RenderedSlot } from "@get-bb/plugin-sdk/testing/app";
import { randomUUID } from "node:crypto";
import { fixture } from "./test-support.js";
import { rpcContract } from "./contracts.js";
import { SourceSyncStore } from "./source-sync.js";
import { DayPlanning } from "./day-planning.js";
import { sourceData, startSourceSync, submitSourceData } from "./source-sync-test-support.js";

let app: CapturedPluginApp;
const mounts: RenderedSlot[] = [];
const hosts: Awaited<ReturnType<typeof fixture>>[] = [];
beforeAll(async () => { app = await loadPluginApp(() => import("./app.js")); }, 60000);
afterEach(async () => { for (const m of mounts.splice(0)) m.lifecycle.unmount(); for (const f of hosts.splice(0)) await f.harness.lifecycle.dispose(); vi.restoreAllMocks(); vi.useRealTimers(); });
async function setup(taskId?: string, supplied?: Awaited<ReturnType<typeof fixture>>) {
  const f = supplied ?? await fixture(); if (!hosts.includes(f)) hosts.push(f);
  const rpc = Object.fromEntries(Object.keys(rpcContract).map((name) => [name, (input: unknown) => f.harness.behavior.callRpc(name, input)]));
  const slot = renderSlot(app.navPanels[0], { subPath: taskId ?? "" }, { rpc });
  mounts.push(slot);
  return { f, slot };
}

it("shows the saved source directly below the title across dossier tabs", async () => {
  const f = await fixture(); const { run } = await startSourceSync(f); const { input } = await sourceData(f, run);
  await submitSourceData(f, run, input);
  const candidate = new SourceSyncStore(f.repo).candidates()[0];
  await f.harness.behavior.callRpc("syncAccept", { candidateId: candidate.id });
  const task = f.repo.list().tasks[0];
  const { slot } = await setup(task.id, f);
  const sources = await slot.findByRole("navigation", { name: "Task sources" });
  const links = within(sources).getAllByRole("link");
  expect(links).toHaveLength(1);
  expect(links[0].textContent).toContain("Gmail message");
  expect(links[0].getAttribute("href")).toBe(input.suggestions[0].facts[0].citations[0].url);
  expect(links[0].getAttribute("target")).toBe("_blank");
  expect(links[0].getAttribute("rel")).toBe("noopener noreferrer");
  expect(links[0].getAttribute("title")).toContain("Original task source");
  expect(slot.getByRole("heading", { name: task.title }).compareDocumentPosition(sources) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(sources.compareDocumentPosition(slot.getByRole("tablist", { name: "Task sections" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  fireEvent.click(slot.getByRole("tab", { name: "History" }));
  expect(within(slot.getByRole("navigation", { name: "Task sources" })).getAllByRole("link")).toHaveLength(1);
});

it("expands additional saved sources and omits an empty source bar", async () => {
  const f = await fixture(); const task = await f.create(); const { slot } = await setup(task.id, f);
  await slot.findByRole("heading", { name: task.title });
  expect(slot.queryByRole("navigation", { name: "Task sources" })).toBeNull();
  for (let n = 0; n < 5; n++) f.repo.kernel.appendFact({ taskId: task.id, kind: "description", text: `Imported context ${n}`, source: "imported", sourceRef: `https://example.com/message/${n}` });
  await slot.behavior.emitRealtime("desk-changed", {});
  const sources = await slot.findByRole("navigation", { name: "Task sources" });
  expect(within(sources).getAllByRole("link")).toHaveLength(3);
  const more = within(sources).getByRole("button", { name: "+2 more" });
  expect(more.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(more);
  expect(within(sources).getAllByRole("link")).toHaveLength(5);
  fireEvent.click(within(sources).getByRole("button", { name: "Show less" }));
  expect(within(sources).getAllByRole("link")).toHaveLength(3);
});

it.each(["work", "updates"])("opens the %s composer in the configured thread project", async page => {
  const f = await fixture(); const task = await f.create();
  await f.harness.behavior.setSettings({ threadProjectId: "proj_tasks", composerDefaults: JSON.stringify({ providerId: "claude-work", model: "claude-opus-5[1m]" }) });
  const { slot } = await setup(page === "work" ? task.id : "updates", f);
  fireEvent.click(await slot.findByRole(page === "work" ? "tab" : "button", { name: page === "work" ? "Work" : "Check for updates" }));
  const composer = await slot.findByTestId("bb-new-thread-composer");
  expect(composer.getAttribute("data-default-project-id")).toBe("proj_tasks");
  expect(JSON.parse(composer.getAttribute("data-default-environment")!)).toEqual({ type: "project-default" });
  expect(composer.getAttribute("data-default-provider-id")).toBe("claude-work");
  expect(composer.getAttribute("data-default-model")).toBe("claude-opus-5[1m]");
  expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
});


it("leaves new work account and model selection to BB when no local defaults are configured", async () => {
  const f = await fixture(); const task = await f.create();
  const { slot } = await setup(task.id, f);
  fireEvent.click(await slot.findByRole("tab", { name: "Work" }));
  const composer = await slot.findByTestId("bb-new-thread-composer");
  expect(composer.getAttribute("data-default-provider-id")).toBe("");
  expect(composer.getAttribute("data-default-model")).toBe("");
  expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
});

it("submits the displayed corporate Opus selection explicitly to BB", async () => {
  const f = await fixture(); const task = await f.create();
  await f.harness.behavior.setSettings({ threadProjectId: "proj_tasks", composerDefaults: JSON.stringify({ providerId: "claude-work", model: "claude-opus-5[1m]" }) });
  f.harness.inspection.sdk.stub("projects.get", () => ({ id: "proj_tasks", kind: "standard", sources: [{ type: "local_path", hostId: "host_test", path: "/work", isDefault: true }] }));
  const { slot } = await setup(task.id, f);
  fireEvent.click(await slot.findByRole("tab", { name: "Work" }));
  await slot.findByTestId("bb-new-thread-composer");
  fireEvent.change(slot.getByTestId("bb-new-thread-composer-input"), { target: { value: "Continue the task" } });
  fireEvent.click(slot.getByTestId("bb-new-thread-composer-submit"));
  await waitFor(() => expect(f.repo.sessions(task.id)[0]?.status).toBe("working"));
  expect(f.harness.inspection.sdk.callsTo("threads.spawn")[0][0]).toMatchObject({
    projectId: "proj_tasks", providerId: "claude-work", model: "claude-opus-5[1m]",
    executionInputSources: { providerId: "explicit", model: "explicit" },
  });
});

it("reviews new tasks and existing task updates together and accepts the selected list", async () => {
  const f = await fixture(); const task = await f.create();
  const { run } = await startSourceSync(f); const { input } = await sourceData(f, run, task.id);
  const fresh = structuredClone(input.suggestions[0]); fresh.taskId = null; fresh.title = "Новая просьба из письма";
  input.suggestions.push(fresh); await submitSourceData(f, run, input);
  const { slot } = await setup("proposals", f);
  await slot.findByRole("heading", { name: "Proposals · 2" });
  expect(f.repo.list().total).toBe(1); expect(f.repo.list().pendingTotal).toBe(2);
  expect(slot.getByText("New task")).toBeTruthy();
  fireEvent.click(slot.getByRole("button", { name: "Expand all" }));
  expect(slot.getAllByText("After").length).toBeGreaterThan(0);
  expect(slot.getAllByText("Before").length).toBeGreaterThan(0);
  fireEvent.click(slot.getByRole("checkbox", { name: "Select all" }));
  expect(slot.getByText("Selected: 2 · new tasks: 1")).toBeTruthy();
  fireEvent.click(slot.getByRole("button", { name: "Accept selected · 2" }));
  await slot.findByText("Accepted: 2.");
  await slot.findByRole("heading", { name: "Everything reviewed" });
  expect(f.repo.list().total).toBe(2); expect(f.repo.pendingTotal()).toBe(0);
  expect(slot.inspection.rpcCalls.filter(c => c.method === "acceptInbox")).toHaveLength(1);
  expect(slot.inspection.navigateCalls).toHaveLength(0);
});

it("counts new-task suggestions in the prominent home link before a task exists", async () => {
  const f = await fixture(); const { run } = await startSourceSync(f); const { input } = await sourceData(f, run); await submitSourceData(f, run, input);
  const { slot } = await setup(undefined, f);
  const button = await slot.findByRole("button", { name: "Proposals · 1" });
  fireEvent.click(button);
  expect(JSON.stringify(slot.inspection.navigateCalls)).toContain('"proposals"');
  expect(f.repo.list().total).toBe(0);
});

it("keeps session proposals in the same inbox and excludes stale entries from select all", async () => {
  const f = await fixture(); const task = await f.create(); const dossier = f.repo.kernel.getDossier(task.id);
  f.repo.propose({ taskId: task.id, revision: task.revision, requestId: randomUUID(), draft: { rationale: "Уточнить сводку", confidence: 1, changes: { summary: { value: dossier.facts[0].text, evidenceRefs: [dossier.facts[0].id] } } } }, "test");
  f.repo.db.prepare("UPDATE tasks SET revision=revision+1 WHERE id=?").run(task.id);
  const { run } = await startSourceSync(f); const { input } = await sourceData(f, run); await submitSourceData(f, run, input);
  const { slot } = await setup("proposals", f);
  await slot.findByRole("heading", { name: "Proposals · 2" });
  expect(slot.getByRole("button", { name: "Dossiers and sessions · 1" })).toBeTruthy();
  expect((slot.getByRole("checkbox", { name: `Select: ${task.title}` }) as HTMLInputElement).disabled).toBe(true);
  fireEvent.click(slot.getByRole("checkbox", { name: "Select all" }));
  fireEvent.click(slot.getByRole("button", { name: "Accept selected · 1" }));
  await slot.findByText("Accepted: 1.");
  expect(f.repo.pendingTotal()).toBe(1);
  expect(f.repo.kernel.getDossier(task.id).projection.summary).toBeNull();
});

it.each(["task", "inbox"])("refreshes a priority-only conflict directly in the %s without accepting it", async location => {
  const f = await fixture(), task = await f.create(), fact = f.repo.detail(task.id).facts[0];
  const old = f.repo.propose({ taskId: task.id, revision: task.revision, requestId: randomUUID(), draft: { rationale: "Save the result", confidence: 1,
    changes: { summary: { value: "Verified result", evidenceRefs: [fact.id] } } } }, "test");
  f.repo.classify({ taskId: task.id, revision: 0, urgent: false, important: true });
  const { slot } = await setup(location === "task" ? task.id : "proposals", f);
  if (location === "task") fireEvent.click(await slot.findByRole("tab", { name: "Proposals · 1" }));
  else { await slot.findByRole("heading", { name: "Proposals · 1" }); fireEvent.click(slot.getByRole("button", { name: "Expand all" })); }
  fireEvent.click(await slot.findByRole("button", { name: "Refresh proposal" }));
  await waitFor(() => expect(f.repo.kernel.getProposal(old.id).status).toBe("rejected"));
  expect(f.repo.detail(task.id).projection.summary).toBeNull();
  expect(f.repo.pendingTotal()).toBe(1);
  expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
  expect(slot.inspection.rpcCalls.find(call => call.method === "refreshProposal")?.input).toMatchObject({ reviewed: false, parts: ["field:summary"] });
});

it("requires a current-task review before replacing a conflicting proposal and keeps only checked parts", async () => {
  const f = await fixture(), task = await f.create("Initial context");
  const fact = f.repo.note({ taskId: task.id, revision: task.revision, requestId: randomUUID(), kind: "user_instruction", text: "Keep this as unimportant." });
  const old = f.repo.propose({ taskId: task.id, revision: f.repo.kernel.getTask(task.id).revision, requestId: randomUUID(), draft: { rationale: "Update task", confidence: 1,
    changes: { summary: { value: "Updated result", evidenceRefs: [fact.id] }, important: { value: false, evidenceRefs: [fact.id] } } } }, "test");
  f.repo.classify({ taskId: task.id, revision: 0, urgent: false, important: true });
  const { slot } = await setup(task.id, f);
  fireEvent.click(await slot.findByRole("tab", { name: "Proposals · 1" }));
  fireEvent.click(await slot.findByRole("button", { name: "Review current task" }));
  expect((slot.getByRole("button", { name: "Save updated proposal" }) as HTMLButtonElement).disabled).toBe(true);
  expect(slot.getByText("Urgent: No · Important: Yes")).toBeTruthy();
  const confirm = slot.getByRole("checkbox", { name: "I reviewed the current task and want to keep the selected changes." });
  fireEvent.click(confirm);
  fireEvent.click(slot.getByRole("checkbox", { name: "Select part: Importance" }));
  await waitFor(() => expect((confirm as HTMLInputElement).checked).toBe(false));
  expect(slot.getByText(/Only the 1 selected parts will remain pending/)).toBeTruthy();
  fireEvent.click(confirm);
  fireEvent.click(slot.getByRole("button", { name: "Save updated proposal" }));
  await waitFor(() => expect(f.repo.kernel.getProposal(old.id).status).toBe("rejected"));
  const next = f.repo.detail(task.id).proposals.find(proposal => proposal.status === "pending")!;
  expect(Object.keys(next.changes)).toEqual(["summary"]);
  expect(f.repo.detail(task.id).projection.summary).toBeNull();
  expect(f.repo.planning(task.id).important).toBe(true);
  expect(slot.inspection.rpcCalls.find(call => call.method === "refreshProposal")?.input).toMatchObject({ reviewed: true, parts: ["field:summary"] });
});

it("opens source updates without a model run, and forwards an optional date through the native composer", async () => {
  vi.spyOn(collector, "collectSources").mockImplementation(async run => ({ version: 1, runId: run.id, startedAt: run.startedAt, finishedAt: run.until, elapsedMs: 1000, calls: [], documents: [], reports: ["gmail", "slack", "jira"].map(source => ({ source: source as "gmail" | "slack" | "jira", status: "complete", detail: "Checked", callRefs: [], paginationComplete: true, linkedTasksChecked: true, scanned: 0, threadsRead: 0 })) }));
  const f = await fixture();
  await f.harness.behavior.setSettings({ syncProvider: "codex", syncModel: "gpt-5.6-sol" });
  const { slot } = await setup("updates", f);
  fireEvent.click(await slot.findByRole("button", { name: "Check for updates" }));
  const composer = await slot.findByTestId("bb-new-thread-composer");
  expect(composer.getAttribute("data-default-provider-id")).toBe("codex");
  expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
  fireEvent.click(slot.getByLabelText("Set a start date"));
  fireEvent.change(slot.getByLabelText(/From date and time/), { target: { value: "2026-01-02T09:30" } });
  fireEvent.click(slot.getByTestId("bb-new-thread-composer-submit"));
  await waitFor(() => expect(new SourceSyncStore(f.repo).active()).toHaveLength(1));
  const run = new SourceSyncStore(f.repo).active()[0];
  expect(run.manualSince).toBe(new Date("2026-01-02T09:30").toISOString());
  expect(run.model).toBe("gpt-5.6-sol");
  expect(f.repo.list().total).toBe(0);
  expect(slot.inspection.rpcCalls.find((c) => c.method === "syncStart")?.input).toMatchObject({ since: new Date("2026-01-02T09:30").toISOString() });
});

it("shows source proposals with before/after, quotes and explicit acceptance in the task dossier", async () => {
  const f = await fixture(); const task = await f.create();
  const { run } = await startSourceSync(f); const { input, quote } = await sourceData(f, run, task.id);
  await submitSourceData(f, run, input);
  const { slot } = await setup(task.id, f);
  fireEvent.click(await slot.findByRole("tab", { name: "Proposals · 1" }));
  expect(await slot.findByText("Task update")).toBeTruthy();
  expect(slot.getAllByText("Before")).toHaveLength(3);
  expect(slot.getAllByText("After")).toHaveLength(3);
  expect(slot.getByText(quote)).toBeTruthy();
  expect(slot.getByRole("link", { hidden: true }).getAttribute("href")).toContain("mail.google.com");
  fireEvent.click(slot.getByRole("button", { name: "Accept update" }));
  await waitFor(() => expect(new SourceSyncStore(f.repo).candidates()[0].status).toBe("applied"));
  expect((await f.detail(task.id)).projection.nextStep).toBe(input.suggestions[0].changes.nextStep!.value);
});

it("disables stale source proposals and shows source failures without a successful-check label", async () => {
  const f = await fixture(); const task = await f.create();
  const { run } = await startSourceSync(f); const { input } = await sourceData(f, run, task.id);
  Object.assign(input.reports[1], { status: "unavailable", detail: "Slack требует входа", callRefs: [], paginationComplete: false, linkedTasksChecked: false });
  await submitSourceData(f, run, input);
  f.repo.note({ taskId: task.id, revision: task.revision, kind: "description", text: "Новый контекст", requestId: randomUUID() });
  const { slot } = await setup("updates", f);
  const accept = await slot.findByRole("button", { name: "Accept update" });
  expect((accept as HTMLButtonElement).disabled).toBe(true);
  expect(slot.getByText("Unavailable")).toBeTruthy();
  expect(slot.getByText(/Slack требует входа/)).toBeTruthy();
  expect(slot.getByText(/The dossier changed after this check/)).toBeTruthy();
});

function setupThread(f: Awaited<ReturnType<typeof fixture>>, threadId: string, isCompactViewport = false, action: "task" | "session" | "reported" | "source" = "session") {
  if (!hosts.includes(f)) hosts.push(f);
  const rpc = Object.fromEntries(Object.keys(rpcContract).map((name) => [name, (input: unknown) => f.harness.behavior.callRpc(name, input)]));
  const slot = renderSlot(app.threadHeaderActions.find(slot => slot.id === action)!, { threadId, projectId: "proj_personal", isCompactViewport }, { rpc });
  mounts.push(slot);
  return slot;
}

it("opens the primary source directly from full and compact headers and follows a new selection", async () => {
  const f = await fixture();
  const url = "https://example.slack.com/archives/C123/p1234567890000000";
  const task = f.repo.create({ title: "Source navigation", description: "", primarySourceUrl: url, requestId: randomUUID() });
  const session = await f.start(task.id, task.revision);
  const worker = setupThread(f, session.workerThreadId!, false, "source");
  f.repo.saveSession({ ...session, reviewerThreadId: "review-source-thread" });
  const reviewer = setupThread(f, "review-source-thread", true, "source");
  for (const header of [worker, reviewer]) {
    const link = await within(header.container).findByRole("link", { name: "Open primary source: Slack message" });
    expect(link.getAttribute("href")).toBe(url);
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  }
  expect(within(worker.container).getByText("Source")).toBeTruthy();
  expect(within(reviewer.container).queryByText("Source")).toBeNull();
  const next = "https://example.atlassian.net/browse/APP-42";
  f.repo.kernel.appendFact({ taskId: task.id, kind: "description", text: "Related issue", source: "imported", sourceRef: next });
  const { slot } = await setup(task.id, f);
  const button = await within(slot.container).findByRole("button", { name: `Make primary source: Jira · APP-42 (${next})` });
  const revision = f.repo.kernel.getTask(task.id).revision;
  fireEvent.click(button);
  await waitFor(() => expect(f.repo.detail(task.id).primarySource?.url).toBe(next));
  expect(f.repo.kernel.getTask(task.id).revision).toBe(revision);
  await worker.behavior.emitRealtime("desk-changed", {});
  expect((await within(worker.container).findByRole("link", { name: "Open primary source: Jira · APP-42" })).getAttribute("href")).toBe(next);
  expect(worker.inspection.navigateCalls).toHaveLength(0);
});

it("omits the source shortcut for unlinked threads, missing sources, unsafe URLs and failed refreshes", async () => {
  const f = await fixture(), task = await f.create(), session = await f.start(task.id, task.revision);
  const header = setupThread(f, session.workerThreadId!, false, "source");
  await waitFor(() => expect(header.inspection.rpcCalls.some(call => call.method === "threadSource")).toBe(true));
  expect(within(header.container).queryByRole("link")).toBeNull();
  f.repo.kernel.appendFact({ taskId: task.id, kind: "description", text: "Unsafe", source: "imported", sourceRef: "javascript:alert(1)" });
  await header.behavior.emitRealtime("desk-changed", {});
  expect(within(header.container).queryByRole("link")).toBeNull();
  f.repo.kernel.appendFact({ taskId: task.id, kind: "description", text: "Safe", source: "imported", sourceRef: "https://example.com/source" });
  await header.behavior.emitRealtime("desk-changed", {});
  await within(header.container).findByRole("link");
  const rpc = vi.spyOn(f.harness.behavior, "callRpc").mockRejectedValue(new Error("Temporarily unavailable"));
  await header.behavior.emitRealtime("desk-changed", {});
  await waitFor(() => expect(within(header.container).queryByRole("link")).toBeNull());
  rpc.mockRestore();
  await header.behavior.setRealtimeConnectionState("connected");
  await header.behavior.emitRealtime("desk-changed", {});
  await within(header.container).findByRole("link");
  const unrelated = setupThread(f, "unrelated-thread", false, "source");
  await waitFor(() => expect(unrelated.inspection.rpcCalls.some(call => call.method === "threadSource")).toBe(true));
  expect(within(unrelated.container).queryByRole("link")).toBeNull();
});

it("accepts a primary source in the new task form", async () => {
  const { f, slot } = await setup();
  fireEvent.click(await slot.findByRole("button", { name: "New task" }));
  fireEvent.change(slot.getByLabelText("What result do you need?"), { target: { value: "Review the request" } });
  fireEvent.change(slot.getByLabelText(/Primary source/), { target: { value: "https://example.com/request" } });
  fireEvent.click(slot.getByRole("button", { name: "Create task" }));
  await waitFor(() => expect(f.repo.list().total).toBe(1));
  expect(f.repo.detail(f.repo.list().tasks[0].id).primarySource?.url).toBe("https://example.com/request");
});

it("shows today's task report in all linked headers, refreshes manual changes and excludes other tasks and dates", async () => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-09-15T09:00:00Z"));
  const f = await fixture(), task = await f.create(), otherTask = await f.create();
  await f.harness.behavior.callRpc("start", { ...f.startInput(task.id, task.revision), criteria: [] });
  const session = f.repo.sessions(task.id)[0]; f.repo.saveSession({ ...session, reviewerThreadId: "thr_reviewer" });
  const days = new DayPlanning(f.repo);
  days.add({ date: "2026-09-14", taskId: task.id, reportedMinutes: 240, requestId: randomUUID() });
  days.add({ date: "2026-09-15", taskId: otherTask.id, reportedMinutes: 300, requestId: randomUUID() });
  const item = days.add({ date: "2026-09-15", taskId: task.id, plannedMinutes: 180, reportedMinutes: 80, requestId: randomUUID() });
  const before = f.repo.detail(task.id), history = days.history(item.id);
  const worker = setupThread(f, session.workerThreadId!, false, "reported"), reviewer = setupThread(f, "thr_reviewer", true, "reported");
  expect((await within(worker.container).findByLabelText("Reported today: 1h 20m")).textContent).toBe("1h 20m");
  expect((await within(reviewer.container).findByLabelText("Reported today: 1h 20m")).textContent).toBe("1h 20m");
  expect(within(reviewer.container).queryByText("Reported today:")).toBeNull();
  expect(days.history(item.id)).toEqual(history); expect(f.repo.detail(task.id)).toEqual(before);
  days.edit({ id: item.id, revision: item.revision, reportedMinutes: 95, requestId: randomUUID() });
  await worker.behavior.emitRealtime("desk-changed", {}); await reviewer.behavior.setRealtimeConnectionState("reconnecting");
  await within(worker.container).findByLabelText("Reported today: 1h 35m");
  await within(reviewer.container).findByLabelText("Reported today: 1h 35m");
  expect(worker.inspection.rpcCalls.every(call => call.method === "threadSession")).toBe(true);
});

it("distinguishes unspecified, estimated and confirmed zero reported time in the header", async () => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-09-15T09:00:00Z"));
  const f = await fixture(), task = await f.create();
  await f.harness.behavior.callRpc("start", { ...f.startInput(task.id, task.revision), criteria: [] });
  const threadId = f.repo.sessions(task.id)[0].workerThreadId!, days = new DayPlanning(f.repo), slot = setupThread(f, threadId, false, "reported");
  await slot.findByLabelText("Reported today: —"); expect(days.taskItem(task.id, "2026-09-15")).toBeNull();
  days.reconcileActual([{ taskId: task.id, date: "2026-09-15", minutes: 10 }]);
  let item = days.taskItem(task.id, "2026-09-15")!;
  item = days.estimate({ id: item.id, revision: item.revision, reportedMinutes: 45, reason: "Review the documented work.", requestId: randomUUID() }, "agent-time:test");
  await slot.behavior.emitRealtime("desk-changed", {}); await slot.findByLabelText("Reported today: 45m (estimate)");
  days.edit({ id: item.id, revision: item.revision, reportedMinutes: 0, requestId: randomUUID() });
  await slot.behavior.emitRealtime("desk-changed", {}); await slot.findByLabelText("Reported today: 0m");
  expect(slot.queryByText("estimate")).toBeNull();
  const unrelated = setupThread(f, "thr_unrelated", false, "reported");
  await unrelated.behavior.emitRealtime("desk-changed", {}); expect(unrelated.container.querySelector("output")).toBeNull();
});

it("rolls the header over at Athens midnight and does not present stale time after a failed refresh", async () => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-09-14T20:59:59Z"));
  const f = await fixture(), task = await f.create(), days = new DayPlanning(f.repo);
  await f.harness.behavior.callRpc("start", { ...f.startInput(task.id, task.revision), criteria: [] });
  days.add({ date: "2026-09-14", taskId: task.id, reportedMinutes: 90, requestId: randomUUID() });
  days.add({ date: "2026-09-15", taskId: task.id, reportedMinutes: 20, requestId: randomUUID() });
  const slot = setupThread(f, f.repo.sessions(task.id)[0].workerThreadId!, false, "reported");
  await slot.findByLabelText("Reported today: 1h 30m");
  vi.setSystemTime(new Date("2026-09-14T21:00:01Z")); fireEvent(window, new Event("focus"));
  await slot.findByLabelText("Reported today: 20m");
  vi.spyOn(f.harness.behavior, "callRpc").mockRejectedValueOnce(new Error("Temporarily offline"));
  await slot.behavior.emitRealtime("desk-changed", {}); await slot.findByLabelText("Reported today: unavailable");
  expect(slot.queryByText("20m")).toBeNull();
  await slot.behavior.emitRealtime("desk-changed", {}); await slot.findByLabelText("Reported today: 20m");
});

it("opens today's existing row from the reported button, focuses time and returns to the exact review thread", async () => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-09-14T20:59:59Z"));
  const f = await fixture(), task = await f.create(), days = new DayPlanning(f.repo);
  await f.harness.behavior.callRpc("start", { ...f.startInput(task.id, task.revision), criteria: [] });
  const session = f.repo.sessions(task.id)[0], threadId = "thr_review_origin";
  f.repo.saveSession({ ...session, reviewerThreadId: threadId });
  days.add({ date: "2026-09-14", taskId: task.id, reportedMinutes: 90, requestId: randomUUID() });
  const item = days.add({ date: "2026-09-15", taskId: task.id, plannedMinutes: 45, reportedMinutes: 20, requestId: randomUUID() });
  const before = f.repo.detail(task.id), history = days.history(item.id);
  const header = setupThread(f, threadId, true, "reported");
  const button = await header.findByRole("button", { name: "Reported today: 1h 30m. Open Day Plan" });
  vi.setSystemTime(new Date("2026-09-14T21:00:01Z"));
  fireEvent.click(button);
  const path = `day/2026-09-15/task/${task.id}/thread/${threadId}`;
  await waitFor(() => expect(JSON.stringify(header.inspection.navigateCalls)).toContain(path));
  expect(header.inspection.rpcCalls.some(call => call.method === "dayAdd")).toBe(false);
  expect(days.history(item.id)).toEqual(history);
  header.lifecycle.unmount();
  const rpc = Object.fromEntries(Object.keys(rpcContract).map(name => [name, (input: unknown) => f.harness.behavior.callRpc(name, input)]));
  const day = renderSlot(app.navPanels[0], { subPath: path }, { rpc }); mounts.push(day);
  const reported = await day.findByLabelText(`Reported: ${task.title}`);
  await waitFor(() => expect(document.activeElement).toBe(reported));
  expect((reported as HTMLInputElement).value).toBe("20m");
  fireEvent.change(reported, { target: { value: "1h" } });
  fireEvent.click(day.getByRole("button", { name: "Return to thread" }));
  await waitFor(() => expect(JSON.stringify(day.inspection.navigateCalls)).toContain(threadId));
  expect(days.get(item.id)).toMatchObject({ reportedMinutes: 60, plannedMinutes: 45 });
  expect(f.repo.detail(task.id)).toEqual(before);
  expect(f.harness.inspection.sdk.callsTo("threads.stop")).toHaveLength(0);
});

it("adds a missing day row only on clicking reported time and prevents repeated clicks from duplicating it", async () => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-09-15T09:00:00Z"));
  const f = await fixture(), task = await f.create(), days = new DayPlanning(f.repo);
  await f.harness.behavior.callRpc("start", { ...f.startInput(task.id, task.revision), criteria: [] });
  const threadId = f.repo.sessions(task.id)[0].workerThreadId!, before = f.repo.detail(task.id);
  const header = setupThread(f, threadId, false, "reported");
  const button = await header.findByRole("button", { name: "Reported today: —. Open Day Plan" });
  expect(days.taskItem(task.id, "2026-09-15")).toBeNull();
  fireEvent.click(button); fireEvent.click(button);
  await waitFor(() => expect(header.inspection.navigateCalls).toHaveLength(1));
  const item = days.taskItem(task.id, "2026-09-15")!;
  expect(item).toMatchObject({ plannedMinutes: 0, reportedMinutes: null, reportedLocked: false });
  expect(JSON.stringify(header.inspection.navigateCalls)).toContain(`day/2026-09-15/task/${task.id}/thread/${threadId}`);
  fireEvent.click(button);
  await waitFor(() => expect(header.inspection.navigateCalls).toHaveLength(2));
  expect(header.inspection.rpcCalls.filter(call => call.method === "dayAdd")).toHaveLength(1);
  expect(days.history(item.id).items).toHaveLength(1);
  expect(f.repo.detail(task.id)).toEqual(before);
});

it("opens a concurrently added row or a saved row with a lost response without overwriting time", async () => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-09-15T09:00:00Z"));
  const f = await fixture(), days = new DayPlanning(f.repo);
  const call = f.harness.behavior.callRpc.bind(f.harness.behavior);
  for (const lostResponse of [false, true]) {
    const task = await f.create();
    await call("start", { ...f.startInput(task.id, task.revision), criteria: [] });
    const threadId = f.repo.sessions(task.id)[0].workerThreadId!;
    const header = setupThread(f, threadId, false, "reported");
    const button = await header.findByRole("button", { name: "Reported today: —. Open Day Plan" });
    const spy = vi.spyOn(f.harness.behavior, "callRpc").mockImplementation(async (method, input) => {
      if (method === "dayAdd") {
        if (lostResponse) { await call(method, input); throw new Error("Response lost"); }
        days.add({ date: "2026-09-15", taskId: task.id, plannedMinutes: 25, reportedMinutes: 35, requestId: randomUUID() });
      }
      return call(method, input);
    });
    fireEvent.click(button);
    await waitFor(() => expect(header.inspection.navigateCalls).toHaveLength(1));
    const item = days.taskItem(task.id, "2026-09-15")!;
    expect(item).toMatchObject(lostResponse ? { plannedMinutes: 0, reportedMinutes: null } : { plannedMinutes: 25, reportedMinutes: 35 });
    expect(days.history(item.id).items).toHaveLength(1);
    spy.mockRestore(); header.lifecycle.unmount();
  }
});

it("allows retry after a failed day addition and ignores a late response after leaving the thread", async () => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-09-15T09:00:00Z"));
  const f = await fixture(), task = await f.create(), days = new DayPlanning(f.repo);
  await f.harness.behavior.callRpc("start", { ...f.startInput(task.id, task.revision), criteria: [] });
  const threadId = f.repo.sessions(task.id)[0].workerThreadId!;
  const header = setupThread(f, threadId, false, "reported");
  const button = await header.findByRole("button", { name: "Reported today: —. Open Day Plan" }) as HTMLButtonElement;
  const call = f.harness.behavior.callRpc.bind(f.harness.behavior);
  const spy = vi.spyOn(f.harness.behavior, "callRpc").mockImplementation((method, input) => {
    if (method === "dayAdd") return Promise.reject(new Error("Temporarily offline"));
    return call(method, input);
  });
  fireEvent.click(button);
  await waitFor(() => expect(button.disabled).toBe(false));
  expect(header.inspection.navigateCalls).toHaveLength(0); expect(days.taskItem(task.id, "2026-09-15")).toBeNull();
  spy.mockRestore(); fireEvent.click(button);
  await waitFor(() => expect(header.inspection.navigateCalls).toHaveLength(1));
  const requests = header.inspection.rpcCalls.filter(call => call.method === "dayAdd");
  expect(requests).toHaveLength(2); expect(requests[0].input).toEqual(requests[1].input);
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  vi.spyOn(f.harness.behavior, "callRpc").mockImplementation(async (method, input) => { if (method === "day") await pending; return call(method, input); });
  fireEvent.click(button); header.lifecycle.unmount();
  await act(async () => { release(); await pending; });
  expect(header.inspection.navigateCalls).toHaveLength(1);
});

it("opens each thread's own task without finishing either conversation, including on compact screens", async () => {
  const f = await fixture(); const firstTask = await f.create(); const secondTask = await f.create();
  for (const task of [firstTask, secondTask]) await f.harness.behavior.callRpc("start", { ...f.startInput(task.id, task.revision), criteria: [] });
  const first = f.repo.sessions(firstTask.id)[0]; const second = f.repo.sessions(secondTask.id)[0];
  const slots = [setupThread(f, first.workerThreadId!, false, "task"), setupThread(f, second.workerThreadId!, true, "task")];
  for (const [index, slot] of slots.entries()) {
    const button = await within(slot.container).findByRole("button", { name: "Open task" });
    expect(button.textContent).toBe(index === 0 ? "Open task" : "");
    expect(button.closest("[title]")?.getAttribute("title")).toBe("Open task");
    fireEvent.click(button);
    expect(JSON.stringify(slot.inspection.navigateCalls)).toContain([firstTask, secondTask][index].id);
    expect(JSON.stringify(slot.inspection.navigateCalls)).toContain(`${[firstTask, secondTask][index].id}/thread/${[first, second][index].workerThreadId}`);
    expect(JSON.stringify(slot.inspection.navigateCalls)).not.toContain([secondTask, firstTask][index].id);
    expect(slot.inspection.rpcCalls.every(call => call.method === "threadSession")).toBe(true);
  }
  expect(f.harness.inspection.sdk.callsTo("threads.stop")).toHaveLength(0);
  expect(f.repo.session(first.id).status).toBe("working");
  expect(f.repo.session(second.id).status).toBe("working");
  expect(f.repo.kernel.getTask(firstTask.id)).toEqual(firstTask);
  expect(f.repo.kernel.getTask(secondTask.id)).toEqual(secondTask);
});

it("keeps the task link on archived conversations after reloading the plugin", async () => {
  const f = await fixture(); const task = await f.create();
  await f.harness.behavior.callRpc("start", { ...f.startInput(task.id, task.revision), criteria: [] });
  const session = f.repo.sessions(task.id)[0];
  await f.harness.behavior.callRpc("cancel", { sessionId: session.id });
  await f.harness.behavior.callRpc("status", { taskId: task.id, status: "archived", revision: task.revision });
  await f.reload();
  const slot = setupThread(f, session.workerThreadId!, false, "task");
  fireEvent.click(await slot.findByRole("button", { name: "Open task" }));
  expect(JSON.stringify(slot.inspection.navigateCalls)).toContain(task.id);
  expect(f.repo.kernel.getTask(task.id).status).toBe("archived");
  expect(f.repo.session(session.id).status).toBe("cancelled");
  expect(slot.inspection.rpcCalls.every(call => call.method === "threadSession")).toBe(true);
});

it("finishes only its own conversation from one of two thread headers", async () => {
  const f = await fixture(); const firstTask = await f.create(); const secondTask = await f.create();
  for (const task of [firstTask, secondTask]) await f.harness.behavior.callRpc("start", { ...f.startInput(task.id, task.revision), criteria: [] });
  const first = f.repo.sessions(firstTask.id)[0]; const second = f.repo.sessions(secondTask.id)[0];
  const slot = setupThread(f, first.workerThreadId!);
  const other = setupThread(f, second.workerThreadId!, true);
  const finish = await within(slot.container).findByRole("button", { name: "Finish session" });
  const compact = await within(other.container).findByRole("button", { name: "Finish session" });
  expect(compact.textContent).toBe("");
  fireEvent.click(finish); fireEvent.click(finish);
  await waitFor(() => expect(f.repo.session(first.id).status).toBe("reviewing"));
  expect(f.repo.session(second.id).status).toBe("working");
  expect(f.harness.inspection.sdk.callsTo("threads.stop").flat()).toContainEqual({ threadId: first.workerThreadId });
  expect(f.harness.inspection.sdk.callsTo("threads.stop").flat()).not.toContainEqual({ threadId: second.workerThreadId });
  expect(slot.inspection.rpcCalls.filter((call) => call.method === "finish")).toEqual([{ method: "finish", input: { sessionId: first.id } }]);
  expect(other.inspection.rpcCalls.some((call) => call.method === "finish")).toBe(false);
  const taskLink = setupThread(f, first.workerThreadId!, false, "task");
  const dossier = await taskLink.findByRole("button", { name: "Open task" });
  await waitFor(() => expect((dossier as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(dossier);
  expect(JSON.stringify(taskLink.inspection.navigateCalls)).toContain(firstTask.id);
  expect(f.repo.kernel.getTask(firstTask.id)).toMatchObject({ status: "open", revision: firstTask.revision });
  expect((await f.detail(firstTask.id)).projection.summary).toBeNull();
});

it("links review and criterion-based threads to their task while restricting Finish session to work conversations", async () => {
  const f = await fixture(); const legacyTask = await f.create(); const task = await f.create();
  const legacy = await f.start(legacyTask.id, legacyTask.revision);
  await f.harness.behavior.callRpc("start", { ...f.startInput(task.id, task.revision), criteria: [] });
  const conversation = f.repo.sessions(task.id)[0];
  await f.harness.behavior.callRpc("finish", { sessionId: conversation.id });
  const reviewerId = f.repo.session(conversation.id).reviewerThreadId!;
  for (const [threadId, taskId] of [[legacy.workerThreadId!, legacyTask.id], [reviewerId, task.id]]) {
    const slot = setupThread(f, threadId);
    await waitFor(() => expect(slot.inspection.rpcCalls).toContainEqual({ method: "threadSession", input: { threadId } }));
    await slot.behavior.emitRealtime("desk-changed", {});
    expect(within(slot.container).queryByRole("button")).toBeNull();
    expect(await f.harness.behavior.callRpc("threadSession", { threadId })).toMatchObject({ session: { taskId } });
    const taskLink = setupThread(f, threadId, false, "task");
    fireEvent.click(await within(taskLink.container).findByRole("button", { name: "Open task" }));
    expect(JSON.stringify(taskLink.inspection.navigateCalls)).toContain(taskId);
    expect(taskLink.inspection.rpcCalls.some(call => call.method === "finish")).toBe(false);
  }
  const ended = setupThread(f, conversation.workerThreadId!, false, "task");
  await within(ended.container).findByRole("button", { name: "Open task" });
  expect(within(ended.container).queryByRole("button", { name: "Finish session" })).toBeNull();
  for (const action of ["task", "session"] as const) {
    const unrelated = setupThread(f, "unrelated-thread", false, action);
    await unrelated.behavior.emitRealtime("desk-changed", {});
    expect(within(unrelated.container).queryByRole("button")).toBeNull();
  }
  expect(await f.harness.behavior.callRpc("threadSession", { threadId: "unrelated-thread" })).toEqual({ session: null });
});

it("refreshes the header when the session is finished in another window", async () => {
  const f = await fixture(); const task = await f.create();
  await f.harness.behavior.callRpc("start", { ...f.startInput(task.id, task.revision), criteria: [] });
  const session = f.repo.sessions(task.id)[0];
  const slot = setupThread(f, session.workerThreadId!);
  const taskLink = setupThread(f, session.workerThreadId!, false, "task");
  await slot.findByRole("button", { name: "Finish session" });
  await f.harness.behavior.callRpc("finish", { sessionId: session.id });
  await slot.behavior.emitRealtime("desk-changed", {});
  await taskLink.findByRole("button", { name: "Open task" });
  await waitFor(() => expect(slot.queryByRole("button", { name: "Finish session" })).toBeNull());
  expect(slot.inspection.rpcCalls.some((call) => call.method === "finish")).toBe(false);
});

it("keeps the conversation open after a failed finish and lets the user retry", async () => {
  const f = await fixture(); const task = await f.create();
  await f.harness.behavior.callRpc("start", { ...f.startInput(task.id, task.revision), criteria: [] });
  const session = f.repo.sessions(task.id)[0];
  const catalog = await f.bb.sdk.providers.models({ providerId: "claude-code" });
  f.harness.inspection.sdk.stub("providers.models", () => ({ models: [], modelLoadError: "offline" }));
  const slot = setupThread(f, session.workerThreadId!);
  fireEvent.click(await slot.findByRole("button", { name: "Finish session" }));
  await slot.findByRole("button", { name: "Finish session" });
  expect(f.repo.session(session.id)).toMatchObject({ status: "working", finishedAt: null });
  expect(f.harness.inspection.sdk.callsTo("threads.stop")).toHaveLength(0);
  f.harness.inspection.sdk.stub("providers.models", () => catalog);
  fireEvent.click(slot.getByRole("button", { name: "Finish session" }));
  await waitFor(() => expect(f.repo.session(session.id).status).toBe("reviewing"));
  await waitFor(() => expect(slot.queryByRole("button", { name: "Finish session" })).toBeNull());
});

it("starts with an empty desk, creates a real task, and navigates to its dossier", async () => {
  const { f, slot } = await setup();
  await slot.findByText("A place for what matters");
  fireEvent.click(slot.getByRole("button", { name: "Add your first task" }));
  fireEvent.change(slot.getByLabelText("What result do you need?"), { target: { value: "Подготовить план" } });
  fireEvent.change(slot.getByLabelText(/What should we know/), { target: { value: "Три этапа" } });
  fireEvent.click(slot.getByRole("button", { name: "Create task" }));
  await waitFor(() => expect(f.repo.list().total).toBe(1));
  expect(slot.inspection.navigateCalls).toHaveLength(1);
  expect(JSON.stringify(slot.inspection.navigateCalls[0])).toContain(f.repo.list().tasks[0].id);
  expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
});

it("refreshes from another window's event and shows explicit unknown priority separately", async () => {
  const { f, slot } = await setup();
  await slot.findByText("A place for what matters");
  const task = await f.create();
  await f.harness.behavior.callRpc("classify", { taskId: task.id, revision: 0, urgent: true, important: null });
  await slot.behavior.emitRealtime("desk-changed", {});
  await slot.findByText("Подготовить план");
  fireEvent.click(slot.getByRole("button", { name: /Classify/ }));
  expect(slot.getByText("Подготовить план")).toBeTruthy();
  fireEvent.click(slot.getByRole("button", { name: /Do now/ }));
  await slot.findByText("Nothing here yet");
});

it("keeps a failed note draft, then saves it against the refreshed dossier", async () => {
  const f = await fixture(); const task = await f.create();
  const { slot } = await setup(task.id, f);
  await slot.findByText("Where things stand");
  fireEvent.change(slot.getByLabelText("Add context"), { target: { value: "Моя новая запись" } });
  await f.harness.behavior.callRpc("note", { taskId: task.id, revision: task.revision, kind: "description", text: "Из другого окна", requestId: randomUUID() });
  fireEvent.click(slot.getByRole("button", { name: "Save record" }));
  await slot.findByRole("alert");
  expect((slot.getByLabelText("Add context") as HTMLTextAreaElement).value).toBe("Моя новая запись");
  await slot.findByText("Из другого окна");
  fireEvent.click(slot.getByRole("button", { name: "Save record" }));
  await slot.findByText("Моя новая запись");
  expect((slot.getByLabelText("Add context") as HTMLTextAreaElement).value).toBe("");
});

it("shows the proposed value and evidence before accepting a change", async () => {
  const f = await fixture(); const task = await f.create(); const dossier = await f.detail(task.id);
  const proposal = f.repo.propose({ taskId: task.id, revision: task.revision, requestId: randomUUID(), draft: { rationale: "Сводка из фактов", confidence: 1, changes: { summary: { value: dossier.facts[0].text, evidenceRefs: [dossier.facts[0].id] } } } }, "test");
  const { slot } = await setup(task.id, f);
  fireEvent.click(await slot.findByRole("tab", { name: "Proposals · 1" }));
  await slot.findByText("Proposed");
  expect(slot.getByText("Before")).toBeTruthy();
  expect(slot.getByText(/Supporting evidence/)).toBeTruthy();
  expect((await f.detail(task.id)).projection.summary).toBeNull();
  fireEvent.click(slot.getByRole("button", { name: "Accept changes" }));
  await slot.findByText("Everything reviewed");
  expect((await f.detail(task.id)).projection.summary).toBe(dossier.facts[0].text);
  expect(slot.inspection.rpcCalls).toContainEqual({ method: "accept", input: { proposalId: proposal.id, revision: task.revision } });
});

it("resumes an unfinished blocked conversation from Work in its existing thread", async () => {
  const f = await fixture(); const task = await f.create();
  await f.harness.behavior.callRpc("start", { ...f.startInput(task.id, task.revision), criteria: [] });
  const session = f.repo.sessions(task.id)[0];
  f.repo.saveSession({ ...session, status: "blocked", error: "fetch failed" });
  const { slot } = await setup(task.id, f);
  fireEvent.click(await slot.findByRole("tab", { name: "Work" }));
  expect(await slot.findByText("fetch failed")).toBeTruthy();
  fireEvent.click(await slot.findByRole("button", { name: "Resume chat" }));
  await slot.findByRole("button", { name: "Finish session" });
  expect(slot.queryByRole("button", { name: "Resume chat" })).toBeNull();
  expect(slot.queryByText("fetch failed")).toBeNull();
  expect(slot.inspection.rpcCalls).toContainEqual({ method: "resume", input: { sessionId: session.id } });
  expect(f.repo.session(session.id)).toMatchObject({ workerThreadId: session.workerThreadId, status: "working", finishedAt: null, error: null });
  expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
  expect(f.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
});

it("opens an ordinary conversation from BB's native composer and finishes only by button", async () => {
  const f = await fixture(); const task = await f.create();
  await f.harness.behavior.setSettings({ workProvider: "claude-work", workModel: "claude-opus-5[1m]" });
  const { slot } = await setup(task.id, f);
  fireEvent.click(await slot.findByRole("tab", { name: "Work" }));
  const composer = await slot.findByTestId("bb-new-thread-composer");
  expect(composer.getAttribute("data-default-model")).toBe("claude-opus-5[1m]");
  expect(slot.queryByLabelText("Done when…")).toBeNull();
  fireEvent.change(slot.getByTestId("bb-new-thread-composer-input"), { target: { value: "Составь план" } });
  fireEvent.click(slot.getByTestId("bb-new-thread-composer-submit"));
  await waitFor(() => expect(f.repo.sessions(task.id)).toHaveLength(1));
  await waitFor(() => expect(f.repo.sessions(task.id)[0].status).toBe("working"));
  const session = f.repo.sessions(task.id)[0];
  expect(session.criteria).toEqual([]);
  expect(session.mode).toBe("conversation");
  expect(session.objective).toBe("Составь план");
  const spawn = f.harness.inspection.sdk.callsTo("threads.spawn")[0][0];
  expect(spawn).toMatchObject({ providerId: "claude-work", model: "claude-opus-5[1m]", permissionMode: "accept-edits", environment: { type: "project-default" } });
  await f.idle(session.workerThreadId!, "Давай обсудим план.");
  await slot.behavior.emitRealtime("desk-changed", {});
  const finish = await slot.findByRole("button", { name: "Finish session" });
  expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
  expect(slot.queryByLabelText("Review model")).toBeNull();
  fireEvent.click(finish);
  await waitFor(() => expect(f.repo.session(session.id).status).toBe("reviewing"));
  expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(2);
  expect(slot.inspection.rpcCalls).toContainEqual({ method: "finish", input: { sessionId: session.id } });
  expect(f.repo.session(session.id).reviewerProvider).toBe("codex");
  expect(f.repo.session(session.id).reviewerModel).toBe("gpt-5.6-sol");
});

it("shows task completion explicitly, applies it once, and offers a reopening proposal", async () => {
  const f = await fixture(); const task = await f.create();
  const input = { ...f.startInput(task.id, task.revision), criteria: [] };
  await f.harness.behavior.callRpc("start", input);
  const session = f.repo.sessions(task.id)[0];
  const report = "Перепроверил: обе фазы выполнены. Задачу можно закрывать.";
  await f.idle(session.workerThreadId!, report);
  await f.harness.behavior.callRpc("finish", { sessionId: session.id });
  const source = f.repo.transcript(session.id)!.messages.find((m) => m.text === report)!;
  await f.idle(f.repo.session(session.id).reviewerThreadId!, { rationale: "Предлагается завершить задачу по результатам перепроверки.", facts: [{ kind: "progress", text: report, citations: [{ messageRef: source.ref, quote: report }] }], changes: { status: { value: "done", evidenceRefs: ["fact:0"] } }, knowledge: [] });
  const { slot } = await setup(task.id, f);
  fireEvent.click(await slot.findByRole("tab", { name: "Proposals · 1" }));
  expect(await slot.findByRole("heading", { name: "Task status" })).toBeTruthy();
  expect(slot.getByText("Done")).toBeTruthy();
  expect(slot.getByText("Conversation quotes")).toBeTruthy();
  expect(f.repo.kernel.getTask(task.id).status).toBe("open");
  fireEvent.click(slot.getByRole("button", { name: "Accept and complete task" }));
  await slot.findByRole("button", { name: "Reopen task" });
  expect(f.repo.kernel.getTask(task.id)).toMatchObject({ status: "done", revision: task.revision + 1 });
  fireEvent.click(slot.getByRole("tab", { name: "History" }));
  const undo = await slot.findByRole("button", { name: "Propose undoing completion and changes" });
  expect((undo as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(undo);
  fireEvent.click(await slot.findByRole("tab", { name: "Proposals · 1" }));
  const accept = await slot.findByRole("button", { name: "Accept changes" });
  expect((accept as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(accept);
  await slot.findByRole("button", { name: "Complete" });
  expect(f.repo.kernel.getTask(task.id)).toMatchObject({ status: "open", revision: task.revision + 2 });
});

it("shows priority and title changes before acceptance, then moves the open task to the green quadrant", async () => {
  const f = await fixture(); const created = await f.create();
  f.repo.classify({ taskId: created.id, revision: 0, urgent: true, important: true });
  const evidence = f.repo.note({ taskId: created.id, revision: f.repo.kernel.getTask(created.id).revision, kind: "user_instruction", text: "Снизь срочность и важность. Назови задачу «Вопросы Мэри».", requestId: randomUUID() });
  const task = f.repo.kernel.getTask(created.id);
  const proposal = f.repo.propose({ taskId: task.id, revision: task.revision, requestId: randomUUID(), draft: { rationale: "Понизить приоритет по просьбе пользователя", confidence: 1,
    changes: { urgent: { value: false, evidenceRefs: [evidence.id] }, important: { value: false, evidenceRefs: [evidence.id] }, title: { value: "Вопросы Мэри", evidenceRefs: [evidence.id] } } } }, "test");
  const { slot } = await setup(task.id, f);
  fireEvent.click(await slot.findByRole("tab", { name: /Proposals/ }));
  await slot.findByRole("heading", { name: "Urgency" });
  expect(slot.getByRole("heading", { name: "Importance" })).toBeTruthy();
  expect(slot.getAllByText("Yes")).toHaveLength(2);
  expect(slot.getAllByText("No")).toHaveLength(2);
  expect(slot.getByText("Вопросы Мэри")).toBeTruthy();
  expect(f.repo.planning(task.id)).toMatchObject({ urgent: true, important: true });
  fireEvent.click(slot.getByRole("button", { name: "Accept changes" }));
  await waitFor(() => expect(f.repo.kernel.getProposal(proposal.id).status).toBe("applied"));
  expect(f.repo.kernel.getTask(task.id).status).toBe("open");
  expect(f.repo.planning(task.id)).toMatchObject({ urgent: false, important: false });
  const desk = await setup(undefined, f);
  fireEvent.click(await desk.slot.findByRole("button", { name: /For later/ }));
  expect(within(desk.slot.container).getByText("Вопросы Мэри")).toBeTruthy();
});

it("opens a linked discussion from a review without starting a model before the native composer is submitted", async () => {
  const f = await fixture(); const task = await f.create();
  const session = f.repo.sessions(task.id)[0] ?? await f.harness.behavior.callRpc("start", { ...f.startInput(task.id, task.revision), criteria: [] }) as { id: string; workerThreadId: string };
  const quote = "Надо снизить срочность.";
  f.message(session.workerThreadId!, "user", quote);
  await f.harness.behavior.callRpc("finish", { sessionId: session.id });
  const source = f.repo.transcript(session.id)!.messages.find((m) => m.text === quote)!;
  await f.idle(f.repo.session(session.id).reviewerThreadId!, { rationale: "Предлагается снизить срочность.", facts: [{ kind: "user_instruction", text: quote, citations: [{ messageRef: source.ref, quote }] }], changes: { urgent: { value: false, evidenceRefs: ["fact:0"] } }, knowledge: [] });
  const previous = f.repo.session(session.id);
  const { slot } = await setup(task.id, f);
  fireEvent.click(await slot.findByRole("tab", { name: /Proposals/ }));
  fireEvent.click(await slot.findByRole("button", { name: "Discuss review" }));
  const composer = await slot.findByTestId("bb-new-thread-composer");
  expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(2);
  expect(composer.getAttribute("data-default-provider-id")).toBe(previous.workerProvider);
  expect(composer.getAttribute("data-default-model")).toBe(previous.workerModel);
  expect((slot.getByTestId("bb-new-thread-composer-input") as HTMLTextAreaElement).value).toContain("discuss the review");
  fireEvent.change(slot.getByTestId("bb-new-thread-composer-input"), { target: { value: "Почему ты снизил только срочность?" } });
  fireEvent.click(slot.getByTestId("bb-new-thread-composer-submit"));
  await waitFor(() => expect(f.repo.sessions(task.id)).toHaveLength(2));
  await waitFor(() => expect(f.repo.sessions(task.id)[0].status).toBe("working"));
  expect(f.repo.sessions(task.id)[0]).toMatchObject({ continuedFrom: previous.id, discussionProposalId: previous.proposalId });
  expect(f.repo.kernel.getProposal(previous.proposalId!).status).toBe("pending");
  fireEvent.click(slot.getByRole("tab", { name: /Proposals/ }));
  const accept = await slot.findByRole("button", { name: "Accept changes" });
  expect((accept as HTMLButtonElement).disabled).toBe(true);
  expect(slot.getByText(/A discussion of this review is open/)).toBeTruthy();
});

it("shows cited conversation notes and knowledge together before saving them", async () => {
  const f = await fixture(); const task = await f.create();
  const input = f.startInput(task.id, task.revision); input.criteria = [];
  await f.harness.behavior.callRpc("start", input);
  const session = f.repo.sessions(task.id)[0];
  const fact = "В нашей интеграции статус booked означает проведённый счёт.";
  f.message(session.workerThreadId!, "user", fact);
  await f.idle(session.workerThreadId!, "Принял уточнение.");
  await f.harness.behavior.callRpc("finish", { sessionId: session.id });
  const ref = f.repo.transcript(session.id)!.messages.find((m) => m.text === fact)!.ref;
  await f.idle(f.repo.session(session.id).reviewerThreadId!, { rationale: "Сохраним значение статуса для следующих задач.", facts: [{ kind: "description", text: fact, citations: [{ messageRef: ref, quote: fact }] }], changes: null, knowledge: [{ title: "Статус booked", body: fact, tags: ["интеграция"], evidenceRefs: ["fact:0"] }] });
  const { slot } = await setup(task.id, f);
  fireEvent.click(await slot.findByRole("tab", { name: "Proposals · 1" }));
  await slot.findByText("Dossier records · 1");
  expect(slot.getByText("Knowledge to save · 1")).toBeTruthy();
  expect(slot.getByText("Conversation quotes")).toBeTruthy();
  expect(slot.getByRole("button", { name: "Open source conversation" })).toBeTruthy();
  expect(f.repo.knowledge().total).toBe(0);
  fireEvent.click(slot.getByRole("button", { name: "Accept changes" }));
  await waitFor(() => expect(f.repo.knowledge().total).toBe(1));
  expect(f.repo.kernel.getDossier(task.id).facts.some((v) => v.text === fact)).toBe(true);
});

it("opens the shared knowledge page with search and an honest empty state", async () => {
  const { slot } = await setup("knowledge");
  await slot.findByText("Knowledge will appear after a conversation");
  fireEvent.change(slot.getByLabelText("Search the knowledge base"), { target: { value: "счета" } });
  await slot.findByText("No matches");
  expect(slot.inspection.rpcCalls).toContainEqual({ method: "knowledge", input: { query: "счета", offset: 0 } });
});

it("shows an imported document with a real source file link and expands its complete text", async () => {
  const f = await fixture();
  const body = "---\nname: Source metadata\n---\n# ExampleERP guide\n\n" + "Справочная информация. ".repeat(100) + "\n\nПоследний раздел сохранён целиком.";
  await f.harness.behavior.callRpc("importKnowledge", { requestId: randomUUID(), source: { label: "ExampleCo", hostId: "host_test", rootPath: "/Knowledge Base" }, documents: [{ relativePath: "reference/example.md", title: "ExampleERP guide", body, tags: ["reference"] }] });
  const { slot } = await setup("knowledge", f);
  await slot.findByRole("heading", { name: "ExampleERP guide" });
  expect(slot.getByText("ExampleCo · reference/example.md")).toBeTruthy();
  expect(slot.getByRole("link", { name: "Source file" }).getAttribute("href")).toBeTruthy();
  expect(slot.queryByRole("button", { name: "Task dossier" })).toBeNull();
  expect(slot.queryByRole("button", { name: "Source conversation" })).toBeNull();
  expect(slot.queryByText(/Последний раздел сохранён целиком/)).toBeNull();
  fireEvent.click(slot.getByRole("button", { name: "Read in full" }));
  await slot.findByText(/Последний раздел сохранён целиком/);
  expect(slot.queryByText(/name: Source metadata/)).toBeNull();
  fireEvent.click(slot.getByRole("button", { name: "Collapse" }));
  expect(slot.queryByText(/Последний раздел сохранён целиком/)).toBeNull();
  expect(f.repo.knowledge().entries[0].body).toBe(body);
});

it("uses the returned page boundary for large files and returns to the previous page", async () => {
  const f = await fixture();
  const documents = Array.from({ length: 6 }, (_, i) => ({ relativePath: `reference/doc-${i}.md`, title: `Document ${i}`, body: "a".repeat(100000), tags: [] }));
  await f.harness.behavior.callRpc("importKnowledge", { requestId: randomUUID(), source: { label: "ExampleCo", hostId: "host_test", rootPath: "/Knowledge Base" }, documents });
  const { slot } = await setup("knowledge", f);
  await slot.findByText("Records 1–5 of 6");
  fireEvent.click(slot.getByRole("button", { name: "Next page" }));
  await slot.findByText("Records 6–6 of 6");
  expect(slot.inspection.rpcCalls).toContainEqual({ method: "knowledge", input: { query: "", offset: 5 } });
  fireEvent.click(slot.getByRole("button", { name: "Previous page" }));
  await slot.findByText("Records 1–5 of 6");
  fireEvent.change(slot.getByLabelText("Search the knowledge base"), { target: { value: "Document 5" } });
  await slot.findByText("Records 1–1 of 1");
  expect(slot.queryByRole("button", { name: "Previous page" })).toBeNull();
});


it("shows new and updated badges until a visible dossier is opened, excluding pending proposals", async () => {
  const f = await fixture(), task = await f.create("Original");
  const home = await setup(undefined, f);
  expect(await home.slot.findByText("New", { exact: true })).toBeTruthy();
  expect(home.slot.inspection.rpcCalls.some(c => c.method === "taskSeen")).toBe(false);
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  const page = await setup(task.id, f);
  await page.slot.findByRole("heading", { name: task.title });
  expect(page.slot.inspection.rpcCalls.some(c => c.method === "taskSeen")).toBe(false);
  visibility.mockReturnValue("visible"); fireEvent(document, new Event("visibilitychange"));
  await waitFor(() => expect(f.repo.list().tasks[0].unseen).toBeNull());
  page.slot.lifecycle.unmount(); mounts.splice(mounts.indexOf(page.slot), 1);
  const p = f.repo.propose({ taskId: task.id, revision: task.revision, requestId: randomUUID(), draft: {
    rationale: "Updated summary", confidence: 1, changes: { summary: { value: "Accepted update", evidenceRefs: [f.repo.detail(task.id).facts[0].id] } },
  } }, "test");
  expect(f.repo.list().tasks[0].unseen).toBeNull();
  f.repo.accept(p.id, task.revision);
  await home.slot.behavior.emitRealtime("desk-changed", {});
  expect(await home.slot.findByText("Updated", { exact: true })).toBeTruthy();
  await setup(task.id, f);
  await waitFor(() => expect(f.repo.list().tasks[0].unseen).toBeNull());
});

it("selects every source part by default and leaves unchecked parts pending after acceptance", async () => {
  const f = await fixture(), task = await f.create("Original");
  const { run } = await startSourceSync(f), { input } = await sourceData(f, run, task.id);
  await submitSourceData(f, run, input);
  const { slot } = await setup("updates", f);
  const nextStep = await slot.findByRole("checkbox", { name: "Select part: Next step" });
  expect((nextStep as HTMLInputElement).checked).toBe(true);
  expect(slot.getByRole("button", { name: "Accept update" })).toBeTruthy();
  fireEvent.click(nextStep);
  fireEvent.click(slot.getByRole("button", { name: "Accept selected parts · 4" }));
  await waitFor(() => expect(f.repo.kernel.getTask(task.id).revision).toBe(task.revision + 1));
  expect(f.repo.detail(task.id).projection.nextStep).toBeNull();
  await slot.findByText("Selected 1 of 1 parts");
  expect(slot.inspection.rpcCalls.filter(c => c.method === "reviewParts")).toHaveLength(1);
  expect((slot.getByRole("checkbox", { name: "Select part: Next step" }) as HTMLInputElement).checked).toBe(true);
  fireEvent.click(slot.getByRole("button", { name: "Accept update" }));
  await waitFor(() => expect(f.repo.pendingTotal()).toBe(0));
  expect(f.repo.detail(task.id).projection.nextStep).toBe(input.suggestions[0].changes.nextStep!.value);
});

it("rejects selected dossier fields while preserving the unchecked fields for acceptance", async () => {
  const f = await fixture(), task = await f.create("Original"), ref = f.repo.detail(task.id).facts[0].id;
  f.repo.propose({ taskId: task.id, revision: task.revision, requestId: randomUUID(), draft: {
    rationale: "Review fields", confidence: 1, changes: { summary: { value: "New summary", evidenceRefs: [ref] }, blockers: { value: [], evidenceRefs: [ref] } },
  } }, "test");
  const { slot } = await setup(task.id, f);
  fireEvent.click(await slot.findByRole("tab", { name: /Proposals.*1/ }));
  fireEvent.click(await slot.findByRole("checkbox", { name: "Select part: Blockers" }));
  fireEvent.click(slot.getByRole("button", { name: "Reject selected parts · 1" }));
  await slot.findByText("Selected 1 of 1 parts");
  expect(slot.queryByRole("checkbox", { name: "Select part: Summary" })).toBeNull();
  expect(f.repo.kernel.getTask(task.id).revision).toBe(task.revision);
  fireEvent.click(slot.getByRole("button", { name: "Accept changes" }));
  await waitFor(() => expect(f.repo.pendingTotal()).toBe(0));
  expect(f.repo.detail(task.id).projection.summary).toBeNull();
});


it("honors individual part choices in bulk acceptance, including after collapse and reopening", async () => {
  const f = await fixture(), task = await f.create("Original");
  const { run } = await startSourceSync(f), { input } = await sourceData(f, run, task.id);
  await submitSourceData(f, run, input);
  const { slot } = await setup("proposals", f);
  await waitFor(() => expect((slot.getByRole("button", { name: "Expand all" }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(slot.getByRole("button", { name: "Expand all" }));
  fireEvent.click(await slot.findByRole("checkbox", { name: "Select part: Next step" }));
  fireEvent.click(slot.getByRole("button", { name: "Collapse all" }));
  fireEvent.click(slot.getByRole("button", { name: "Expand all" }));
  expect((await slot.findByRole("checkbox", { name: "Select part: Next step" }) as HTMLInputElement).checked).toBe(false);
  fireEvent.click(slot.getByRole("checkbox", { name: "Select all" }));
  fireEvent.click(slot.getByRole("button", { name: "Accept selected · 1" }));
  await slot.findByText("Accepted: 1.");
  expect(f.repo.detail(task.id).projection.nextStep).toBeNull();
  const remaining = new SourceSyncStore(f.repo).pendingCandidates();
  expect(remaining).toHaveLength(1); expect(Object.keys(remaining[0].changes)).toEqual(["nextStep"]);
});

it("uses the installation's work model defaults instead of assuming a corporate account", async () => {
  const f = await fixture(), task = await f.create();
  await f.harness.behavior.setSettings({ workProvider: "codex", workModel: "gpt-5.6-sol", timeZone: "America/Los_Angeles" });
  const { slot } = await setup(task.id, f);
  fireEvent.click(await slot.findByRole("tab", { name: "Work" }));
  const composer = await slot.findByTestId("bb-new-thread-composer");
  expect(composer.getAttribute("data-default-provider-id")).toBe("codex");
  expect(composer.getAttribute("data-default-model")).toBe("gpt-5.6-sol");
});

it("includes selectable reported time in the ordinary proposal inbox without counting another proposal", async () => {
  const f = await fixture(); const task = await f.create();
  const days = new DayPlanning(f.repo);
  days.add({ taskId: task.id, date: days.today(), reportedMinutes: 40, requestId: randomUUID() });
  await f.harness.behavior.callRpc("start", { ...f.startInput(task.id, task.revision), criteria: [] });
  const session = f.repo.sessions(task.id)[0];
  const quote = "Reviewed the implementation and checked two sample exports.";
  await f.idle(session.workerThreadId!, quote);
  await f.harness.behavior.callRpc("finish", { sessionId: session.id });
  const ref = f.repo.transcript(session.id)!.messages.find(m => m.text === quote)!.ref;
  await f.idle(f.repo.session(session.id).reviewerThreadId!, {
    rationale: "Save the outcome and estimated session work.", facts: [{ kind: "progress", text: quote, citations: [{ messageRef: ref, quote }] }],
    changes: null, knowledge: [], reportedTime: { minutes: 25, reason: "Review and checking, including human reading.", evidenceRefs: ["fact:0"] },
  });
  const { slot } = await setup("proposals", f);
  await slot.findByRole("heading", { name: "Proposals · 1" });
  fireEvent.click(slot.getByRole("button", { name: "Expand all" }));
  const section = await slot.findByRole("region", { name: "Reported time proposal" });
  expect(within(section).getByText(/40m.*1h 5m/)).toBeTruthy();
  const time = within(section).getByRole("checkbox", { name: "Select part: Reported time" });
  expect((time as HTMLInputElement).checked).toBe(true);
  fireEvent.click(time);
  fireEvent.click(slot.getByRole("button", { name: "Accept selected parts · 1" }));
  await waitFor(() => expect(f.repo.kernel.getTask(task.id).revision).toBe(task.revision + 1));
  expect(days.taskItem(task.id, days.today())?.reportedMinutes).toBe(40);
  expect(f.repo.pendingTotal()).toBe(1);
});
