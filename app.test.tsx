// @vitest-environment jsdom
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import * as collector from "./source-collector.js";
import { act, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { CapturedPluginApp, RenderedSlot } from "@get-bb/plugin-sdk/testing/app";
import { randomUUID } from "node:crypto";
import { fixture } from "./test-support.js";
import { Repository } from "./repository.js";
import { rpcContract, syncStartSchema, sessionSchema } from "./contracts.js";
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
  const slot = renderSlot(app.navPanels[0], { subPath: taskId ?? "tasks" }, { rpc });
  mounts.push(slot);
  return { f, slot };
}

it("opens the inbox from the sidebar only while proposals await a decision", async () => {
  const f = await fixture(), task = await f.create();
  const empty = await setup("", f);
  await waitFor(() => expect(empty.slot.inspection.navigateCalls).toEqual([
    { method: "toPluginPanel", path: "desk", options: { subPath: "tasks", replace: true } },
  ]));
  empty.slot.lifecycle.unmount();
  const proposal = f.repo.propose({ taskId: task.id, revision: task.revision, requestId: randomUUID(), draft: {
    rationale: "New context to review", confidence: 1,
    changes: { summary: { value: "Updated context", evidenceRefs: [f.repo.detail(task.id).facts[0].id] } },
  } }, "test");
  const pending = await setup("/thread/thr_origin", f);
  await waitFor(() => expect(pending.slot.inspection.navigateCalls).toEqual([
    { method: "toPluginPanel", path: "desk", options: { subPath: "proposals/thread/thr_origin", replace: true } },
  ]));
  expect(f.repo.pendingTotal()).toBe(1);
  pending.slot.lifecycle.unmount();
  const tasks = await setup("tasks", f);
  await tasks.slot.findByRole("heading", { name: "Tasks" });
  expect(tasks.slot.inspection.navigateCalls).toEqual([]);
  const inbox = await setup("proposals", f);
  fireEvent.click(await inbox.slot.findByRole("button", { name: "All tasks" }));
  expect(inbox.slot.inspection.navigateCalls).toEqual([
    { method: "toPluginPanel", path: "desk", options: { subPath: "tasks" } },
  ]);
  tasks.slot.lifecycle.unmount(); inbox.slot.lifecycle.unmount();
  f.repo.reject(proposal.id);
  const reviewed = await setup("", f);
  await waitFor(() => expect(reviewed.slot.inspection.navigateCalls).toEqual([
    { method: "toPluginPanel", path: "desk", options: { subPath: "tasks", replace: true } },
  ]));
});

it.each(["list", "cards"])("creates an empty native thread directly from the %s task layout", async layout => {
  localStorage.setItem("247c-task-layout", layout);
  const f = await fixture(), task = await f.create();
  await f.harness.behavior.setSettings({ workProvider: "claude-work", workModel: "claude-opus-5[1m]" });
  const { slot } = await setup(undefined, f);
  const button = await slot.findByRole("button", { name: "New chat" });
  fireEvent.click(button); fireEvent.click(button);
  await waitFor(() => expect(slot.inspection.navigateCalls).toHaveLength(1));
  const session = f.repo.sessions(task.id)[0];
  expect(JSON.stringify(slot.inspection.navigateCalls)).toContain(session.workerThreadId);
  expect(slot.queryByTestId("bb-new-thread-composer")).toBeNull();
  expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
  expect(f.harness.inspection.sdk.callsTo("threads.spawn")[0][0]).toMatchObject({ input: [{ type: "text", visibility: "agent-only" }], providerId: "claude-work", model: "claude-opus-5[1m]" });
  await slot.behavior.emitRealtime("desk-changed", {});
  fireEvent.click(await slot.findByRole("button", { name: "Open chat" }));
  await waitFor(() => expect(slot.inspection.navigateCalls).toHaveLength(2));
  expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
  localStorage.removeItem("247c-task-layout");
});

it.each(["open", "done"] as const)("opens a chat directly from the %s task dossier and keeps the task status", async status => {
  const f = await fixture({ settings: { workProvider: "claude-work", workModel: "claude-opus-5[1m]" } });
  const task = await f.create();
  if (status === "done") await f.harness.behavior.callRpc("status", { taskId: task.id, status, revision: task.revision });
  const { slot } = await setup(task.id, f);
  const actions = within(await slot.findByRole("region", { name: "Task actions" }));
  const button = actions.getByRole("button", { name: "New chat" });
  fireEvent.click(button); fireEvent.click(button);
  await waitFor(() => expect(slot.inspection.navigateCalls).toHaveLength(1));
  const session = f.repo.sessions(task.id)[0];
  expect(slot.inspection.navigateCalls[0]).toEqual({ method: "toThread", threadId: session.workerThreadId });
  expect(f.repo.kernel.getTask(task.id).status).toBe(status);
  expect(slot.getByRole("tab", { name: "Dossier" }).getAttribute("aria-selected")).toBe("true");
  expect(slot.queryByTestId("bb-new-thread-composer")).toBeNull();
  await slot.behavior.emitRealtime("desk-changed", {});
  fireEvent.click(await actions.findByRole("button", { name: "Open chat" }));
  await waitFor(() => expect(slot.inspection.navigateCalls).toHaveLength(2));
  expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
});

it("opens an in-progress review from the dossier without starting a competing chat", async () => {
  const f = await fixture(), task = await f.create();
  await f.harness.behavior.callRpc("start", { ...f.startInput(task.id, task.revision), criteria: [] });
  const session = f.repo.sessions(task.id)[0];
  await f.idle(session.workerThreadId!, "Ready for review.");
  await f.harness.behavior.callRpc("finish", { sessionId: session.id });
  const { slot } = await setup(task.id, f);
  const actions = within(await slot.findByRole("region", { name: "Task actions" }));
  expect((actions.getByRole("button", { name: "Review in progress" }) as HTMLButtonElement).disabled).toBe(true);
  const calls = f.harness.inspection.sdk.callsTo("threads.spawn").length;
  fireEvent.click(actions.getByRole("button", { name: "Open review" }));
  expect(slot.inspection.navigateCalls).toEqual([{ method: "toThread", threadId: f.repo.session(session.id).reviewerThreadId }]);
  expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(calls);
});

it("offers a next-task chooser after the inbox is cleared, without starting work until a task is chosen", async () => {
  const f = await fixture({ settings: { workProvider: "claude-work", workModel: "claude-opus-5[1m]" } });
  const task = await f.create();
  const { slot } = await setup("proposals", f);
  const rpc = Object.fromEntries(Object.keys(rpcContract).map(name => [name, (input: unknown) => f.harness.behavior.callRpc(name, input)]));
  const overlay = renderSlot(app.appOverlays.find(s => s.id === "task-switcher")!, {}, { rpc }); mounts.push(overlay);
  fireEvent.click(await slot.findByRole("button", { name: "Choose next task" }));
  const list = await within(document.body).findByRole("listbox", { name: "Open tasks" });
  expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
  fireEvent.click(await within(list).findByRole("option"));
  await waitFor(() => expect(overlay.inspection.navigateCalls).toHaveLength(1));
  expect(overlay.inspection.navigateCalls[0]).toEqual({ method: "toThread", threadId: f.repo.sessions(task.id)[0].workerThreadId });
  expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
});

it("retries an uncertain direct-chat response with the same key and opens the existing thread", async () => {
  const f = await fixture(), task = await f.create(); hosts.push(f);
  await f.harness.behavior.setSettings({ workProvider: "claude-work", workModel: "claude-opus-5[1m]" });
  let calls = 0;
  const rpc = Object.fromEntries(Object.keys(rpcContract).map(name => [name, async (input: unknown) => {
    const result = await f.harness.behavior.callRpc(name, input);
    if (name === "openChat" && ++calls === 1) throw new Error("Connection lost after creation");
    return result;
  }]));
  const slot = renderSlot(app.navPanels[0], { subPath: "tasks" }, { rpc }); mounts.push(slot);
  fireEvent.click(await slot.findByRole("button", { name: "New chat" }));
  await waitFor(() => expect(f.repo.sessions(task.id)).toHaveLength(1));
  await waitFor(() => expect((slot.getByRole("button", { name: "New chat" }) as HTMLButtonElement).disabled).toBe(false));
  expect(slot.inspection.navigateCalls).toHaveLength(0);
  fireEvent.click(slot.getByRole("button", { name: "New chat" }));
  await waitFor(() => expect(slot.inspection.navigateCalls).toHaveLength(1));
  const requests = slot.inspection.rpcCalls.filter(c => c.method === "openChat");
  expect(requests[0].input).toEqual(requests[1].input);
  expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
});

it("edits a reported total directly in the thread without changing planned time or navigating", async () => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-02T09:00:00Z"));
  const f = await fixture(), task = await f.create(), days = new DayPlanning(f.repo);
  await f.harness.behavior.callRpc("start", { ...f.startInput(task.id, task.revision), criteria: [] });
  const item = days.add({ date: "2026-10-02", taskId: task.id, plannedMinutes: 50, reportedMinutes: 20, requestId: randomUUID() });
  const header = setupThread(f, f.repo.sessions(task.id)[0].workerThreadId!, false, "reported");
  fireEvent.click(await header.findByRole("button", { name: "Reported today: 20m. Edit reported time" }));
  const dialog = within(await header.findByRole("dialog"));
  const input = await dialog.findByLabelText("Reported total");
  await waitFor(() => expect((input as HTMLInputElement).value).toBe("20m"));
  expect(document.activeElement).toBe(input);
  fireEvent.change(input, { target: { value: "1:15" } });
  fireEvent.click(dialog.getByRole("button", { name: "Save total" }));
  await header.findByLabelText("Reported today: 1h 15m");
  expect(days.get(item.id)).toMatchObject({ plannedMinutes: 50, reportedMinutes: 75, reportedLocked: true });
  expect(header.inspection.navigateCalls).toHaveLength(0);
});

it("opening or cancelling quick time does not add a day row; saving adds exactly the explicit total", async () => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-02T09:00:00Z"));
  const f = await fixture(), task = await f.create(), days = new DayPlanning(f.repo);
  await f.harness.behavior.callRpc("start", { ...f.startInput(task.id, task.revision), criteria: [] });
  const header = setupThread(f, f.repo.sessions(task.id)[0].workerThreadId!, false, "reported");
  const edit = await header.findByRole("button", { name: "Reported today: —. Edit reported time" });
  fireEvent.click(edit); let dialog = within(await header.findByRole("dialog"));
  await waitFor(() => expect((dialog.getByLabelText("Reported total") as HTMLInputElement).disabled).toBe(false));
  expect(days.taskItem(task.id, "2026-10-02")).toBeNull();
  fireEvent.click(dialog.getByRole("button", { name: "Cancel" }));
  expect(days.taskItem(task.id, "2026-10-02")).toBeNull();
  fireEvent.click(edit); dialog = within(await header.findByRole("dialog"));
  await waitFor(() => expect((dialog.getByLabelText("Reported total") as HTMLInputElement).disabled).toBe(false));
  fireEvent.change(dialog.getByLabelText("Reported total"), { target: { value: "25m" } });
  fireEvent.click(dialog.getByRole("button", { name: "Save total" }));
  await header.findByLabelText("Reported today: 25m");
  const item = days.taskItem(task.id, "2026-10-02")!;
  expect(item).toMatchObject({ plannedMinutes: 0, reportedMinutes: 25 });
  expect(days.history(item.id).items).toHaveLength(1);
});

it("keeps a concurrent reported-time change and preserves the quick editor draft on conflict", async () => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-02T09:00:00Z"));
  const f = await fixture(), task = await f.create(), days = new DayPlanning(f.repo);
  await f.harness.behavior.callRpc("start", { ...f.startInput(task.id, task.revision), criteria: [] });
  const item = days.add({ date: "2026-10-02", taskId: task.id, reportedMinutes: 20, requestId: randomUUID() });
  const header = setupThread(f, f.repo.sessions(task.id)[0].workerThreadId!, false, "reported");
  fireEvent.click(await header.findByRole("button", { name: "Reported today: 20m. Edit reported time" }));
  const dialog = within(await header.findByRole("dialog")); const input = dialog.getByLabelText("Reported total") as HTMLInputElement;
  await waitFor(() => expect(input.value).toBe("20m"));
  days.edit({ id: item.id, revision: item.revision, requestId: randomUUID(), reportedMinutes: 35 });
  fireEvent.change(input, { target: { value: "45m" } }); fireEvent.click(dialog.getByRole("button", { name: "Save total" }));
  await dialog.findByRole("alert"); expect(input.value).toBe("45m"); expect(days.get(item.id).reportedMinutes).toBe(35);
  fireEvent.click(dialog.getByRole("button", { name: "Reload saved time" }));
  await waitFor(() => expect(input.value).toBe("35m"));
  expect(header.inspection.navigateCalls).toHaveLength(0);
});

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
  const startControl = await slot.findByRole(page === "work" ? "tab" : "button", { name: page === "work" ? "Work" : "Custom check…" });
  await waitFor(() => expect((startControl as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(startControl);
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
  expect((slot.getByRole("checkbox", { name: "Select all" }) as HTMLInputElement).checked).toBe(true);
  expect(slot.getByText("Selected: 2 · new tasks: 1")).toBeTruthy();
  fireEvent.click(slot.getByRole("button", { name: "Accept selected · 2" }));
  await slot.findByText("Accepted: 2.");
  await slot.findByRole("heading", { name: "Everything reviewed" });
  expect(f.repo.list().total).toBe(2); expect(f.repo.pendingTotal()).toBe(0);
  expect(slot.inspection.rpcCalls.filter(c => c.method === "acceptInbox")).toHaveLength(1);
  expect(slot.inspection.navigateCalls).toHaveLength(0);
  const accepted = within(await slot.findByRole("region", { name: "Recently accepted tasks" }));
  expect(accepted.getAllByRole("listitem")).toHaveLength(2);
  fireEvent.click(accepted.getByRole("button", { name: `Open task: ${task.title}` }));
  expect(slot.inspection.navigateCalls).toEqual([{ method: "toPluginPanel", path: "desk", options: { subPath: task.id } }]);
  slot.lifecycle.unmount();
  const returned = await setup("proposals", f);
  const retained = within(await returned.slot.findByRole("region", { name: "Recently accepted tasks" }));
  expect(retained.getAllByRole("listitem")).toHaveLength(2);
  expect(retained.getByRole("button", { name: `Open task: ${fresh.title}` })).toBeTruthy();
  expect(returned.slot.inspection.rpcCalls.filter(c => c.method === "acceptInbox")).toHaveLength(0);
});

it.each([false, true])("opens a recently accepted task's chat directly (existing: %s)", async existing => {
  const f = await fixture(), task = await f.create();
  await f.harness.behavior.setSettings({ workProvider: "claude-work", workModel: "claude-opus-5[1m]" });
  const proposal = f.repo.propose({ taskId: task.id, revision: task.revision, requestId: randomUUID(), draft: { rationale: "Update context", confidence: 1, changes: { summary: { value: "Reviewed", evidenceRefs: [f.repo.detail(task.id).facts[0].id] } } } }, "test");
  await f.harness.behavior.callRpc("accept", { proposalId: proposal.id, revision: task.revision });
  if (existing) await f.harness.behavior.callRpc("openChat", { taskId: task.id, requestId: randomUUID() });
  const { slot } = await setup("proposals", f);
  const accepted = within(await slot.findByRole("region", { name: "Recently accepted tasks" }));
  expect(accepted.getByRole("button", { name: `Open task: ${task.title}` })).toBeTruthy();
  const chat = accepted.getByRole("button", { name: `Open chat: ${task.title}` });
  fireEvent.click(chat); fireEvent.click(chat);
  await waitFor(() => expect(slot.inspection.navigateCalls).toHaveLength(1));
  const session = f.repo.sessions(task.id)[0];
  expect(slot.inspection.navigateCalls).toEqual([{ method: "toThread", threadId: session.workerThreadId }]);
  expect(f.repo.sessions(task.id)).toHaveLength(1);
  expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
  expect(slot.inspection.rpcCalls.filter(c => c.method === "openChat")).toHaveLength(1);
});

it("preserves unchecked proposals across refreshes and filters and accepts only the visible selection", async () => {
  const f = await fixture(), task = await f.create();
  const { run } = await startSourceSync(f), { input } = await sourceData(f, run, task.id);
  const fresh = structuredClone(input.suggestions[0]); fresh.taskId = null; fresh.title = "New request";
  input.suggestions.push(fresh); await submitSourceData(f, run, input);
  const { slot } = await setup("proposals", f);
  const updateName = `Select: ${input.suggestions[0].title}`;
  const update = await slot.findByRole("checkbox", { name: updateName }) as HTMLInputElement;
  expect(update.checked).toBe(true);
  fireEvent.click(update);
  await slot.behavior.emitRealtime("desk-changed", {});
  await waitFor(() => expect(slot.inspection.rpcCalls.filter(c => c.method === "proposalInbox").length).toBeGreaterThan(1));
  expect((slot.getByRole("checkbox", { name: updateName }) as HTMLInputElement).checked).toBe(false);
  fireEvent.click(slot.getByRole("button", { name: "Task updates · 1" }));
  expect(slot.getByText("Selected: 0")).toBeTruthy();
  fireEvent.click(slot.getByRole("checkbox", { name: "Select all" }));
  expect((slot.getByRole("checkbox", { name: updateName }) as HTMLInputElement).checked).toBe(true);
  fireEvent.click(slot.getByRole("button", { name: "New tasks · 1" }));
  fireEvent.click(slot.getByRole("button", { name: "Accept selected · 1" }));
  await slot.findByText("Accepted: 1.");
  expect(f.repo.pendingTotal()).toBe(1);
  expect(f.repo.detail(task.id).projection.nextStep).toBeNull();
  expect(slot.inspection.rpcCalls.filter(c => c.method === "acceptInbox")).toHaveLength(1);
});

it("selects newly arriving proposals while retaining manual deselections and skips conflicting alternatives", async () => {
  const f = await fixture();
  const propose = (title: string) => {
    const task = f.repo.create({ title, description: "Context", requestId: randomUUID() });
    const draft = { rationale: "Update", confidence: 1, changes: { summary: { value: "Summary", evidenceRefs: [f.repo.detail(task.id).facts[0].id] } } };
    f.repo.propose({ taskId: task.id, revision: task.revision, requestId: randomUUID(), draft }, "test");
    return { task, draft };
  };
  propose("First task");
  const { task, draft } = propose("Conflicting task");
  f.repo.propose({ taskId: task.id, revision: task.revision, requestId: randomUUID(), draft }, "test");
  const { slot } = await setup("proposals", f);
  fireEvent.click(await slot.findByRole("checkbox", { name: "Select: First task" }));
  expect(slot.getAllByRole("checkbox", { name: "Select: Conflicting task" }).every(box => !(box as HTMLInputElement).checked)).toBe(true);
  propose("New arrival");
  await slot.behavior.emitRealtime("desk-changed", {});
  expect((await slot.findByRole("checkbox", { name: "Select: New arrival" }) as HTMLInputElement).checked).toBe(true);
  expect((slot.getByRole("checkbox", { name: "Select: First task" }) as HTMLInputElement).checked).toBe(false);
  fireEvent.click(slot.getAllByRole("checkbox", { name: "Select: Conflicting task" })[0]);
  expect((slot.getAllByRole("checkbox", { name: "Select: Conflicting task" })[1] as HTMLInputElement).disabled).toBe(true);
  expect(f.repo.pendingTotal()).toBe(4);
});

it("selects each new inbox page without accepting proposals from another page", async () => {
  const f = await fixture();
  for (let index = 0; index < 51; index++) {
    const task = f.repo.create({ title: `Page task ${index}`, description: "Context", requestId: randomUUID() });
    f.repo.propose({ taskId: task.id, revision: task.revision, requestId: randomUUID(), draft: {
      rationale: "Update", confidence: 1, changes: { summary: { value: "Summary", evidenceRefs: [f.repo.detail(task.id).facts[0].id] } },
    } }, "test");
  }
  const { slot } = await setup("proposals", f);
  await slot.findByRole("button", { name: "Accept selected · 50" });
  fireEvent.click(slot.getByRole("checkbox", { name: "Select all on this page" }));
  expect(slot.getByText("Selected: 0")).toBeTruthy();
  fireEvent.click(slot.getByRole("button", { name: "Next page" }));
  fireEvent.click(await slot.findByRole("button", { name: "Accept selected · 1" }));
  await slot.findByText("Accepted: 1.");
  await waitFor(() => expect(slot.getByText("Selected: 0")).toBeTruthy());
  expect(f.repo.pendingTotal()).toBe(50);
});

it("counts new-task suggestions in the More menu before a task exists", async () => {
  const f = await fixture(); const { run } = await startSourceSync(f); const { input } = await sourceData(f, run); await submitSourceData(f, run, input);
  const { slot } = await setup(undefined, f);
  await slot.findByRole("heading", { name: "Tasks" });
  fireEvent.click(slot.getByText("More"));
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
  expect((slot.getByRole("checkbox", { name: "Select all" }) as HTMLInputElement).checked).toBe(true);
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

it("labels the desk navigation Updates and does not launch a check while navigating", async () => {
  const { f, slot } = await setup();
  fireEvent.click(await slot.findByText("More"));
  fireEvent.click(await slot.findByRole("button", { name: "Updates" }));
  expect(slot.inspection.navigateCalls).toContainEqual({ method: "toPluginPanel", path: "desk", options: { subPath: "updates" } });
  expect(slot.queryByRole("button", { name: "Check for updates" })).toBeNull();
  expect(new SourceSyncStore(f.repo).state().runs).toHaveLength(0);
  expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
});

it("starts collecting with one click using saved preferences and prevents a second launch", async () => {
  const collect = vi.spyOn(collector, "collectSources").mockImplementation(async (_run, _dossiers, options) => new Promise((_resolve, reject) => {
    options?.signal?.addEventListener("abort", () => reject(new Error("Stopped")), { once: true });
  }));
  const f = await fixture();
  await f.harness.behavior.setSettings({ syncProvider: "codex", syncModel: "gpt-5.6-sol", syncReasoningLevel: "medium" });
  const store = new SourceSyncStore(f.repo);
  const first = store.insert(syncStartSchema.parse({ requestId: randomUUID(), since: null, request: { ...f.startInput("unused", 0).request, model: "gpt-6-astra", reasoningLevel: "max" } }));
  store.save({ ...first, status: "completed", finishedAt: first.startedAt });
  const before = f.repo.list(true);
  const { slot } = await setup("updates", f);
  const button = await slot.findByRole("button", { name: "Check for updates" });
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(button); fireEvent.click(button);
  await slot.findByText("Check started. Progress is shown below.");
  expect(slot.queryByTestId("bb-new-thread-composer")).toBeNull();
  expect(collect).toHaveBeenCalledOnce();
  expect(store.state().runs).toHaveLength(2);
  const run = store.active()[0];
  expect(run).toMatchObject({ model: "gpt-5.6-sol", manualSince: null, collection: { phase: "collecting" } });
  expect(store.request(run.id)).toMatchObject({ incremental: true, input: { request: { reasoningLevel: "medium" } } });
  expect((slot.getByRole("button", { name: "Check running…" }) as HTMLButtonElement).disabled).toBe(true);
  expect(slot.getAllByText("Loading data…")).toHaveLength(3);
  expect(slot.inspection.rpcCalls.filter(call => call.method === "syncQuickStart")).toHaveLength(1);
  expect(f.repo.list(true)).toEqual(before);
});

it("offers a custom check when the first launch needs setup", async () => {
  const { f, slot } = await setup("updates");
  const button = await slot.findByRole("button", { name: "Check for updates" });
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(button);
  await slot.findByText(/Run a Custom check first/);
  expect(new SourceSyncStore(f.repo).state().runs).toHaveLength(0);
  fireEvent.click(slot.getByRole("button", { name: "Custom check…" }));
  await slot.findByRole("heading", { name: "Custom check" });
  expect(slot.queryByText(/Run a Custom check first/)).toBeNull();
});

it("opens a custom check without a model run, and forwards an optional date through the native composer", async () => {
  vi.spyOn(collector, "collectSources").mockImplementation(async run => ({ version: 1, runId: run.id, startedAt: run.startedAt, finishedAt: run.until, elapsedMs: 1000, calls: [], documents: [], reports: ["gmail", "slack", "jira"].map(source => ({ source: source as "gmail" | "slack" | "jira", status: "complete", detail: "Checked", callRefs: [], paginationComplete: true, linkedTasksChecked: true, scanned: 0, threadsRead: 0 })) }));
  const f = await fixture();
  await f.harness.behavior.setSettings({ syncProvider: "codex", syncModel: "gpt-5.6-sol" });
  const { slot } = await setup("updates", f);
  const checkButton = await slot.findByRole("button", { name: "Custom check…" });
  await waitFor(() => expect((checkButton as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(checkButton);
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
  expect(slot.getAllByText(/Slack требует входа/)).toHaveLength(2); // Source card and persistent health warning.
  expect(slot.getByText(/The task changed after this proposal was prepared/)).toBeTruthy();
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

it("uses the local Slack browser preference in the header and task sources without changing saved evidence", async () => {
  const f = await fixture(); hosts.push(f);
  const url = "https://example.slack.com/archives/C123/p1234567890000000?thread_ts=1234500000.000001&cid=C123";
  const task = f.repo.create({ title: "Browser source", description: "", primarySourceUrl: url, requestId: randomUUID() });
  const session = await f.start(task.id, task.revision);
  const rpc = Object.fromEntries(Object.keys(rpcContract).map(name => [name, (input: unknown) => f.harness.behavior.callRpc(name, input)]));
  const options = { rpc, settings: { slackLinksInBrowser: true } };
  const header = renderSlot(app.threadHeaderActions.find(slot => slot.id === "source")!, { threadId: session.workerThreadId!, projectId: "proj_personal", isCompactViewport: false }, options);
  mounts.push(header);
  const source = await within(header.container).findByRole("link", { name: "Open primary source: Slack message" });
  expect(source.getAttribute("href")).toBe(url.replace("/archives/", "/messages/"));
  const page = renderSlot(app.navPanels[0], { subPath: task.id }, options); mounts.push(page);
  const taskLink = await within(page.container).findByRole("link", { name: /Slack message/ });
  expect(taskLink.getAttribute("href")).toBe(source.getAttribute("href"));
  expect(f.repo.detail(task.id).primarySource?.url).toBe(url);
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

it("rolls the header over at local midnight and does not present stale time after a failed refresh", async () => {
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
  await waitFor(() => expect(JSON.stringify(slot.inspection.navigateCalls)).toContain(session.workerThreadId));
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
  await f.harness.behavior.callRpc("pauseSession", { sessionId: session.id });
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
  await f.harness.behavior.callRpc("pauseSession", { sessionId: session.id });
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

it("preselects independent waiting actions and accepts task changes without the unchecked chat action", async () => {
  const f = await fixture(), task = await f.create("Waiting report");
  f.repo.status(task.id, "waiting", task.revision);
  const { run } = await startSourceSync(f), { input } = await sourceData(f, run, task.id);
  input.suggestions[0].changes.status = { value: "open", evidenceRefs: ["fact:0"] };
  await submitSourceData(f, run, input);
  const { slot } = await setup("updates", f);
  const reopen = await slot.findByRole("checkbox", { name: "Select part: Reopen task" });
  const chat = slot.getByRole("checkbox", { name: "Select part: Open chat with update" });
  expect((reopen as HTMLInputElement).checked).toBe(true);
  expect((chat as HTMLInputElement).checked).toBe(true);
  fireEvent.click(chat);
  fireEvent.click(slot.getByRole("button", { name: "Accept selected parts · 6" }));
  await waitFor(() => expect(f.repo.kernel.getTask(task.id).status).toBe("open"));
  expect(f.repo.sessions(task.id)).toHaveLength(0);
  await slot.findByText("Selected 1 of 1 parts");
  expect((slot.getByRole("checkbox", { name: "Select part: Open chat with update" }) as HTMLInputElement).checked).toBe(true);
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
  expect((slot.getByRole("checkbox", { name: "Select all" }) as HTMLInputElement).checked).toBe(true);
  fireEvent.click(slot.getByRole("button", { name: "Accept selected · 1" }));
  await slot.findByText("Accepted: 1.");
  expect(f.repo.detail(task.id).projection.nextStep).toBeNull();
  const remaining = new SourceSyncStore(f.repo).pendingCandidates();
  expect(remaining).toHaveLength(1); expect(Object.keys(remaining[0].changes)).toEqual(["nextStep"]);
  const accepted = within(await slot.findByRole("region", { name: "Recently accepted tasks" }));
  expect(accepted.getAllByRole("listitem")).toHaveLength(1);
  expect(accepted.getByRole("button", { name: `Open task: ${task.title}` })).toBeTruthy();
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

it.each([false, true])("handles reported time in the inbox after a manual correction: %s", async corrected => {
  const f = await fixture(); const task = await f.create();
  const days = new DayPlanning(f.repo);
  days.add({ taskId: task.id, date: days.today(), reportedMinutes: 40, requestId: randomUUID() });
  await f.harness.behavior.callRpc("start", { ...f.startInput(task.id, task.revision), criteria: [] });
  const session = f.repo.sessions(task.id)[0];
  const quote = "Reviewed the implementation and checked two sample exports.";
  await f.idle(session.workerThreadId!, quote);
  await f.harness.behavior.callRpc("pauseSession", { sessionId: session.id });
  const ref = f.repo.transcript(session.id)!.messages.find(m => m.text === quote)!.ref;
  await f.idle(f.repo.session(session.id).reviewerThreadId!, {
    rationale: "Save the outcome and estimated session work.", facts: [{ kind: "progress", text: quote, citations: [{ messageRef: ref, quote }] }],
    changes: null, knowledge: [], reportedTime: { minutes: 25, reason: "Review and checking, including human reading.", evidenceRefs: ["fact:0"] },
  });
  if (corrected) {
    const item = days.taskItem(task.id, days.today())!;
    days.edit({ id: item.id, revision: item.revision, reportedMinutes: 55, requestId: randomUUID() });
  }
  const { slot } = await setup("proposals", f);
  await slot.findByRole("heading", { name: "Proposals · 1" });
  fireEvent.click(slot.getByRole("button", { name: "Expand all" }));
  if (corrected) {
    await slot.findByText(/Reported time was automatically excluded/);
    expect(slot.queryByRole("checkbox", { name: "Select part: Reported time" })).toBeNull();
    expect(slot.queryByRole("region", { name: "Reported time proposal" })).toBeNull();
    fireEvent.click(slot.getByRole("button", { name: "Accept changes" }));
    await waitFor(() => expect(f.repo.pendingTotal()).toBe(0));
    expect(days.taskItem(task.id, days.today())?.reportedMinutes).toBe(55);
    expect(f.repo.detail(task.id).facts.some(fact => fact.text === quote)).toBe(true);
    return;
  }
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

it.each(["bulk", "single", "partial"])("sets priority on a collapsed new-task proposal and applies it through %s acceptance", async mode => {
  const f = await fixture(); const { run } = await startSourceSync(f); const { input } = await sourceData(f, run);
  await submitSourceData(f, run, input);
  const { slot } = await setup("proposals", f);
  const red = await slot.findByRole("button", { name: "Red: Urgent and important" });
  const group = slot.getByRole("group", { name: "Priority" });
  expect(within(group).getAllByRole("button").map(b => b.getAttribute("aria-label")?.split(":")[0])).toEqual(["Red", "Orange", "Yellow", "Green"]);
  expect(red.getAttribute("aria-pressed")).toBe("false");
  fireEvent.click(slot.getByRole("button", { name: "Orange: Urgent, not important" }));
  expect(f.repo.list().total).toBe(0);
  if (mode === "bulk") {
    expect((slot.getByRole("checkbox", { name: "Select all" }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(slot.getByRole("button", { name: "Accept selected · 1" }));
  } else {
    fireEvent.click(slot.getByRole("button", { name: `View: ${input.suggestions[0].title}` }));
    expect(slot.getAllByRole("group", { name: "Priority" })).toHaveLength(1);
    if (mode === "partial") fireEvent.click(slot.getByRole("checkbox", { name: "Select part: Next step" }));
    fireEvent.click(slot.getByRole("button", { name: mode === "partial" ? "Create task with selected parts" : "Create task from proposal" }));
  }
  await waitFor(() => expect(f.repo.list().total).toBe(1));
  expect(f.repo.list().tasks[0].planning).toMatchObject({ urgent: true, important: false });
  if (mode === "partial") expect(f.repo.detail(f.repo.list().tasks[0].id).projection.nextStep).toBeNull();
});

it.each(["list", "cards"])("filters waiting tasks in %s without losing their chat shortcut", async layout => {
  localStorage.setItem("247c-task-layout", layout);
  const f = await fixture({ settings: { workProvider: "claude-work", workModel: "claude-opus-5[1m]" } }), task = await f.create();
  f.repo.status(task.id, "waiting", task.revision);
  const evidence = f.repo.kernel.appendFact({ taskId: task.id, kind: "progress", text: "The request is awaiting a reply." });
  f.repo.kernel.createProposal({ taskId: task.id, baseRevision: f.repo.kernel.getTask(task.id).revision, model: "test", output: { rationale: "Pending summary", confidence: 1, changes: { summary: { value: evidence.text, evidenceRefs: [evidence.id] } } } });
  const other = f.repo.create({ title: "Actionable task", description: "", requestId: randomUUID() });
  const { slot } = await setup(undefined, f);
  await slot.findByRole("heading", { name: new RegExp(task.title) });
  const filter = slot.getByRole("button", { name: /Waiting for response/, pressed: false });
  expect(filter.textContent).toContain("1");
  fireEvent.click(filter);
  expect(filter.getAttribute("aria-pressed")).toBe("true");
  expect(slot.queryByRole("heading", { name: new RegExp(other.title) })).toBeNull();
  const heading = slot.getByRole("heading", { name: new RegExp(task.title) });
  const row = heading.closest(".border-l-4")!;
  expect(row.className).toContain("bg-sky-400/10");
  expect(row.textContent).toContain("Waiting for response · 0 days");
  expect(row.textContent).toContain("Awaiting a decision · 1");
  fireEvent.click(within(row as HTMLElement).getByRole("button", { name: "New chat" }));
  await waitFor(() => expect(slot.inspection.navigateCalls).toHaveLength(1));
  expect(f.repo.kernel.getTask(task.id).status).toBe("waiting");
  localStorage.removeItem("247c-task-layout");
});

it("switches Open and Waiting in the task header while keeping an active chat", async () => {
  const f = await fixture({ settings: { workProvider: "claude-work", workModel: "claude-opus-5[1m]" } }), task = await f.create();
  await f.harness.behavior.callRpc("openChat", { taskId: task.id, requestId: randomUUID() });
  const { slot } = await setup(task.id, f);
  fireEvent.click(await slot.findByRole("button", { name: "Waiting for response" }));
  await slot.findByRole("button", { name: "Resume task" });
  expect(slot.getByText("Waiting for response · 0 days")).toBeTruthy();
  expect(f.repo.kernel.getTask(task.id).status).toBe("waiting");
  expect(f.repo.sessions(task.id)[0].status).toBe("working");
  fireEvent.click(slot.getByRole("button", { name: "Resume task" }));
  await slot.findByRole("button", { name: "Waiting for response" });
  expect(f.repo.kernel.getTask(task.id).status).toBe("open");
  expect(f.harness.inspection.sdk.callsTo("threads.archive")).toHaveLength(0);
});

it("finds an accepted ticket number and source URL independently of its title", async () => {
  const f = await fixture();
  const task = await f.create("APP-17 - Unable to create an invoice");
  f.repo.kernel.appendFact({ taskId: task.id, kind: "description", text: 'ClickUp ticket DEMO_1-42 is named "APP-17 - Unable to create an invoice".', source: "approved-source", sourceRef: "https://app.clickup.com/t/abc123" });
  const { slot } = await setup(undefined, f);
  await slot.findByText(task.title);
  for (const query of ["demo_1-42", "abc123", "app.clickup.com/t/abc123"]) {
    fireEvent.change(slot.getByRole("textbox", { name: "Find a task" }), { target: { value: query } });
    expect(slot.getByText(task.title)).toBeTruthy();
  }
  fireEvent.change(slot.getByRole("textbox", { name: "Find a task" }), { target: { value: "DEMO_1-999" } });
  expect(slot.queryByText(task.title)).toBeNull();
});

it("filters cards by customer together with search, including uncategorized tasks", async () => {
  const f = await fixture();
  for (const [title, customer] of [["Invoice issue", "Acme"], ["Import issue", "ACME"], ["Access issue", "Beta"], ["Internal work", null]])
    f.repo.create({ title: title!, customer, description: "", requestId: randomUUID() });
  const { slot } = await setup(undefined, f);
  const filter = await slot.findByRole("combobox", { name: "Filter by customer" });
  await slot.findByText("Invoice issue");
  expect(within(filter).getAllByRole("option")).toHaveLength(4);
  fireEvent.change(filter, { target: { value: "name:acme" } });
  expect(slot.getByText("Invoice issue")).toBeTruthy();
  expect(slot.getByText("Import issue")).toBeTruthy();
  expect(slot.queryByText("Access issue")).toBeNull();
  fireEvent.change(slot.getByRole("textbox", { name: "Find a task" }), { target: { value: "invoice" } });
  expect(slot.queryByText("Import issue")).toBeNull();
  fireEvent.change(slot.getByRole("textbox", { name: "Find a task" }), { target: { value: "" } });
  fireEvent.change(filter, { target: { value: "none" } });
  expect(slot.getByText("Internal work")).toBeTruthy();
  expect(slot.queryByText("Invoice issue")).toBeNull();
});

it("autosaves customer edits and clears without a Save button", async () => {
  const f = await fixture(), task = await f.create();
  const { slot } = await setup(task.id, f);
  const field = await slot.findByRole("combobox", { name: "Customer" });
  fireEvent.change(field, { target: { value: "Acme" } });
  await waitFor(() => expect(f.repo.detail(task.id).projection.customer).toBe("Acme"), { timeout: 3000 });
  await slot.findByText("Saved");
  fireEvent.change(field, { target: { value: "" } });
  fireEvent.blur(field);
  await waitFor(() => expect(f.repo.detail(task.id).projection.customer).toBeNull());
});

it("preserves the customer draft after a failed save and retries", async () => {
  const f = await fixture(), task = await f.create();
  const { slot } = await setup(task.id, f);
  const field = await slot.findByRole("combobox", { name: "Customer" });
  const save = vi.spyOn(Repository.prototype, "setCustomer").mockImplementationOnce(() => { throw new Error("Save unavailable"); });
  fireEvent.change(field, { target: { value: "Acme" } });
  fireEvent.blur(field);
  const retry = await slot.findByRole("button", { name: "Retry customer save" });
  expect((field as HTMLInputElement).value).toBe("Acme");
  expect(f.repo.detail(task.id).projection.customer).toBeNull();
  fireEvent.click(retry);
  await waitFor(() => expect(f.repo.detail(task.id).projection.customer).toBe("Acme"));
  expect(save).toHaveBeenCalledTimes(2);
});


it.each(["task", "inbox"])("refreshes stale source proposals from the %s after an explicit review", async location => {
  const f = await fixture(), task = await f.create("Current task context");
  const { run } = await startSourceSync(f), { input } = await sourceData(f, run, task.id);
  await submitSourceData(f, run, input);
  const store = new SourceSyncStore(f.repo), old = store.pendingCandidates()[0];
  f.repo.note({ taskId: task.id, revision: task.revision, requestId: randomUUID(), kind: "constraint", text: "Keep the approved scope." });
  const before = f.repo.kernel.getDossier(task.id);
  const { slot } = await setup(location === "task" ? task.id : "proposals", f);
  if (location === "task") fireEvent.click(await slot.findByRole("tab", { name: "Proposals · 1" }));
  else { await slot.findByRole("heading", { name: "Proposals · 1" }); fireEvent.click(slot.getByRole("button", { name: "Expand all" })); }
  fireEvent.click(await slot.findByRole("button", { name: "Refresh proposal" }));
  expect(slot.getByText("Keep the approved scope.")).toBeTruthy();
  expect((slot.getByRole("button", { name: "Save updated proposal" }) as HTMLButtonElement).disabled).toBe(true);
  const confirm = slot.getByRole("checkbox", { name: "I reviewed the current task and want to keep the selected changes." });
  fireEvent.click(confirm);
  fireEvent.click(slot.getByRole("checkbox", { name: "Select part: Next step" }));
  await waitFor(() => expect((confirm as HTMLInputElement).checked).toBe(false));
  fireEvent.click(confirm);
  fireEvent.click(slot.getByRole("button", { name: "Save updated proposal" }));
  await waitFor(() => expect(store.candidate(old.id).status).toBe("superseded"));
  const next = store.pendingCandidates()[0];
  expect(next.changes.nextStep).toBeUndefined();
  expect(next.baseRevision).toBe(before.task.revision);
  expect(next.facts).toEqual(old.facts);
  expect(f.repo.kernel.getDossier(task.id)).toEqual(before);
  expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
  if (location === "inbox") fireEvent.click(await slot.findByRole("button", { name: "Expand all" }));
  await waitFor(() => expect((slot.getByRole("button", { name: "Accept update" }) as HTMLButtonElement).disabled).toBe(false));
});


it.each(["done", "waiting"] as const)("handles source status %s without finishing the open chat", async status => {
  const f = await fixture(), task = await f.create();
  const session = sessionSchema.parse(await f.harness.behavior.callRpc("start", { ...f.startInput(task.id, task.revision), criteria: [] }));
  await f.idle(session.workerThreadId!, "Checked the request and prepared a draft.");
  const { run } = await startSourceSync(f), { input } = await sourceData(f, run, task.id);
  input.suggestions[0].changes.status = { value: status, evidenceRefs: ["fact:0"] };
  await submitSourceData(f, run, input);
  const { slot } = await setup(task.id, f);
  fireEvent.click(await slot.findByRole("tab", { name: "Proposals · 1" }));
  const accept = await slot.findByRole("button", { name: "Accept update" });
  expect((accept as HTMLButtonElement).disabled).toBe(status === "done");
  expect(slot.queryByText(/An idle work session will finish automatically/)).toBeNull();
  if (status === "done") {
    expect(slot.getByText("Finish the work session before changing the status.")).toBeTruthy();
    fireEvent.click(slot.getByRole("checkbox", { name: "Select part: Task status" }));
    const partial = await slot.findByRole("button", { name: /Accept selected parts/ });
    expect((partial as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(partial);
    await waitFor(() => expect(f.repo.kernel.getTask(task.id).revision).toBeGreaterThan(task.revision));
    expect(f.repo.kernel.getTask(task.id).status).toBe("open");
  } else {
    fireEvent.click(accept);
    await waitFor(() => expect(f.repo.kernel.getTask(task.id).status).toBe("waiting"));
  }
  expect(f.repo.session(session.id)).toMatchObject({ status: "working", finishedAt: null, reviewerThreadId: null });
});


it.each(["working", "reviewing"] as const)("explains review actions blocked by a %s session and links to it", async status => {
  const f = await fixture(), task = await f.create();
  const old = sessionSchema.parse(await f.harness.behavior.callRpc("start", { ...f.startInput(task.id, task.revision), criteria: [] }));
  f.repo.saveSession({ ...old, status: "blocked", finishedAt: new Date().toISOString(), error: "The review was interrupted by a plugin reload. The conversation is saved; click Retry review." });
  const active = sessionSchema.parse(await f.harness.behavior.callRpc("start", { ...f.startInput(task.id, task.revision), criteria: [] }));
  f.repo.saveSession({ ...active, status });
  const { slot } = await setup(`${task.id}/session/${old.id}`, f);
  const retry = await slot.findByRole("button", { name: "Retry review" });
  expect((retry as HTMLButtonElement).disabled).toBe(true);
  expect((slot.getByRole("button", { name: "Discuss review" }) as HTMLButtonElement).disabled).toBe(true);
  const message = status === "working" ? "Session 2 is still open. Finish it before using these actions." : "Session 2 is being processed. Wait for it to finish before using these actions.";
  expect(slot.getByText(message).id).toBe(retry.getAttribute("aria-describedby"));
  fireEvent.click(slot.getByRole("button", { name: "Go to Session 2" }));
  if (status === "working") await slot.findByRole("button", { name: "Finish session" });
  else await slot.findByText("Saving the conversation outcome. Dossier and knowledge proposals will appear here.");
  expect(slot.queryByText(message)).toBeNull();
  expect(f.repo.session(active.id).status).toBe(status);
  fireEvent.click(slot.getByRole("button", { name: "Session 1 · Needs attention" }));
  await slot.findByText(message);
  f.repo.saveSession({ ...f.repo.session(active.id), status: "completed" });
  await slot.behavior.emitRealtime("desk-changed", {});
  await waitFor(() => expect((slot.getByRole("button", { name: "Retry review" }) as HTMLButtonElement).disabled).toBe(false));
  expect(slot.queryByText(message)).toBeNull();
});
