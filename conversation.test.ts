import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { makePluginAgentConfigurationContext } from "@get-bb/plugin-sdk/testing";
import { fixture, type TimelineRow } from "./test-support.js";
import { sessionSchema, type Extraction, type Session, type Transcript } from "./contracts.js";
import { readConversation, validateExtraction } from "./conversation.js";
import { SessionRuntime } from "./runtime.js";

const hosts: Awaited<ReturnType<typeof fixture>>[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const f of hosts.splice(0)) await f.harness.lifecycle.dispose(); });
async function conversation(provider = "codex", options: { deferEnvironment?: boolean; maximumRepairs?: number } = {}) {
  const f = await fixture(options); hosts.push(f);
  if (options.maximumRepairs !== undefined) await f.harness.behavior.setSettings({ maximumRepairs: options.maximumRepairs });
  const task = await f.create();
  const { criteria: _, ...input } = f.startInput(task.id, task.revision);
  input.request.providerId = provider;
  input.request.model = provider === "codex" ? "gpt-5.6-sol" : "claude-fable-5-1";
  input.request.input[0].text = "Давай разберём заявку.";
  const session = sessionSchema.parse(await f.harness.behavior.callRpc("start", input));
  return { f, task, session };
}
const progress = "Стор активирован 7 сентября. Ждём подтверждение invoice booked.";
const nextStep = "После подтверждения деактивировать стор.";
const rule = "В этой интеграции статус invoice booked означает, что счёт проведён.";
function extraction(transcript: Transcript): Extraction {
  const cite = (text: string) => [{ messageRef: transcript.messages.find((m) => m.text.includes(text))!.ref, quote: text }];
  return { rationale: "Уточнены статус, следующий шаг и значение статуса счёта.", facts: [
    { kind: "progress", text: progress, citations: cite(progress) },
    { kind: "explicit_next_step", text: nextStep, citations: cite(nextStep) },
    { kind: "description", text: rule, citations: cite(rule) },
  ], changes: { summary: { value: progress, evidenceRefs: ["fact:0"] }, nextStep: { value: nextStep, evidenceRefs: ["fact:1"] } },
  knowledge: [{ title: "Значение invoice booked", body: rule, tags: ["счета", "интеграция"], evidenceRefs: ["fact:2"] }] };
}
async function finishExample(f: Awaited<ReturnType<typeof fixture>>, session: Session) {
  f.message(session.workerThreadId!, "user", progress);
  await f.idle(session.workerThreadId!, "Понятно, ждём подтверждение.");
  f.message(session.workerThreadId!, "user", nextStep);
  f.message(session.workerThreadId!, "user", rule);
  await f.idle(session.workerThreadId!, "Обсудили. Можно вернуться к этому позже.");
  await f.harness.behavior.callRpc("finish", { sessionId: session.id });
  return f.repo.session(session.id);
}
async function pollSession(f: Awaited<ReturnType<typeof fixture>>, session: Session) {
  // A late idle event drives the same tick as the background session monitor.
  const thread = f.threads.get(session.workerThreadId!)!;
  const result = await f.harness.behavior.emitThreadEvent("thread.idle", { thread, lastAssistantText: "Разговор завершён." });
  if (result.errors.length) throw result.errors[0];
  return f.repo.session(session.id);
}
const completionReport = "Перепроверил: обе фазы задачи выполнены, обязательных действий больше нет. Задачу можно закрывать.";
async function completedExample(f: Awaited<ReturnType<typeof fixture>>, session: Session) {
  await f.idle(session.workerThreadId!, completionReport);
  await f.harness.behavior.callRpc("finish", { sessionId: session.id });
  const source = f.repo.transcript(session.id)!.messages.find((m) => m.text === completionReport)!;
  const draft: Extraction = { rationale: "Ассистент сообщил, что перепроверил обе фазы и задачу можно завершить. Предлагается завершение после проверки пользователем.",
    facts: [{ kind: "progress", text: `Ассистент сообщил: ${completionReport}`, citations: [{ messageRef: source.ref, quote: completionReport }] }],
    changes: { status: { value: "done", evidenceRefs: ["fact:0"] }, nextStep: { value: null, evidenceRefs: ["fact:0"] } }, knowledge: [] };
  await f.idle(f.repo.session(session.id).reviewerThreadId!, draft);
  return f.repo.session(session.id);
}

describe("Conversations and their recorder", () => {
  it("keeps equally named task threads distinct through recovery, configuration, and Finish", async () => {
    const f = await fixture(); hosts.push(f);
    const tasks = [await f.create(), await f.create("Другая заявка с тем же названием")];
    const sessions: Session[] = [];
    for (const task of tasks) {
      sessions.push(sessionSchema.parse(await f.harness.behavior.callRpc("start", { ...f.startInput(task.id, task.revision), criteria: [] })));
    }
    expect(sessions.map((s) => f.threads.get(s.workerThreadId!)?.title)).toEqual(tasks.map((t) => `247C · ${t.title}`));
    // Simulate interruption after binding/renaming but before marking Working.
    f.repo.saveSession({ ...sessions[0], status: "starting" });
    await f.reload();
    await f.idle(sessions[0].workerThreadId!, "Продолжаем разговор по первой задаче.");
    expect(f.repo.session(sessions[0].id).status).toBe("working");
    for (const [i, session] of sessions.entries()) {
      const thread = f.threads.get(session.workerThreadId!)!;
      const config = await f.harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({ thread: { id: thread.id, title: thread.title }, origin: { pluginId: "247c" } }));
      expect(JSON.stringify(config.tools)).toContain("c247_read");
      expect(JSON.stringify(config.tools)).toContain("c247_knowledge");
      for (const tool of ["c247_create", "c247_propose", "c247_submit_result"]) expect(JSON.stringify(config.tools)).not.toContain(tool);
      expect(await f.harness.behavior.callRpc("threadSession", { threadId: thread.id })).toMatchObject({ session: { id: session.id, taskId: tasks[i].id } });
      await expect(f.harness.behavior.callAgentTool("c247_read", { taskId: tasks[1 - i].id }, { threadId: thread.id })).rejects.toThrow(/only its own task dossier/);
    }
    await f.harness.behavior.callRpc("finish", { sessionId: sessions[0].id });
    expect(f.repo.session(sessions[0].id).status).toBe("reviewing");
    expect(f.repo.session(sessions[1].id).status).toBe("working");
    expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
  });

  it("retries a failed title update without blocking work and preserves a user's custom title", async () => {
    const f = await fixture(); hosts.push(f);
    const task = await f.create();
    f.harness.inspection.sdk.stub("threads.update", () => { throw new Error("Temporary rename failure"); });
    const session = sessionSchema.parse(await f.harness.behavior.callRpc("start", { ...f.startInput(task.id, task.revision), criteria: [] }));
    expect(session.status).toBe("working");
    expect(f.harness.inspection.sdk.callsTo("threads.stop")).toHaveLength(0);
    f.harness.inspection.sdk.stub("threads.update", ({ threadId, title }) => {
      const thread = { ...f.threads.get(threadId)!, title: title! };
      f.threads.set(threadId, thread);
      return thread;
    });
    await f.idle(session.workerThreadId!, "Обычный ответ");
    expect(f.threads.get(session.workerThreadId!)?.title).toBe(`247C · ${task.title}`);
    const updates = f.harness.inspection.sdk.callsTo("threads.update").length;
    f.threads.set(session.workerThreadId!, { ...f.threads.get(session.workerThreadId!)!, title: "Моё название разговора" });
    await f.idle(session.workerThreadId!, "Continuation");
    expect(f.threads.get(session.workerThreadId!)?.title).toBe("Моё название разговора");
    expect(f.harness.inspection.sdk.callsTo("threads.update")).toHaveLength(updates);
  });

  it.each((["finish", "retry"] as const).flatMap(action => ["/ready/work", "C:/ready/work", String.raw`C:\ready\work`, String.raw`\\server\share\work`].map(path => ({ action, path }))))("resolves a workspace assigned after spawn on $action at $path, including after reload", async ({ action, path }) => {
    const { f, task, session } = await conversation("claude-work", { deferEnvironment: true });
    expect(session.environmentId).toBeNull();
    const before = await f.detail(task.id);
    f.message(session.workerThreadId!, "assistant", "Проверил заявку, результат сохранён в разговоре.");
    const transcript = await readConversation(f.bb, session);
    if (action === "retry") {
      f.repo.saveTranscript(session.id, transcript);
      f.repo.saveSession({ ...session, status: "blocked", finishedAt: new Date().toISOString(), error: "BB не сообщил рабочую папку сессии." });
    }
    // No new created/idle event: finishing must query the current worker itself.
    f.threads.set(session.workerThreadId!, { ...f.threads.get(session.workerThreadId!)!, status: "idle", environmentId: "env_ready" });
    await f.reload();
    f.harness.inspection.sdk.stub("environments.get", ({ environmentId }) => ({ id: environmentId, hostId: "host_ready", path, status: "ready" }));
    const current = sessionSchema.parse(await f.harness.behavior.callRpc(action, { sessionId: session.id }));
    expect(current).toMatchObject({ status: "reviewing", workerThreadId: session.workerThreadId, environmentId: "env_ready", hostId: "host_ready", error: null, round: action === "retry" ? 1 : 0 });
    expect(f.repo.transcript(session.id)?.messages).toEqual(transcript.messages);
    expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
    expect(f.harness.inspection.sdk.callsTo("threads.spawn")[0][0]).toMatchObject({ visibility: "hidden", environment: { type: "host", hostId: "host_ready", workspace: { type: "personal" } } });
    expect(f.harness.inspection.sdk.callsTo("providers.list").at(-1)?.[0]).toEqual({ environmentId: "env_ready" });
    expect(f.harness.inspection.sdk.callsTo("providers.models").every(([args]) => (args as { environmentId?: string }).environmentId === "env_ready")).toBe(true);
    expect(f.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
    expect((await f.detail(task.id)).task).toEqual(before.task);
  });

  it("keeps a conversation open while BB has not assigned its workspace", async () => {
    const { f, session } = await conversation("claude-work", { deferEnvironment: true });
    await expect(f.harness.behavior.callRpc("finish", { sessionId: session.id })).rejects.toThrow(/not prepared the session workspace yet/);
    expect(f.repo.session(session.id)).toMatchObject({ status: "working", finishedAt: null, environmentId: null });
    expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
    expect(f.harness.inspection.sdk.callsTo("threads.stop")).toHaveLength(0);
  });

  it("starts without criteria and stays open across ordinary answers, pauses, and dossier edits", async () => {
    const { f, task, session } = await conversation();
    expect(session.mode).toBe("conversation");
    expect(session.criteria).toEqual([]);
    f.repo.saveSession({ ...session, deadlineAt: 1 });
    await f.idle(session.workerThreadId!, "Привет! Что проверим первым?");
    await f.harness.behavior.callRpc("note", { taskId: task.id, revision: task.revision, requestId: randomUUID(), kind: "progress", text: "Новая запись из другого окна" });
    f.message(session.workerThreadId!, "user", "Давай уточним статус.");
    await f.idle(session.workerThreadId!, "Обсудим, что уже известно.");
    expect(f.repo.session(session.id).status).toBe("working");
    expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
    expect(f.harness.inspection.sdk.callsTo("threads.stop")).toHaveLength(0);
    const runtime = new SessionRuntime(f.bb, f.repo, async () => ({ codexReviewer: "unused", claudeReviewer: "unused", maximumRepairs: 2, sessionMinutes: 20 }));
    expect(runtime.dispatch(session.workerThreadId!)).toEqual({ action: "proceed" });
    await expect(f.harness.behavior.callAgentTool("c247_submit_result", { summary: "Готово", artifacts: [] }, { threadId: session.workerThreadId! })).rejects.toThrow(/Finish session/);
  });

  it("automatically picks a different model family only after Finish, exactly once", async () => {
    const { f, session } = await conversation("claude-work");
    await f.idle(session.workerThreadId!, "Обычный ответ без JSON.");
    f.message(session.workerThreadId!, "user", "Запомни ещё это уточнение.");
    const [first, second] = await Promise.all([
      f.harness.behavior.callRpc("finish", { sessionId: session.id }),
      f.harness.behavior.callRpc("finish", { sessionId: session.id }),
    ]);
    expect(first).toBeTruthy(); expect(second).toBeTruthy();
    const current = f.repo.session(session.id);
    expect(current.status).toBe("reviewing");
    const calls = f.harness.inspection.sdk.callsTo("threads.spawn");
    expect(calls).toHaveLength(2);
    expect(calls[1][0]).toMatchObject({ providerId: "codex", model: "gpt-5.6-sol", reasoningLevel: "low", visibility: "hidden", executionInputSources: { providerId: "explicit", model: "explicit", reasoningLevel: "explicit" } });
    expect(calls[1][0]).not.toHaveProperty("parentThreadId");
    expect(JSON.stringify(calls[1][0])).toContain("Обычный ответ без JSON.");
    expect(JSON.stringify(calls[1][0])).toContain("Запомни ещё это уточнение.");
    const config = await f.harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({ thread: { id: session.workerThreadId!, title: f.threads.get(session.workerThreadId!)!.title }, origin: { pluginId: "247c" } }));
    expect(JSON.stringify(config)).not.toContain("c247_submit_result");
    const runtime = new SessionRuntime(f.bb, f.repo, async () => ({ codexReviewer: "", claudeReviewer: "", maximumRepairs: 2, sessionMinutes: 20 }));
    expect(runtime.dispatch(session.workerThreadId!).action).toBe("reject");
    expect(runtime.dispatch(current.reviewerThreadId!).action).toBe("proceed");
  });

  it("reads older pages and answered questions, preserving source roles and excluding rejected input", async () => {
    const { f, session } = await conversation();
    const first = f.message(session.workerThreadId!, "user", "Раннее решение");
    const second = f.message(session.workerThreadId!, "assistant", "Поздний ответ");
    const question = { ...second, id: "question_1", kind: "work", workKind: "question", questions: [{ id: "next", prompt: "Какой следующий шаг?", options: [], allowFreeText: true, multiSelect: false }], answers: { next: { selected: [], freeText: "Проверить счёт." } }, lifecycle: "answered", status: "completed", statusReason: null, interactionId: "question" } as TimelineRow;
    const rejected = { ...first, id: "rejected", text: "Неотправленное поручение", turnRequest: { kind: "message", isGrouped: false, status: "rejected" } } as TimelineRow;
    f.harness.inspection.sdk.stub("threads.timeline", ({ beforeAnchorId }) => ({ rows: beforeAnchorId ? [first] : [second, question, rejected], timelinePage: { hasOlderRows: !beforeAnchorId, olderCursor: beforeAnchorId ? null : { anchorId: "older", anchorSeq: 2 } } }));
    const transcript = await readConversation(f.bb, session);
    expect(transcript.messages.map((m) => m.text)).toEqual(["Раннее решение", "Поздний ответ", "Какой следующий шаг?", "Проверить счёт."]);
    expect(transcript.messages.at(-1)?.role).toBe("user");
    expect(f.harness.inspection.sdk.callsTo("threads.timeline")).toHaveLength(2);
  });

  it("avoids the final worker model after a model change and does not inherit expensive reasoning", async () => {
    const { f, session } = await conversation("claude-work");
    f.models.set(session.workerThreadId!, "claude-sonnet-5");
    f.harness.inspection.sdk.stub("threads.defaultExecutionOptions", ({ threadId }) => ({ model: f.models.get(threadId), reasoningLevel: "max" }));
    await f.harness.behavior.callRpc("finish", { sessionId: session.id });
    expect(f.repo.session(session.id).workerModel).toBe("claude-sonnet-5");
    expect(f.harness.inspection.sdk.callsTo("threads.spawn").at(-1)?.[0]).toMatchObject({ providerId: "codex", model: "gpt-5.6-sol", reasoningLevel: "low" });
  });

  it("chooses Sonnet when the user changed the Codex worker during the conversation", async () => {
    const { f, session } = await conversation();
    f.models.set(session.workerThreadId!, "gpt-6-astra");
    await f.harness.behavior.callRpc("finish", { sessionId: session.id });
    expect(f.harness.inspection.sdk.callsTo("threads.spawn").at(-1)?.[0]).toMatchObject({ providerId: "claude-code", model: "claude-sonnet-5", reasoningLevel: "low" });
  });

  it("skips a broken provider catalog and never routes a personal conversation to the corporate account", async () => {
    const { f, session } = await conversation();
    f.harness.inspection.sdk.stub("providers.models", ({ providerId }) => {
      if (providerId === "claude-code") throw new Error("Account offline");
      if (providerId === "claude-work") throw new Error("Must not access corporate catalog");
      return { models: [{ id: "gpt-5.6-sol", model: "gpt-5.6-sol", defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "medium" }] }], modelLoadError: null };
    });
    await f.harness.behavior.callRpc("finish", { sessionId: session.id });
    expect(f.repo.session(session.id)).toMatchObject({ reviewerProvider: "codex", reviewerModel: "gpt-5.6-sol", reviewerReasoning: "medium" });
    expect(f.harness.inspection.sdk.callsTo("providers.models").some(([args]) => (args as { providerId?: string } | undefined)?.providerId === "claude-work")).toBe(false);
  });

  it("keeps the conversation open when no catalog can supply a recorder", async () => {
    const { f, session } = await conversation();
    f.harness.inspection.sdk.stub("providers.models", () => ({ models: [], modelLoadError: "Unavailable" }));
    await expect(f.harness.behavior.callRpc("finish", { sessionId: session.id })).rejects.toThrow(/No review model is available/);
    expect(f.repo.session(session.id)).toMatchObject({ status: "working", finishedAt: null });
    expect(f.harness.inspection.sdk.callsTo("threads.stop")).toHaveLength(0);
  });

  it("keeps the conversation open if only excluded recorder models are available", async () => {
    const { f, session } = await conversation();
    f.harness.inspection.sdk.stub("providers.models", ({ providerId }) => ({ modelLoadError: null, models: [{ id: "default", model: providerId === "codex" ? "gpt-5.6-luna" : "claude-haiku-4-5-20251001", defaultReasoningEffort: "low", supportedReasoningEfforts: [{ reasoningEffort: "low" }] }] }));
    await expect(f.harness.behavior.callRpc("finish", { sessionId: session.id })).rejects.toThrow(/No review model is available/);
    expect(f.repo.session(session.id)).toMatchObject({ status: "working", finishedAt: null });
    expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
  });

  it.each([{ recorder: "same", model: "gpt-5.6-luna" }, { recorder: "same", model: "gpt-5.3-codex-spark" }, { recorder: "personal-claude", model: "claude-haiku-4-5-20251001" }] as const)("rejects $model from an older client's $recorder choice", async ({ recorder, model }) => {
    const { f, session } = await conversation();
    if (recorder === "same") f.models.set(session.workerThreadId!, model);
    else await f.harness.behavior.setSettings({ claudeReviewer: model });
    await expect(f.harness.behavior.callRpc("finish", { sessionId: session.id, recorder })).rejects.toThrow(/excluded from review/);
    expect(f.repo.session(session.id)).toMatchObject({ status: "working", finishedAt: null });
    expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
    expect(f.harness.inspection.sdk.callsTo("threads.stop")).toHaveLength(0);
  });

  it("automatically tries another recorder on Retry after a failed extraction", async () => {
    const { f, session } = await conversation("claude-work", { maximumRepairs: 0 });
    const reviewing = await finishExample(f, session);
    expect(reviewing.reviewerModel).toBe("gpt-5.6-sol");
    await f.idle(reviewing.reviewerThreadId!, "Невалидный результат");
    const retried = sessionSchema.parse(await f.harness.behavior.callRpc("retry", { sessionId: session.id }));
    expect(retried).toMatchObject({ status: "reviewing", reviewerProvider: "claude-code", reviewerModel: "claude-sonnet-5", reviewerReasoning: "low" });
  });

  it("can retry a corporate conversation with a personal Claude recorder", async () => {
    const { f, session } = await conversation("claude-work", { maximumRepairs: 0 });
    const reviewing = await finishExample(f, session);
    await f.idle(reviewing.reviewerThreadId!, "Невалидный результат");
    const retried = sessionSchema.parse(await f.harness.behavior.callRpc("retry", { sessionId: session.id, recorder: "personal-claude" }));
    expect(retried.status).toBe("reviewing");
    expect(retried.workerProvider).toBe("claude-work");
    expect(retried.reviewerProvider).toBe("claude-code");
    expect(f.harness.inspection.sdk.callsTo("threads.spawn").at(-1)?.[0]).toMatchObject({ providerId: "claude-code", model: "claude-fable-5-1", visibility: "hidden" });
  });

  it.each(["invalid JSON", "decorated instruction", "inexact quote", "paraphrased question"])("automatically repairs %s with the frozen conversation and waits for human approval", async (failure) => {
    const { f, task, session } = await conversation("claude-work");
    const reviewing = await finishExample(f, session);
    const before = await f.detail(task.id);
    const transcript = f.repo.transcript(session.id)!;
    const bad = extraction(transcript);
    if (failure === "decorated instruction") bad.facts[1].text = `Запрос пользователя: «${nextStep}»`;
    if (failure === "inexact quote") bad.facts[0].citations[0].quote = "Этого в переписке не было.";
    if (failure === "paraphrased question") bad.changes!.openQuestions = { value: ["Когда придёт подтверждение?"], evidenceRefs: ["fact:0"] };
    await f.idle(reviewing.reviewerThreadId!, failure === "invalid JSON" ? "broken JSON" : bad);
    expect(f.repo.session(session.id)).toMatchObject({ status: "collecting", reviewerModel: "claude-sonnet-5", extractionRepair: { attempt: 1 }, proposalId: null, deadlineAt: reviewing.deadlineAt });
    expect(f.threads.get(reviewing.reviewerThreadId!)?.archivedAt).not.toBeNull();
    // Late worker messages cannot change the source of an automatic correction.
    f.message(session.workerThreadId!, "user", "Это сообщение пришло после сохранения разговора.");
    const repaired = await pollSession(f, session);
    expect(repaired.status).toBe("reviewing");
    const spawn = f.harness.inspection.sdk.callsTo("threads.spawn").at(-1)![0];
    expect(spawn).toMatchObject({ providerId: "claude-code", model: "claude-sonnet-5", visibility: "hidden" });
    expect(spawn).toMatchObject({ prompt: expect.stringContaining("A previous attempt failed validation") });
    expect(spawn).not.toMatchObject({ prompt: expect.stringContaining("Это сообщение пришло после сохранения разговора.") });
    await pollSession(f, session);
    expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(3);
    await f.idle(repaired.reviewerThreadId!, extraction(transcript));
    expect(f.repo.session(session.id)).toMatchObject({ status: "awaiting_approval", error: null });
    expect(f.repo.transcript(session.id)).toEqual(transcript);
    const pending = await f.detail(task.id);
    expect(pending.task).toEqual(before.task);
    expect(pending.facts).toEqual(before.facts);
    expect(pending.projection).toEqual(before.projection);
    expect(f.repo.knowledge().total).toBe(0);
    expect(f.threads.get(session.workerThreadId!)?.archivedAt).toBeNull();
  });

  it("caps automatic repairs at two and resets the count only on an explicit retry", async () => {
    const { f, session } = await conversation("claude-work");
    const initial = await finishExample(f, session);
    let reviewing = initial;
    for (let attempt = 0; attempt <= 2; attempt++) {
      await f.idle(reviewing.reviewerThreadId!, "broken JSON");
      if (attempt < 2) {
        expect(f.repo.session(session.id)).toMatchObject({ status: "collecting", extractionRepair: { attempt: attempt + 1 }, deadlineAt: initial.deadlineAt });
        reviewing = await pollSession(f, session);
      }
    }
    expect(f.repo.session(session.id)).toMatchObject({ status: "blocked", extractionRepair: { attempt: 2 }, proposalId: null });
    expect(f.repo.session(session.id).error).toContain("after 2 automatic repairs");
    await pollSession(f, session);
    expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(4);
    const retried = sessionSchema.parse(await f.harness.behavior.callRpc("retry", { sessionId: session.id }));
    expect(retried).toMatchObject({ status: "reviewing", extractionRepair: null });
  });

  it.each(["stale dossier", "cancelled session"])("does not start a queued automatic repair after a %s", async (condition) => {
    const { f, task, session } = await conversation();
    const reviewing = await finishExample(f, session);
    await f.idle(reviewing.reviewerThreadId!, "broken JSON");
    if (condition === "stale dossier") f.repo.note({ taskId: task.id, revision: task.revision, kind: "constraint", text: "Изменились условия", requestId: randomUUID() });
    else await f.harness.behavior.callRpc("cancel", { sessionId: session.id });
    await pollSession(f, session);
    expect(f.repo.session(session.id).status).toBe(condition === "stale dossier" ? "blocked" : "cancelled");
    expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(2);
  });

  it("does not retry a storage failure as if the recorder output were invalid", async () => {
    const { f, task, session } = await conversation();
    const reviewing = await finishExample(f, session);
    f.repo.db.exec("CREATE TRIGGER fail_proposal BEFORE INSERT ON proposals BEGIN SELECT RAISE(ABORT, 'test storage failure'); END");
    await f.idle(reviewing.reviewerThreadId!, extraction(f.repo.transcript(session.id)!));
    expect(f.repo.session(session.id)).toMatchObject({ status: "blocked", extractionRepair: null });
    expect(f.repo.session(session.id).error).toContain("test storage failure");
    expect((await f.detail(task.id)).proposals).toHaveLength(0);
    expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(2);
  });

  it("allows a cited summary to paraphrase Russian facts while preserving approval and reference checks", async () => {
    const { f, task, session } = await conversation();
    const quote = "Повторно проверил документы: нужные значения сохранились, отката нет.";
    await f.idle(session.workerThreadId!, quote);
    await f.harness.behavior.callRpc("finish", { sessionId: session.id });
    const source = f.repo.transcript(session.id)!.messages.find((message) => message.text === quote)!;
    const summary = "По отчёту ассистента, повторная проверка подтвердила сохранность изменений.";
    const draft: Extraction = { rationale: "Обновляем сводку по отчёту ассистента.", facts: [{ kind: "progress", text: `Ассистент сообщил: ${quote}`, citations: [{ messageRef: source.ref, quote }] }],
      changes: { summary: { value: summary, evidenceRefs: ["fact:0"] } }, knowledge: [] };
    await f.idle(f.repo.session(session.id).reviewerThreadId!, draft);
    const pending = f.repo.session(session.id);
    expect(pending.status).toBe("awaiting_approval");
    expect((await f.detail(task.id)).projection.summary).toBeNull();
    await f.harness.behavior.callRpc("accept", { proposalId: pending.proposalId, revision: task.revision });
    expect((await f.detail(task.id)).projection.summary).toBe(summary);
    const revision = f.repo.kernel.getTask(task.id).revision;
    await expect(f.harness.behavior.callRpc("propose", { taskId: task.id, revision, requestId: randomUUID(), draft: { rationale: "Без основания", confidence: 0.8, changes: { summary: { value: summary, evidenceRefs: [] } } } })).rejects.toThrow(/validation failed/);
  });

  it("accepts next-step formatting differences without dropping negation or changing the user's words", () => {
    const quote = "Следующий шаг: Проверить тестовый отчёт завтра";
    const transcript: Transcript = { threadId: "test", capturedAt: "2026-09-09", warnings: [], messages: [{ ref: "message:1", role: "user", sequence: 1, text: quote }] };
    const draft: Extraction = { rationale: "Instruction", facts: [{ kind: "explicit_next_step", text: "Проверить тестовый отчёт завтра.", citations: [{ messageRef: "message:1", quote }] }], changes: null, knowledge: [] };
    expect(validateExtraction(draft, transcript).facts).toHaveLength(1);
    transcript.messages[0].text = "Не отправлять письмо.";
    draft.facts[0].text = "Отправлять письмо.";
    draft.facts[0].citations[0].quote = "Не отправлять письмо.";
    expect(() => validateExtraction(draft, transcript)).toThrow(/user's words/);
  });

  it("allows a proposed observation to preserve attribution and uncertainty around an exact quote", () => {
    const quote = "Возможно, дело в статусе.";
    const transcript: Transcript = { threadId: "test", capturedAt: "2026-09-09", warnings: [], messages: [{ ref: "message:1", role: "assistant", sequence: 1, text: quote }] };
    const draft: Extraction = { rationale: "Гипотеза для дальнейшего обсуждения", facts: [{ kind: "open_question", text: "Ассистент предположил проблему со статусом; пользователь ещё не подтвердил эту причину.", citations: [{ messageRef: "message:1", quote }] }], changes: null, knowledge: [] };
    expect(validateExtraction(draft, transcript)).toEqual(draft);
  });

  it("saves completion, facts and knowledge as one approved revision, and can reverse completion", async () => {
    const { f, task, session } = await conversation();
    const step = f.repo.note({ taskId: task.id, revision: task.revision, kind: "explicit_next_step", text: nextStep, requestId: randomUUID() });
    const initial = f.repo.propose({ taskId: task.id, revision: task.revision + 1, requestId: randomUUID(), draft: { rationale: "Принятый следующий шаг", confidence: 1, changes: { nextStep: { value: step.text, evidenceRefs: [step.id] } } } }, "test");
    f.repo.accept(initial.id, task.revision + 1);
    const before = await f.detail(task.id);
    f.message(session.workerThreadId!, "user", rule);
    await f.idle(session.workerThreadId!, completionReport);
    await f.harness.behavior.callRpc("finish", { sessionId: session.id });
    const transcript = f.repo.transcript(session.id)!;
    const report = transcript.messages.find((m) => m.text === completionReport)!;
    const meaning = transcript.messages.find((m) => m.text === rule)!;
    const draft: Extraction = { rationale: "Предлагается сохранить результат перепроверки и завершить задачу.", facts: [
      { kind: "progress", text: `Ассистент сообщил: ${completionReport}`, citations: [{ messageRef: report.ref, quote: completionReport }] },
      { kind: "description", text: rule, citations: [{ messageRef: meaning.ref, quote: rule }] },
    ], changes: { status: { value: "done", evidenceRefs: ["fact:0"] }, nextStep: { value: null, evidenceRefs: ["fact:0"] } }, knowledge: [{ title: "Значение invoice booked", body: rule, tags: [], evidenceRefs: ["fact:1"] }] };
    await f.idle(f.repo.session(session.id).reviewerThreadId!, draft);
    const pending = f.repo.session(session.id);
    expect(pending.status).toBe("awaiting_approval");
    expect(f.threads.get(session.workerThreadId!)?.archivedAt).toBeNull();
    expect(f.repo.kernel.getTask(task.id)).toEqual(before.task);
    await expect(Promise.resolve().then(() => f.repo.kernel.applyProposal(pending.proposalId!))).rejects.toThrow(/approved/);
    f.repo.db.exec("CREATE TRIGGER fail_completion_knowledge BEFORE INSERT ON knowledge_entries BEGIN SELECT RAISE(ABORT, 'test failure'); END");
    await expect(f.harness.behavior.callRpc("accept", { proposalId: pending.proposalId, revision: before.task.revision })).rejects.toThrow("test failure");
    expect((await f.detail(task.id)).task).toEqual(before.task);
    expect((await f.detail(task.id)).facts).toEqual(before.facts);
    expect((await f.detail(task.id)).projection.nextStep).toBe(nextStep);
    expect(f.repo.kernel.getProposal(pending.proposalId!).status).toBe("pending");
    expect(f.threads.get(session.workerThreadId!)?.archivedAt).toBeNull();
    f.repo.db.exec("DROP TRIGGER fail_completion_knowledge");
    await f.harness.behavior.callRpc("accept", { proposalId: pending.proposalId, revision: before.task.revision });
    await f.harness.behavior.callRpc("accept", { proposalId: pending.proposalId, revision: before.task.revision });
    const closed = await f.detail(task.id);
    expect(closed.task).toMatchObject({ status: "done", revision: before.task.revision + 1 });
    expect(f.threads.get(session.workerThreadId!)?.archivedAt).not.toBeNull();
    expect(f.harness.inspection.sdk.callsTo("threads.archive").filter(([args]) => (args as { threadId: string }).threadId === session.workerThreadId)).toHaveLength(1);
    expect(closed.projection.nextStep).toBeNull();
    expect(closed.facts).toHaveLength(before.facts.length + 2);
    expect(f.repo.knowledge().total).toBe(1);
    expect(f.repo.list().tasks).toHaveLength(0);
    expect(f.repo.kernel.getApplicationReceipt(pending.proposalId!).fields).toEqual(["status", "nextStep"]);
    const reverse = f.repo.kernel.proposeRevert(pending.proposalId!);
    expect(reverse.changes.status?.value).toBe("open");
    expect(f.repo.kernel.getTask(task.id).status).toBe("done");
    await f.harness.behavior.callRpc("accept", { proposalId: reverse.id, revision: closed.task.revision });
    const reopened = await f.detail(task.id);
    expect(reopened.task).toMatchObject({ status: "open", revision: closed.task.revision + 1 });
    expect(reopened.projection.nextStep).toBe(nextStep);
    expect(reopened.facts).toEqual(closed.facts);
    expect(f.repo.knowledge().total).toBe(1);
  });

  it.each(["done", "archived"] as const)("archives every associated session and recorder round when a task is manually set to %s", async (status) => {
    const { f, task, session } = await conversation("codex", { maximumRepairs: 0 });
    const reviewing = await finishExample(f, session);
    await f.idle(reviewing.reviewerThreadId!, "Invalid extraction");
    const retried = sessionSchema.parse(await f.harness.behavior.callRpc("retry", { sessionId: session.id }));
    await f.idle(retried.reviewerThreadId!, extraction(f.repo.transcript(session.id)!));
    await f.harness.behavior.callRpc("reject", { proposalId: f.repo.session(session.id).proposalId });
    const another = sessionSchema.parse(await f.harness.behavior.callRpc("start", { ...f.startInput(task.id, task.revision), criteria: [] }));
    await f.harness.behavior.callRpc("finish", { sessionId: another.id });
    await f.idle(f.repo.session(another.id).reviewerThreadId!, { rationale: "Нет новых данных.", facts: [], changes: null, knowledge: [] });
    const otherTask = await f.create("Другая задача");
    const otherSession = sessionSchema.parse(await f.harness.behavior.callRpc("start", { ...f.startInput(otherTask.id, otherTask.revision), criteria: [] }));
    const source = f.repo.transcript(session.id);
    await f.harness.behavior.callRpc("status", { taskId: task.id, revision: task.revision, status });
    for (const id of [session.id, another.id]) for (const thread of f.repo.threadIds(id)) expect(f.threads.get(thread.threadId)?.archivedAt).not.toBeNull();
    expect(f.threads.get(otherSession.workerThreadId!)?.archivedAt).toBeNull();
    expect(f.repo.transcript(session.id)).toEqual(source);
    expect(f.repo.pendingThreadArchives()).toEqual([]);
  });

  it("retries failed archival after reload without repeating the task update or later overriding manual unarchive", async () => {
    const { f, task, session } = await conversation();
    await f.harness.behavior.callRpc("cancel", { sessionId: session.id });
    f.harness.inspection.sdk.stub("threads.archive", () => { throw new Error("Temporary BB failure"); });
    await f.harness.behavior.callRpc("status", { taskId: task.id, revision: task.revision, status: "done" });
    expect(f.repo.kernel.getTask(task.id)).toMatchObject({ status: "done", revision: task.revision + 1 });
    expect(f.threads.get(session.workerThreadId!)?.archivedAt).toBeNull();
    expect(f.repo.pendingThreadArchives()).toEqual([]); // Retry is deferred, not a busy loop.
    const future = Date.now() + 31000;
    vi.spyOn(Date, "now").mockReturnValue(future);
    await f.reload();
    f.harness.inspection.sdk.stub("threads.archive", ({ threadId }) => { const thread = f.threads.get(threadId)!; f.threads.set(threadId, { ...thread, archivedAt: Date.now() }); return {}; });
    const runtime = new SessionRuntime(f.bb, f.repo, async () => ({ codexReviewer: "", claudeReviewer: "", maximumRepairs: 2, sessionMinutes: 20 }));
    await runtime.archiveFinishedThreads();
    expect(f.threads.get(session.workerThreadId!)?.archivedAt).toBe(future);
    expect(f.repo.kernel.getTask(task.id).revision).toBe(task.revision + 1);
    expect(f.repo.pendingThreadArchives()).toEqual([]);
    const thread = f.threads.get(session.workerThreadId!)!;
    f.threads.set(thread.id, { ...thread, archivedAt: null });
    await runtime.archiveFinishedThreads();
    expect(f.threads.get(thread.id)?.archivedAt).toBeNull();
  });

  it("recovers previously closed tasks but skips archival if a task was reopened while BB was responding", async () => {
    const { f, task, session } = await conversation();
    await f.harness.behavior.callRpc("cancel", { sessionId: session.id });
    const closed = f.repo.status(task.id, "done", task.revision);
    await f.reload();
    let release!: () => void; let entered!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const reading = new Promise<void>((resolve) => { entered = resolve; });
    f.harness.inspection.sdk.stub("threads.get", async ({ threadId }) => { entered(); await waiting; return f.threads.get(threadId)!; });
    const runtime = new SessionRuntime(f.bb, f.repo, async () => ({ codexReviewer: "", claudeReviewer: "", maximumRepairs: 2, sessionMinutes: 20 }));
    const cleanup = runtime.archiveFinishedThreads();
    await reading;
    const reopened = f.repo.status(task.id, "open", closed.revision);
    release(); await cleanup;
    expect(f.threads.get(session.workerThreadId!)?.archivedAt).toBeNull();
    f.repo.status(task.id, "done", reopened.revision);
    await runtime.archiveFinishedThreads();
    expect(f.threads.get(session.workerThreadId!)?.archivedAt).not.toBeNull();
  });

  it("archives previously accepted sessions on an open task while preserving a new conversation and manual unarchive", async () => {
    const { f, task, session } = await conversation();
    const reviewing = await finishExample(f, session);
    await f.idle(reviewing.reviewerThreadId!, extraction(f.repo.transcript(session.id)!));
    // Emulate an accepted session left visible by an older plugin version.
    f.repo.accept(f.repo.session(session.id).proposalId!, task.revision);
    const accepted = await f.detail(task.id);
    const transcript = f.repo.transcript(session.id);
    const next = sessionSchema.parse(await f.harness.behavior.callRpc("start", { ...f.startInput(task.id, accepted.task.revision), criteria: [] }));
    await f.reload();
    const runtime = new SessionRuntime(f.bb, f.repo, async () => ({ codexReviewer: "", claudeReviewer: "", maximumRepairs: 2, sessionMinutes: 20 }));
    await runtime.archiveFinishedThreads();
    expect(f.threads.get(session.workerThreadId!)?.archivedAt).not.toBeNull();
    expect(f.threads.get(next.workerThreadId!)?.archivedAt).toBeNull();
    expect(f.repo.session(next.id).status).toBe("working");
    expect((await f.detail(task.id)).task).toEqual(accepted.task);
    expect(accepted.task.status).toBe("open");
    expect(f.repo.transcript(session.id)).toEqual(transcript);
    expect(f.repo.pendingThreadArchives()).toEqual([]);
    // A later task edit/reload must not hide a manually reopened old thread.
    const thread = f.threads.get(session.workerThreadId!)!;
    f.threads.set(thread.id, { ...thread, archivedAt: null });
    f.repo.note({ taskId: task.id, revision: accepted.task.revision, kind: "progress", text: "Ответ ещё не получен", requestId: randomUUID() });
    await f.reload();
    const reloaded = new SessionRuntime(f.bb, f.repo, async () => ({ codexReviewer: "", claudeReviewer: "", maximumRepairs: 2, sessionMinutes: 20 }));
    await reloaded.archiveFinishedThreads();
    expect(f.threads.get(thread.id)?.archivedAt).toBeNull();
  });

  it("retries archival after accepted results without failing the approval or closing the task", async () => {
    const { f, task, session } = await conversation();
    const reviewing = await finishExample(f, session);
    await f.idle(reviewing.reviewerThreadId!, extraction(f.repo.transcript(session.id)!));
    const proposalId = f.repo.session(session.id).proposalId!;
    f.harness.inspection.sdk.stub("threads.archive", () => { throw new Error("Temporary BB failure"); });
    await f.harness.behavior.callRpc("accept", { proposalId, revision: task.revision });
    const accepted = await f.detail(task.id);
    expect(accepted.task).toMatchObject({ status: "open", revision: task.revision + 1 });
    expect(f.repo.session(session.id).status).toBe("applied");
    expect(f.threads.get(session.workerThreadId!)?.archivedAt).toBeNull();
    expect(f.repo.pendingThreadArchives()).toEqual([]);
    const future = Date.now() + 31000;
    vi.spyOn(Date, "now").mockReturnValue(future);
    await f.reload();
    f.harness.inspection.sdk.stub("threads.archive", ({ threadId }) => { const thread = f.threads.get(threadId)!; f.threads.set(threadId, { ...thread, archivedAt: Date.now() }); return {}; });
    const runtime = new SessionRuntime(f.bb, f.repo, async () => ({ codexReviewer: "", claudeReviewer: "", maximumRepairs: 2, sessionMinutes: 20 }));
    await runtime.archiveFinishedThreads();
    expect(f.threads.get(session.workerThreadId!)?.archivedAt).toBe(future);
    expect((await f.detail(task.id)).task).toEqual(accepted.task);
    expect((await f.detail(task.id)).facts).toEqual(accepted.facts);
    expect((await f.detail(task.id)).projection).toEqual(accepted.projection);
  });

  it.each(["reject", "stale", "another session"])("does not close the task on %s", async (condition) => {
    const { f, task, session } = await conversation();
    const pending = await completedExample(f, session);
    expect(pending.status).toBe("awaiting_approval");
    if (condition === "reject") await f.harness.behavior.callRpc("reject", { proposalId: pending.proposalId });
    if (condition === "stale") f.repo.note({ taskId: task.id, revision: task.revision, kind: "blocker", text: "Появилась новая обязательная проверка.", requestId: randomUUID() });
    if (condition === "another session") await f.harness.behavior.callRpc("start", { ...f.startInput(task.id, task.revision), criteria: [] });
    const current = f.repo.kernel.getTask(task.id);
    await expect(f.harness.behavior.callRpc("accept", { proposalId: pending.proposalId, revision: current.revision })).rejects.toThrow();
    expect(f.repo.kernel.getTask(task.id)).toEqual(current);
    expect(current.status).toBe("open");
    const runtime = new SessionRuntime(f.bb, f.repo, async () => ({ codexReviewer: "", claudeReviewer: "", maximumRepairs: 2, sessionMinutes: 20 }));
    await runtime.archiveFinishedThreads();
    expect(f.threads.get(session.workerThreadId!)?.archivedAt).toBeNull();
  });

  it.each(["context only", "unknown completion fact", "reopening"])("rejects completion extraction with %s", (condition) => {
    const transcript: Transcript = { threadId: "test", capturedAt: "2026-09-09", warnings: [], messages: [{ ref: "message:1", role: condition === "context only" ? "context" : "assistant", sequence: 1, text: completionReport }] };
    const draft: Extraction = { rationale: "Завершение", facts: [{ kind: "progress", text: completionReport, citations: [{ messageRef: "message:1", quote: completionReport }] }], changes: { status: { value: condition === "reopening" ? "open" : "done", evidenceRefs: [condition === "unknown completion fact" ? "fact:99" : "fact:0"] } }, knowledge: [] };
    expect(() => validateExtraction(draft, transcript)).toThrow();
  });

  it("applies dossier facts and searchable knowledge atomically after approval, once", async () => {
    const { f, task, session } = await conversation();
    const before = await f.detail(task.id);
    const reviewing = await finishExample(f, session);
    const draft = extraction(f.repo.transcript(session.id)!);
    await f.idle(reviewing.reviewerThreadId!, draft);
    const pending = f.repo.session(session.id);
    expect(pending.status).toBe("awaiting_approval");
    expect((await f.detail(task.id)).task).toEqual(before.task);
    expect((await f.detail(task.id)).facts).toEqual(before.facts);
    expect(f.repo.knowledge().total).toBe(0);
    expect((await f.detail(task.id)).sessionUpdates[0].extraction).toEqual(draft);
    expect(f.threads.get(session.workerThreadId!)?.archivedAt).toBeNull();
    const approval = { proposalId: pending.proposalId, revision: task.revision };
    f.repo.db.exec("CREATE TRIGGER fail_knowledge BEFORE INSERT ON knowledge_entries BEGIN SELECT RAISE(ABORT, 'test failure'); END");
    await expect(f.harness.behavior.callRpc("accept", approval)).rejects.toThrow("test failure");
    expect((await f.detail(task.id)).task.revision).toBe(task.revision);
    expect((await f.detail(task.id)).facts).toEqual(before.facts);
    expect((await f.detail(task.id)).projection.summary).toBeNull();
    expect(f.threads.get(session.workerThreadId!)?.archivedAt).toBeNull();
    f.repo.db.exec("DROP TRIGGER fail_knowledge");
    await f.harness.behavior.callRpc("accept", approval);
    await f.harness.behavior.callRpc("accept", approval);
    const accepted = await f.detail(task.id);
    expect(accepted.task.status).toBe("open");
    expect(f.threads.get(session.workerThreadId!)?.archivedAt).not.toBeNull();
    expect(f.harness.inspection.sdk.callsTo("threads.archive").filter(([args]) => (args as { threadId: string }).threadId === session.workerThreadId)).toHaveLength(1);
    expect(accepted.task.revision).toBe(task.revision + 1);
    expect(accepted.projection.summary).toBe(progress);
    expect(accepted.projection.nextStep).toBe(nextStep);
    expect(accepted.facts).toHaveLength(before.facts.length + 3);
    expect(accepted.proposals[0].receipt?.afterRevision).toBe(accepted.task.revision);
    expect(f.repo.knowledge("СЧЁТ").entries[0]).toMatchObject({ title: "Значение invoice booked", taskId: task.id, threadId: session.workerThreadId });
    expect(f.repo.knowledge().total).toBe(1);
  });

  it.each(["invented quote", "assistant instruction", "unknown reference"])("blocks %s without saving knowledge", async (failure) => {
    const { f, session } = await conversation("codex", { maximumRepairs: 0 });
    const reviewing = await finishExample(f, session);
    const transcript = f.repo.transcript(session.id)!;
    const draft = extraction(transcript);
    if (failure === "invented quote") draft.facts[0].citations[0].quote = "Этого никогда не говорили";
    if (failure === "assistant instruction") {
      const assistant = transcript.messages.find((m) => m.role === "assistant")!;
      draft.facts[1] = { kind: "explicit_next_step", text: assistant.text, citations: [{ messageRef: assistant.ref, quote: assistant.text }] };
    }
    if (failure === "unknown reference") draft.knowledge[0].evidenceRefs = ["fact:99"];
    await f.idle(reviewing.reviewerThreadId!, draft);
    expect(f.repo.session(session.id).status).toBe("blocked");
    expect(f.repo.knowledge().total).toBe(0);
    expect(f.harness.inspection.sdk.callsTo("threads.stop").flat()).toContainEqual({ threadId: reviewing.reviewerThreadId });
  });

  it("retries a stale draft using the full frozen dialogue and the latest dossier", async () => {
    const { f, task, session } = await conversation();
    const reviewing = await finishExample(f, session);
    const snapshot = f.repo.transcript(session.id)!;
    await f.idle(reviewing.reviewerThreadId!, extraction(snapshot));
    const proposal = f.repo.session(session.id).proposalId!;
    f.repo.note({ taskId: task.id, revision: task.revision, requestId: randomUUID(), kind: "progress", text: "Досье обновлено после разбора." });
    const retried = sessionSchema.parse(await f.harness.behavior.callRpc("retry", { sessionId: session.id }));
    expect(retried.status).toBe("reviewing");
    expect(retried.baseRevision).toBe(task.revision + 1);
    expect(retried.reviewerThreadId).not.toBe(reviewing.reviewerThreadId);
    expect(f.repo.kernel.getProposal(proposal).status).toBe("rejected");
    expect(f.repo.transcript(session.id)).toEqual(snapshot);
    expect(f.harness.inspection.sdk.callsTo("threads.timeline")).toHaveLength(1);
    const lastSpawn = f.harness.inspection.sdk.callsTo("threads.spawn").at(-1);
    expect(JSON.stringify(lastSpawn)).toContain("Досье обновлено после разбора.");
    await f.idle(retried.reviewerThreadId!, extraction(snapshot));
    expect(f.repo.session(session.id).status).toBe("awaiting_approval");
  });

  it("does not restart a cancelled conversation when transcript reading finishes late", async () => {
    const { f, session } = await conversation();
    let release!: () => void; let entered!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const reading = new Promise<void>((resolve) => { entered = resolve; });
    f.harness.inspection.sdk.stub("threads.timeline", async () => { entered(); await waiting; return { rows: f.conversations.get(session.workerThreadId!), timelinePage: { hasOlderRows: false, olderCursor: null } }; });
    const finishing = f.harness.behavior.callRpc("finish", { sessionId: session.id });
    await reading;
    await f.harness.behavior.callRpc("cancel", { sessionId: session.id });
    release(); await finishing;
    expect(f.repo.session(session.id).status).toBe("cancelled");
    expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
  });

  it("keeps an open conversation across plugin reload, and permits a no-change result", async () => {
    const { f, session } = await conversation();
    await f.reload();
    const repo = f.repo;
    expect(repo.session(session.id).status).toBe("working");
    expect(f.harness.inspection.sdk.callsTo("threads.stop")).toHaveLength(0);
    await f.harness.behavior.callRpc("finish", { sessionId: session.id });
    const reviewing = repo.session(session.id);
    await f.idle(reviewing.reviewerThreadId!, { rationale: "Новых сведений нет.", facts: [], changes: null, knowledge: [] });
    expect(repo.session(session.id).status).toBe("completed");
    expect(repo.kernel.getTask(session.taskId).status).toBe("open");
    expect(repo.knowledge().total).toBe(0);
  });
});

it.each([
  ["Russian", "Проверь отчёт завтра."],
  ["Spanish", "Revisa el informe mañana."],
  ["Greek", "Έλεγξε την αναφορά αύριο."],
  ["Arabic", "راجع التقرير غدًا."],
  ["Chinese", "请明天检查报告。"],
  ["Japanese", "明日レポートを確認してください。"],
  ["mixed language", "Проверь invoice 明天 — mañana, пожалуйста."],
])("preserves %s conversation text, verbatim evidence and accepted task content", async (_language, instruction) => {
  const { f, task, session } = await conversation();
  f.message(session.workerThreadId!, "user", instruction);
  await f.idle(session.workerThreadId!, instruction);
  await f.harness.behavior.callRpc("finish", { sessionId: session.id });
  const saved = f.repo.transcript(session.id)!;
  const source = saved.messages.find(m => m.role === "user" && m.text === instruction)!;
  expect(source.text).toBe(instruction);
  const draft: Extraction = { rationale: instruction,
    facts: [{ kind: "explicit_next_step", text: instruction, citations: [{ messageRef: source.ref, quote: instruction }] }],
    changes: { nextStep: { value: instruction, evidenceRefs: ["fact:0"] } }, knowledge: [] };
  await f.idle(f.repo.session(session.id).reviewerThreadId!, draft);
  const pending = f.repo.session(session.id);
  expect(pending.status).toBe("awaiting_approval");
  await f.harness.behavior.callRpc("accept", { proposalId: pending.proposalId, revision: task.revision });
  const dossier = await f.detail(task.id);
  expect(dossier.projection.nextStep).toBe(instruction);
  expect(f.repo.transcript(session.id)!.messages.find(m => m.ref === source.ref)?.text).toBe(instruction);
  expect(dossier.facts.some(fact => fact.text === instruction)).toBe(true);
});

it.each(["worker", "исполнитель"])("recovers an unbound %s launch without creating another worker", async (role) => {
  const { f, session } = await conversation();
  const threadId = session.workerThreadId!;
  f.threads.set(threadId, { ...f.threads.get(threadId)!, title: `247C · ${role} · ${session.id}` });
  f.repo.saveSession({ ...session, status: "starting", workerThreadId: null });
  const threadCount = f.threads.size;
  await f.reload();
  await f.idle(threadId, "Continue with the existing conversation.");
  expect(f.repo.session(session.id).workerThreadId).toBe(threadId);
  expect(f.repo.session(session.id).status).toBe("working");
  expect(f.threads.size).toBe(threadCount);
  expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
});
