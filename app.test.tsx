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

it("reviews new tasks and existing task updates together and accepts the selected list", async () => {
  const f = await fixture(); const task = await f.create();
  const { run } = await startSourceSync(f); const { input } = await sourceData(f, run, task.id);
  const fresh = structuredClone(input.suggestions[0]); fresh.taskId = null; fresh.title = "Новая просьба из письма";
  input.suggestions.push(fresh); await submitSourceData(f, run, input);
  const { slot } = await setup("proposals", f);
  await slot.findByRole("heading", { name: "Предложения · 2" });
  expect(f.repo.list().total).toBe(1); expect(f.repo.list().pendingTotal).toBe(2);
  expect(slot.getByText("Новая задача")).toBeTruthy();
  fireEvent.click(slot.getByRole("button", { name: "Раскрыть все" }));
  expect(slot.getAllByText("Станет").length).toBeGreaterThan(0);
  expect(slot.getAllByText("Было").length).toBeGreaterThan(0);
  fireEvent.click(slot.getByRole("checkbox", { name: "Выбрать все" }));
  expect(slot.getByText("Выбрано: 2 · новых задач: 1")).toBeTruthy();
  fireEvent.click(slot.getByRole("button", { name: "Принять выбранные · 2" }));
  await slot.findByText("Принято: 2.");
  await slot.findByRole("heading", { name: "Всё рассмотрено" });
  expect(f.repo.list().total).toBe(2); expect(f.repo.pendingTotal()).toBe(0);
  expect(slot.inspection.rpcCalls.filter(c => c.method === "acceptInbox")).toHaveLength(1);
  expect(slot.inspection.navigateCalls).toHaveLength(0);
});

it("counts new-task suggestions in the prominent home link before a task exists", async () => {
  const f = await fixture(); const { run } = await startSourceSync(f); const { input } = await sourceData(f, run); await submitSourceData(f, run, input);
  const { slot } = await setup(undefined, f);
  const button = await slot.findByRole("button", { name: "Предложения · 1" });
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
  await slot.findByRole("heading", { name: "Предложения · 2" });
  expect(slot.getByRole("button", { name: "Досье и сессии · 1" })).toBeTruthy();
  expect((slot.getByRole("checkbox", { name: `Выбрать: ${task.title}` }) as HTMLInputElement).disabled).toBe(true);
  fireEvent.click(slot.getByRole("checkbox", { name: "Выбрать все" }));
  fireEvent.click(slot.getByRole("button", { name: "Принять выбранные · 1" }));
  await slot.findByText("Принято: 1.");
  expect(f.repo.pendingTotal()).toBe(1);
  expect(f.repo.kernel.getDossier(task.id).projection.summary).toBeNull();
});

it("opens source updates without a model run, and forwards an optional date through the native composer", async () => {
  vi.spyOn(collector, "collectSources").mockImplementation(async run => ({ version: 1, runId: run.id, startedAt: run.startedAt, finishedAt: run.until, elapsedMs: 1000, calls: [], documents: [], reports: ["gmail", "slack", "jira"].map(source => ({ source: source as "gmail" | "slack" | "jira", status: "complete", detail: "Проверено", callRefs: [], paginationComplete: true, linkedTasksChecked: true, scanned: 0, threadsRead: 0 })) }));
  const { f, slot } = await setup("updates");
  fireEvent.click(await slot.findByRole("button", { name: "Проверить обновления" }));
  const composer = await slot.findByTestId("bb-new-thread-composer");
  expect(composer.getAttribute("data-default-provider-id")).toBe("codex");
  expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
  fireEvent.click(slot.getByLabelText("Указать начальную дату"));
  fireEvent.change(slot.getByLabelText(/С даты и времени/), { target: { value: "2026-01-02T09:30" } });
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
  fireEvent.click(await slot.findByRole("tab", { name: "Предложения · 1" }));
  expect(await slot.findByText("Обновление задачи")).toBeTruthy();
  expect(slot.getAllByText("Было")).toHaveLength(3);
  expect(slot.getAllByText("Станет")).toHaveLength(3);
  expect(slot.getByText(quote)).toBeTruthy();
  expect(slot.getByRole("link", { hidden: true }).getAttribute("href")).toContain("mail.google.com");
  fireEvent.click(slot.getByRole("button", { name: "Принять обновление" }));
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
  const accept = await slot.findByRole("button", { name: "Принять обновление" });
  expect((accept as HTMLButtonElement).disabled).toBe(true);
  expect(slot.getByText("Недоступен")).toBeTruthy();
  expect(slot.getByText(/Slack требует входа/)).toBeTruthy();
  expect(slot.getByText(/Досье изменилось после проверки/)).toBeTruthy();
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
  const finish = await within(slot.container).findByRole("button", { name: "Завершить сессию" });
  const compact = await within(other.container).findByRole("button", { name: "Завершить сессию" });
  expect(compact.textContent).toBe("");
  fireEvent.click(finish); fireEvent.click(finish);
  await waitFor(() => expect(f.repo.session(first.id).status).toBe("reviewing"));
  expect(f.repo.session(second.id).status).toBe("working");
  expect(f.harness.inspection.sdk.callsTo("threads.stop").flat()).toContainEqual({ threadId: first.workerThreadId });
  expect(f.harness.inspection.sdk.callsTo("threads.stop").flat()).not.toContainEqual({ threadId: second.workerThreadId });
  expect(slot.inspection.rpcCalls.filter((call) => call.method === "finish")).toEqual([{ method: "finish", input: { sessionId: first.id } }]);
  expect(other.inspection.rpcCalls.some((call) => call.method === "finish")).toBe(false);
  const dossier = await within(slot.container).findByRole("button", { name: "Досье сессии" });
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
  await ended.findByRole("button", { name: "Досье сессии" });
  expect(ended.queryByRole("button", { name: "Завершить сессию" })).toBeNull();
});

it("refreshes the header when the session is finished in another window", async () => {
  const f = await fixture(); const task = await f.create();
  await f.harness.behavior.callRpc("start", { ...f.startInput(task.id, task.revision), criteria: [] });
  const session = f.repo.sessions(task.id)[0];
  const slot = setupThread(f, session.workerThreadId!);
  await slot.findByRole("button", { name: "Завершить сессию" });
  await f.harness.behavior.callRpc("finish", { sessionId: session.id });
  await slot.behavior.emitRealtime("desk-changed", {});
  await slot.findByRole("button", { name: "Досье сессии" });
  expect(slot.queryByRole("button", { name: "Завершить сессию" })).toBeNull();
  expect(slot.inspection.rpcCalls.some((call) => call.method === "finish")).toBe(false);
});

it("keeps the conversation open after a failed finish and lets the user retry", async () => {
  const f = await fixture(); const task = await f.create();
  await f.harness.behavior.callRpc("start", { ...f.startInput(task.id, task.revision), criteria: [] });
  const session = f.repo.sessions(task.id)[0];
  const catalog = await f.bb.sdk.providers.models({ providerId: "claude-code" });
  f.harness.inspection.sdk.stub("providers.models", () => ({ models: [], modelLoadError: "offline" }));
  const slot = setupThread(f, session.workerThreadId!);
  fireEvent.click(await slot.findByRole("button", { name: "Завершить сессию" }));
  await slot.findByRole("button", { name: "Завершить сессию" });
  expect(f.repo.session(session.id)).toMatchObject({ status: "working", finishedAt: null });
  expect(f.harness.inspection.sdk.callsTo("threads.stop")).toHaveLength(0);
  f.harness.inspection.sdk.stub("providers.models", () => catalog);
  fireEvent.click(slot.getByRole("button", { name: "Завершить сессию" }));
  await waitFor(() => expect(f.repo.session(session.id).status).toBe("reviewing"));
  await slot.findByRole("button", { name: "Досье сессии" });
});

it("starts with an empty desk, creates a real task, and navigates to its dossier", async () => {
  const { f, slot } = await setup();
  await slot.findByText("Место для того, что важно");
  fireEvent.click(slot.getByRole("button", { name: "Добавить первую задачу" }));
  fireEvent.change(slot.getByLabelText("Какой результат нужен?"), { target: { value: "Подготовить план" } });
  fireEvent.change(slot.getByLabelText(/Что важно знать/), { target: { value: "Три этапа" } });
  fireEvent.click(slot.getByRole("button", { name: "Создать задачу" }));
  await waitFor(() => expect(f.repo.list().total).toBe(1));
  expect(slot.inspection.navigateCalls).toHaveLength(1);
  expect(JSON.stringify(slot.inspection.navigateCalls[0])).toContain(f.repo.list().tasks[0].id);
  expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
});

it("refreshes from another window's event and shows explicit unknown priority separately", async () => {
  const { f, slot } = await setup();
  await slot.findByText("Место для того, что важно");
  const task = await f.create();
  await f.harness.behavior.callRpc("classify", { taskId: task.id, revision: 0, urgent: true, important: null });
  await slot.behavior.emitRealtime("desk-changed", {});
  await slot.findByText("Подготовить план");
  fireEvent.click(slot.getByRole("button", { name: /Разобрать/ }));
  expect(slot.getByText("Подготовить план")).toBeTruthy();
  fireEvent.click(slot.getByRole("button", { name: /Сейчас/ }));
  await slot.findByText("Здесь пока пусто");
});

it("keeps a failed note draft, then saves it against the refreshed dossier", async () => {
  const f = await fixture(); const task = await f.create();
  const { slot } = await setup(task.id, f);
  await slot.findByText("Где мы сейчас");
  fireEvent.change(slot.getByLabelText("Добавить в контекст"), { target: { value: "Моя новая запись" } });
  await f.harness.behavior.callRpc("note", { taskId: task.id, revision: task.revision, kind: "description", text: "Из другого окна", requestId: randomUUID() });
  fireEvent.click(slot.getByRole("button", { name: "Сохранить запись" }));
  await slot.findByRole("alert");
  expect((slot.getByLabelText("Добавить в контекст") as HTMLTextAreaElement).value).toBe("Моя новая запись");
  await slot.findByText("Из другого окна");
  fireEvent.click(slot.getByRole("button", { name: "Сохранить запись" }));
  await slot.findByText("Моя новая запись");
  expect((slot.getByLabelText("Добавить в контекст") as HTMLTextAreaElement).value).toBe("");
});

it("shows the proposed value and evidence before accepting a change", async () => {
  const f = await fixture(); const task = await f.create(); const dossier = await f.detail(task.id);
  const proposal = f.repo.propose({ taskId: task.id, revision: task.revision, requestId: randomUUID(), draft: { rationale: "Сводка из фактов", confidence: 1, changes: { summary: { value: dossier.facts[0].text, evidenceRefs: [dossier.facts[0].id] } } } }, "test");
  const { slot } = await setup(task.id, f);
  fireEvent.click(await slot.findByRole("tab", { name: "Предложения · 1" }));
  await slot.findByText("Предлагается");
  expect(slot.getByText("Сейчас")).toBeTruthy();
  expect(slot.getByText(/На чём основано/)).toBeTruthy();
  expect((await f.detail(task.id)).projection.summary).toBeNull();
  fireEvent.click(slot.getByRole("button", { name: "Принять изменения" }));
  await slot.findByText("Всё рассмотрено");
  expect((await f.detail(task.id)).projection.summary).toBe(dossier.facts[0].text);
  expect(slot.inspection.rpcCalls).toContainEqual({ method: "accept", input: { proposalId: proposal.id, revision: task.revision } });
});

it("opens an ordinary conversation from BB's native composer and finishes only by button", async () => {
  const f = await fixture(); const task = await f.create();
  const { slot } = await setup(task.id, f);
  fireEvent.click(await slot.findByRole("tab", { name: "Работа" }));
  const composer = await slot.findByTestId("bb-new-thread-composer");
  expect(composer.getAttribute("data-default-model")).toBe("claude-opus-5[1m]");
  expect(slot.queryByLabelText("Готово, когда…")).toBeNull();
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
  const finish = await slot.findByRole("button", { name: "Завершить сессию" });
  expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
  expect(slot.queryByLabelText("Кто разбирает разговор")).toBeNull();
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
  fireEvent.click(await slot.findByRole("tab", { name: "Предложения · 1" }));
  expect(await slot.findByRole("heading", { name: "Статус задачи" })).toBeTruthy();
  expect(slot.getByText("Завершена")).toBeTruthy();
  expect(slot.getByText("Цитаты из разговора")).toBeTruthy();
  expect(f.repo.kernel.getTask(task.id).status).toBe("open");
  fireEvent.click(slot.getByRole("button", { name: "Принять и завершить задачу" }));
  await slot.findByRole("button", { name: "Вернуть в работу" });
  expect(f.repo.kernel.getTask(task.id)).toMatchObject({ status: "done", revision: task.revision + 1 });
  fireEvent.click(slot.getByRole("tab", { name: "История" }));
  const undo = await slot.findByRole("button", { name: "Предложить отмену завершения и изменений" });
  expect((undo as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(undo);
  fireEvent.click(await slot.findByRole("tab", { name: "Предложения · 1" }));
  const accept = await slot.findByRole("button", { name: "Принять изменения" });
  expect((accept as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(accept);
  await slot.findByRole("button", { name: "Завершить" });
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
  fireEvent.click(await slot.findByRole("tab", { name: /Предложения/ }));
  await slot.findByRole("heading", { name: "Срочность" });
  expect(slot.getByRole("heading", { name: "Важность" })).toBeTruthy();
  expect(slot.getAllByText("Да")).toHaveLength(2);
  expect(slot.getAllByText("Нет")).toHaveLength(2);
  expect(slot.getByText("Вопросы Мэри")).toBeTruthy();
  expect(f.repo.planning(task.id)).toMatchObject({ urgent: true, important: true });
  fireEvent.click(slot.getByRole("button", { name: "Принять изменения" }));
  await waitFor(() => expect(f.repo.kernel.getProposal(proposal.id).status).toBe("applied"));
  expect(f.repo.kernel.getTask(task.id).status).toBe("open");
  expect(f.repo.planning(task.id)).toMatchObject({ urgent: false, important: false });
  const desk = await setup(undefined, f);
  fireEvent.click(await desk.slot.findByRole("button", { name: /На потом/ }));
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
  fireEvent.click(await slot.findByRole("tab", { name: /Предложения/ }));
  fireEvent.click(await slot.findByRole("button", { name: "Обсудить разбор" }));
  const composer = await slot.findByTestId("bb-new-thread-composer");
  expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(2);
  expect(composer.getAttribute("data-default-provider-id")).toBe("codex");
  expect(composer.getAttribute("data-default-model")).toBe("gpt-5.6-sol");
  expect((slot.getByTestId("bb-new-thread-composer-input") as HTMLTextAreaElement).value).toContain("обсудить разбор");
  fireEvent.change(slot.getByTestId("bb-new-thread-composer-input"), { target: { value: "Почему ты снизил только срочность?" } });
  fireEvent.click(slot.getByTestId("bb-new-thread-composer-submit"));
  await waitFor(() => expect(f.repo.sessions(task.id)).toHaveLength(2));
  await waitFor(() => expect(f.repo.sessions(task.id)[0].status).toBe("working"));
  expect(f.repo.sessions(task.id)[0]).toMatchObject({ continuedFrom: previous.id, discussionProposalId: previous.proposalId });
  expect(f.repo.kernel.getProposal(previous.proposalId!).status).toBe("pending");
  fireEvent.click(slot.getByRole("tab", { name: /Предложения/ }));
  const accept = await slot.findByRole("button", { name: "Принять изменения" });
  expect((accept as HTMLButtonElement).disabled).toBe(true);
  expect(slot.getByText(/Открыто обсуждение разбора/)).toBeTruthy();
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
  fireEvent.click(await slot.findByRole("tab", { name: "Предложения · 1" }));
  await slot.findByText("Записи в досье · 1");
  expect(slot.getByText("В базу знаний · 1")).toBeTruthy();
  expect(slot.getByText("Цитаты из разговора")).toBeTruthy();
  expect(slot.getByRole("button", { name: "Открыть исходный разговор" })).toBeTruthy();
  expect(f.repo.knowledge().total).toBe(0);
  fireEvent.click(slot.getByRole("button", { name: "Принять изменения" }));
  await waitFor(() => expect(f.repo.knowledge().total).toBe(1));
  expect(f.repo.kernel.getDossier(task.id).facts.some((v) => v.text === fact)).toBe(true);
});

it("opens the shared knowledge page with search and an honest empty state", async () => {
  const { slot } = await setup("knowledge");
  await slot.findByText("Знания появятся после разговора");
  fireEvent.change(slot.getByLabelText("Поиск по базе знаний"), { target: { value: "счета" } });
  await slot.findByText("Совпадений нет");
  expect(slot.inspection.rpcCalls).toContainEqual({ method: "knowledge", input: { query: "счета", offset: 0 } });
});

it("shows an imported document with a real source file link and expands its complete text", async () => {
  const f = await fixture();
  const body = "---\nname: Source metadata\n---\n# ExampleERP guide\n\n" + "Справочная информация. ".repeat(100) + "\n\nПоследний раздел сохранён целиком.";
  await f.harness.behavior.callRpc("importKnowledge", { requestId: randomUUID(), source: { label: "ExampleCo", hostId: "host_test", rootPath: "/Knowledge Base" }, documents: [{ relativePath: "reference/example.md", title: "ExampleERP guide", body, tags: ["reference"] }] });
  const { slot } = await setup("knowledge", f);
  await slot.findByRole("heading", { name: "ExampleERP guide" });
  expect(slot.getByText("ExampleCo · reference/example.md")).toBeTruthy();
  expect(slot.getByRole("link", { name: "Исходный файл" }).getAttribute("href")).toBeTruthy();
  expect(slot.queryByRole("button", { name: "Досье задачи" })).toBeNull();
  expect(slot.queryByRole("button", { name: "Исходный разговор" })).toBeNull();
  expect(slot.queryByText(/Последний раздел сохранён целиком/)).toBeNull();
  fireEvent.click(slot.getByRole("button", { name: "Читать полностью" }));
  await slot.findByText(/Последний раздел сохранён целиком/);
  expect(slot.queryByText(/name: Source metadata/)).toBeNull();
  fireEvent.click(slot.getByRole("button", { name: "Свернуть" }));
  expect(slot.queryByText(/Последний раздел сохранён целиком/)).toBeNull();
  expect(f.repo.knowledge().entries[0].body).toBe(body);
});

it("uses the returned page boundary for large files and returns to the previous page", async () => {
  const f = await fixture();
  const documents = Array.from({ length: 6 }, (_, i) => ({ relativePath: `reference/doc-${i}.md`, title: `Document ${i}`, body: "a".repeat(100000), tags: [] }));
  await f.harness.behavior.callRpc("importKnowledge", { requestId: randomUUID(), source: { label: "ExampleCo", hostId: "host_test", rootPath: "/Knowledge Base" }, documents });
  const { slot } = await setup("knowledge", f);
  await slot.findByText("Записи 1–5 из 6");
  fireEvent.click(slot.getByRole("button", { name: "Дальше" }));
  await slot.findByText("Записи 6–6 из 6");
  expect(slot.inspection.rpcCalls).toContainEqual({ method: "knowledge", input: { query: "", offset: 5 } });
  fireEvent.click(slot.getByRole("button", { name: "Назад" }));
  await slot.findByText("Записи 1–5 из 6");
  fireEvent.change(slot.getByLabelText("Поиск по базе знаний"), { target: { value: "Document 5" } });
  await slot.findByText("Записи 1–1 из 1");
  expect(slot.queryByRole("button", { name: "Назад" })).toBeNull();
});
