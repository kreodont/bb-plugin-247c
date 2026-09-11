// @vitest-environment jsdom
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import * as collector from "./source-collector.js";
import { fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { CapturedPluginApp, RenderedSlot } from "@get-bb/plugin-sdk/testing/app";
import { randomUUID } from "node:crypto";
import { fixture } from "./test-support.js";
import { rpcContract } from "./contracts.js";
import { SourceSyncStore } from "./source-sync.js";
import { sourceData, startSourceSync, submitSourceData } from "./source-sync-test-support.js";

let app: CapturedPluginApp;
const mounts: RenderedSlot[] = [];
const hosts: Awaited<ReturnType<typeof fixture>>[] = [];
beforeAll(async () => { app = await loadPluginApp(() => import("./app.js")); }, 60000);
afterEach(async () => { for (const m of mounts.splice(0)) m.lifecycle.unmount(); for (const f of hosts.splice(0)) await f.harness.lifecycle.dispose(); vi.restoreAllMocks(); });
async function setup(taskId?: string, supplied?: Awaited<ReturnType<typeof fixture>>) {
  const f = supplied ?? await fixture(); hosts.push(f);
  const rpc = Object.fromEntries(Object.keys(rpcContract).map((name) => [name, (input: unknown) => f.harness.behavior.callRpc(name, input)]));
  const slot = renderSlot(app.navPanels[0], { subPath: taskId ?? "" }, { rpc });
  mounts.push(slot);
  return { f, slot };
}

it.each(["work", "updates"])("opens the %s composer in the configured thread project", async page => {
  const f = await fixture(); const task = await f.create();
  await f.harness.behavior.setSettings({ threadProjectId: "proj_tasks" });
  const { slot } = await setup(page === "work" ? task.id : "updates", f);
  fireEvent.click(await slot.findByRole(page === "work" ? "tab" : "button", { name: page === "work" ? "Work" : "Check for updates" }));
  const composer = await slot.findByTestId("bb-new-thread-composer");
  expect(composer.getAttribute("data-default-project-id")).toBe("proj_tasks");
  expect(JSON.parse(composer.getAttribute("data-default-environment")!)).toEqual({ type: "project-default" });
  expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
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

it("opens source updates without a model run, and forwards an optional date through the native composer", async () => {
  vi.spyOn(collector, "collectSources").mockImplementation(async run => ({ version: 1, runId: run.id, startedAt: run.startedAt, finishedAt: run.until, elapsedMs: 1000, calls: [], documents: [], reports: ["gmail", "slack", "jira"].map(source => ({ source: source as "gmail" | "slack" | "jira", status: "complete", detail: "Checked", callRefs: [], paginationComplete: true, linkedTasksChecked: true, scanned: 0, threadsRead: 0 })) }));
  const { f, slot } = await setup("updates");
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

function setupThread(f: Awaited<ReturnType<typeof fixture>>, threadId: string, isCompactViewport = false) {
  if (!hosts.includes(f)) hosts.push(f);
  const rpc = Object.fromEntries(Object.keys(rpcContract).map((name) => [name, (input: unknown) => f.harness.behavior.callRpc(name, input)]));
  const slot = renderSlot(app.threadHeaderActions[0], { threadId, projectId: "proj_personal", isCompactViewport }, { rpc });
  mounts.push(slot);
  return slot;
}

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
  const dossier = await within(slot.container).findByRole("button", { name: "Session dossier" });
  await waitFor(() => expect((dossier as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(dossier);
  expect(JSON.stringify(slot.inspection.navigateCalls)).toContain(firstTask.id);
  expect(f.repo.kernel.getTask(firstTask.id)).toMatchObject({ status: "open", revision: firstTask.revision });
  expect((await f.detail(firstTask.id)).projection.summary).toBeNull();
});

it("hides the session control on unrelated, reviewer, and criterion-based threads", async () => {
  const f = await fixture(); const legacyTask = await f.create(); const task = await f.create();
  const legacy = await f.start(legacyTask.id, legacyTask.revision);
  await f.harness.behavior.callRpc("start", { ...f.startInput(task.id, task.revision), criteria: [] });
  const conversation = f.repo.sessions(task.id)[0];
  await f.harness.behavior.callRpc("finish", { sessionId: conversation.id });
  const reviewerId = f.repo.session(conversation.id).reviewerThreadId!;
  for (const threadId of ["unrelated-thread", legacy.workerThreadId!, reviewerId]) {
    const slot = setupThread(f, threadId);
    await waitFor(() => expect(slot.inspection.rpcCalls).toContainEqual({ method: "threadSession", input: { threadId } }));
    await slot.behavior.emitRealtime("desk-changed", {});
    expect(slot.queryByRole("button")).toBeNull();
    expect(await f.harness.behavior.callRpc("threadSession", { threadId })).toEqual({ session: null });
  }
  const ended = setupThread(f, conversation.workerThreadId!);
  await ended.findByRole("button", { name: "Session dossier" });
  expect(ended.queryByRole("button", { name: "Finish session" })).toBeNull();
});

it("refreshes the header when the session is finished in another window", async () => {
  const f = await fixture(); const task = await f.create();
  await f.harness.behavior.callRpc("start", { ...f.startInput(task.id, task.revision), criteria: [] });
  const session = f.repo.sessions(task.id)[0];
  const slot = setupThread(f, session.workerThreadId!);
  await slot.findByRole("button", { name: "Finish session" });
  await f.harness.behavior.callRpc("finish", { sessionId: session.id });
  await slot.behavior.emitRealtime("desk-changed", {});
  await slot.findByRole("button", { name: "Session dossier" });
  expect(slot.queryByRole("button", { name: "Finish session" })).toBeNull();
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
  await slot.findByRole("button", { name: "Session dossier" });
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

it("opens an ordinary conversation from BB's native composer and finishes only by button", async () => {
  const f = await fixture(); const task = await f.create();
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
  expect(composer.getAttribute("data-default-provider-id")).toBe("codex");
  expect(composer.getAttribute("data-default-model")).toBe("gpt-5.6-sol");
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
  fireEvent.click(slot.getByRole("button", { name: "Next" }));
  await slot.findByText("Records 6–6 of 6");
  expect(slot.inspection.rpcCalls).toContainEqual({ method: "knowledge", input: { query: "", offset: 5 } });
  fireEvent.click(slot.getByRole("button", { name: "Back" }));
  await slot.findByText("Records 1–5 of 6");
  fireEvent.change(slot.getByLabelText("Search the knowledge base"), { target: { value: "Document 5" } });
  await slot.findByText("Records 1–1 of 1");
  expect(slot.queryByRole("button", { name: "Back" })).toBeNull();
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
  fireEvent.click(await slot.findByRole("button", { name: "Expand all" }));
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
