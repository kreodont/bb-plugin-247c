import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { makePluginAgentConfigurationContext, experimental_scanPublicSdkOnly } from "@get-bb/plugin-sdk/testing";
import { fixture } from "./test-support.js";
import { proposalSchema, factSchema, sessionSchema } from "./contracts.js";

const hosts: Awaited<ReturnType<typeof fixture>>[] = [];
async function setup() { const f = await fixture(); hosts.push(f); return f; }
afterEach(async () => { for (const f of hosts.splice(0)) await f.harness.lifecycle.dispose(); });

it.each(["C:/work", String.raw`\\server\share\work`])("reads verification artifacts from a Windows host at %s", async root => {
  const f = await setup();
  f.harness.inspection.sdk.stub("environments.get", () => ({ id: "env_test", path: root, hostId: "host_windows" }));
  f.harness.inspection.sdk.stub("files.read", () => ({ content: "Ready", contentEncoding: "utf8", sizeBytes: 5, sha256: "a".repeat(64) }));
  const task = await f.create(), session = await f.start(task.id, task.revision);
  await f.idle(session.workerThreadId!, { summary: "Ready", artifacts: [{ path: String.raw`docs\report.md`, label: "Report" }] });
  expect(f.repo.session(session.id)).toMatchObject({ status: "reviewing", hostId: "host_windows", error: null });
  expect(f.harness.inspection.sdk.callsTo("files.read")[0][0]).toEqual({ hostId: "host_windows", rootPath: root, path: root.replace(/\//g, "\\") + String.raw`\docs\report.md` });
});

describe("Dossier kernel behind BB RPC", () => {
  it("records exactly one task per request, and rejects reusing that request for another title", async () => {
    const f = await setup();
    const input = { title: "План", description: "Context", requestId: randomUUID() };
    const first = await f.harness.behavior.callRpc("create", input);
    expect(await f.harness.behavior.callRpc("create", input)).toEqual(first);
    expect(f.repo.list().total).toBe(1);
    await expect(f.harness.behavior.callRpc("create", { ...input, title: "Другая задача" })).rejects.toThrow(/different data/);
  });
  it("does not apply a proposal until approval, applies once, and reverses through a new proposal", async () => {
    const f = await setup(); const task = await f.create();
    const before = await f.detail(task.id);
    const proposal = proposalSchema.parse(await f.harness.behavior.callRpc("propose", { taskId: task.id, revision: task.revision, requestId: randomUUID(), draft: { rationale: "Сводка из контекста", confidence: 1, changes: { summary: { value: before.facts[0].text, evidenceRefs: [before.facts[0].id] } } } }));
    expect((await f.detail(task.id)).projection.summary).toBeNull();
    expect((await f.detail(task.id)).task.revision).toBe(task.revision);
    await f.harness.behavior.callRpc("accept", { proposalId: proposal.id, revision: task.revision });
    await f.harness.behavior.callRpc("accept", { proposalId: proposal.id, revision: task.revision });
    const applied = await f.detail(task.id);
    expect(applied.task.revision).toBe(task.revision + 1);
    expect(applied.projection.summary).toBe(before.facts[0].text);
    expect(applied.proposals[0].receipt?.afterRevision).toBe(task.revision + 1);
    const reverse = proposalSchema.parse(await f.harness.behavior.callRpc("revert", { proposalId: proposal.id }));
    expect((await f.detail(task.id)).projection.summary).toBe(before.facts[0].text);
    await f.harness.behavior.callRpc("accept", { proposalId: reverse.id, revision: applied.task.revision });
    expect((await f.detail(task.id)).projection.summary).toBeNull();
    expect((await f.detail(task.id)).facts).toEqual(before.facts);
  });
  it("refuses invented next steps, unknown evidence, and stale proposals without persisting an approval", async () => {
    const f = await setup(); const task = await f.create(); const before = await f.detail(task.id);
    await expect(f.harness.behavior.callRpc("propose", { taskId: task.id, revision: task.revision, requestId: randomUUID(), draft: { rationale: "Next", confidence: 1, changes: { nextStep: { value: "Отправить письмо", evidenceRefs: [before.facts[0].id] } } } })).rejects.toThrow(/explicit/);
    await expect(f.harness.behavior.callRpc("propose", { taskId: task.id, revision: task.revision, requestId: randomUUID(), draft: { rationale: "Summary", confidence: 1, changes: { summary: { value: "Context", evidenceRefs: ["invented"] } } } })).rejects.toThrow(/unknown/);
    const proposal = f.repo.propose({ taskId: task.id, revision: task.revision, requestId: randomUUID(), draft: { rationale: "Summary", confidence: 1, changes: { summary: { value: before.facts[0].text, evidenceRefs: [before.facts[0].id] } } } }, "test");
    await f.harness.behavior.callRpc("note", { taskId: task.id, revision: task.revision, kind: "constraint", text: "Новая вводная", requestId: randomUUID() });
    const updated = await f.detail(task.id);
    await expect(f.harness.behavior.callRpc("accept", { proposalId: proposal.id, revision: updated.task.revision })).rejects.toThrow(/old dossier revision/);
    expect((await f.detail(task.id)).proposals[0].status).toBe("pending");
    expect(f.repo.db.prepare("SELECT count(*) n FROM proposal_approvals").get()).toEqual({ n: 0 });
    expect((await f.detail(task.id)).projection.summary).toBeNull();
  });
  it("keeps planning CAS, invalidates old dossier proposals, and preserves an explicit unknown priority", async () => {
    const f = await setup(); const task = await f.create();
    await f.harness.behavior.callRpc("classify", { taskId: task.id, revision: 0, urgent: true, important: null });
    const after = await f.detail(task.id);
    expect(after.task.revision).toBe(task.revision + 1);
    expect(after.planning).toEqual({ urgent: true, important: null, revision: 1 });
    await expect(f.harness.behavior.callRpc("classify", { taskId: task.id, revision: 0, urgent: false, important: true })).rejects.toThrow(/another window/);
    await f.harness.behavior.callRpc("status", { taskId: task.id, revision: after.task.revision, status: "archived" });
    expect(f.repo.list().total).toBe(0);
    expect(f.repo.list(true).total).toBe(1);
  });
  it("retries note writes idempotently but rejects unrelated edits at an old revision", async () => {
    const f = await setup(); const task = await f.create();
    const input = { taskId: task.id, revision: task.revision, kind: "explicit_next_step", text: "Подготовить план", requestId: randomUUID() };
    const note = factSchema.parse(await f.harness.behavior.callRpc("note", input));
    expect(await f.harness.behavior.callRpc("note", input)).toEqual(note);
    await expect(f.harness.behavior.callRpc("note", { ...input, requestId: randomUUID() })).rejects.toThrow(/The dossier changed/);
  });
});

describe("Bounded work and independent review", () => {
  it("runs a corporate Claude worker with an independent Codex reviewer", async () => {
    const f = await setup(); const task = await f.create();
    const input = f.startInput(task.id, task.revision);
    input.request.providerId = "claude-work";
    input.request.model = "claude-fable-5-1";
    const started = sessionSchema.parse(await f.harness.behavior.callRpc("start", input));
    expect(started.workerProvider).toBe("claude-work");
    expect(started.reviewerProvider).toBe("codex");
    expect(f.harness.inspection.sdk.callsTo("threads.spawn")[0][0]).toMatchObject({ providerId: "claude-work" });
    await f.idle(started.workerThreadId!, { summary: "План готов", artifacts: [] });
    expect(f.repo.session(started.id).status).toBe("reviewing");
    expect(f.harness.inspection.sdk.callsTo("threads.spawn")[1][0]).toMatchObject({ providerId: "codex" });
  });
  it("runs the worker and a fresh cross-family reviewer, then waits for human approval", async () => {
    const f = await setup(); const task = await f.create(); const before = await f.detail(task.id);
    const input = f.startInput(task.id, task.revision);
    const started = sessionSchema.parse(await f.harness.behavior.callRpc("start", input));
    expect((await f.harness.behavior.callRpc("start", input))).toEqual(started);
    expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
    f.files.set("/work/plan.md", "1. Собрать вводные\n2. Подготовить план\n3. Проверить результат");
    await f.idle(started.workerThreadId!, { summary: "Три этапа: собрать вводные, подготовить план, проверить результат.", artifacts: [{ path: "plan.md", label: "План" }] });
    const reviewing = f.repo.session(started.id);
    expect(reviewing.status).toBe("reviewing");
    expect(reviewing.artifacts[0].text).toContain("3. Проверить");
    const spawn = f.harness.inspection.sdk.callsTo("threads.spawn")[1][0] as Record<string, unknown>;
    expect(spawn).toMatchObject({ providerId: "claude-code", model: "claude-fable-5-1", visibility: "hidden", executionInputSources: { providerId: "explicit", model: "explicit", reasoningLevel: "explicit", permissionMode: "explicit" }, environment: { type: "host", hostId: "host_test", workspace: { type: "personal" } } });
    expect(spawn).not.toHaveProperty("parentThreadId");
    await f.idle(reviewing.reviewerThreadId!, f.pass(reviewing));
    const pending = f.repo.session(started.id);
    expect(pending.status).toBe("awaiting_approval");
    expect((await f.detail(task.id)).task).toEqual(before.task);
    expect((await f.detail(task.id)).facts).toEqual(before.facts);
    expect((await f.detail(task.id)).projection).toEqual(before.projection);
    expect(f.harness.inspection.sdk.callsTo("threads.stop").flat()).toContainEqual({ threadId: reviewing.reviewerThreadId });
    await f.harness.behavior.callRpc("accept", { proposalId: pending.proposalId, revision: task.revision });
    expect(f.repo.session(started.id).status).toBe("applied");
    expect((await f.detail(task.id)).projection.artifacts[0].uri).toBe("file:///work/plan.md");
  });
  it("waits for BB to provision the workspace instead of blocking a new worker", async () => {
    const f = await setup(); const task = await f.create();
    f.harness.inspection.sdk.stub("environments.get", () => ({ id: "env_test", path: null, hostId: "host_test", status: "provisioning" }));
    const session = await f.start(task.id, task.revision);
    expect(session.status).toBe("working");
    expect(f.harness.inspection.sdk.callsTo("threads.stop")).toHaveLength(0);
    f.harness.inspection.sdk.stub("environments.get", () => ({ id: "env_test", path: "/work", hostId: "host_test", status: "ready" }));
    await f.idle(session.workerThreadId!, { summary: "1. Вводные 2. План 3. Проверка", artifacts: [] });
    expect(f.repo.session(session.id).status).toBe("reviewing");
  });
  it("allows an unlisted Claude worker while checking the result verifier separately", async () => {
    const f = await setup(), task = await f.create();
    const input = f.startInput(task.id, task.revision);
    input.request = { ...input.request, providerId: "claude-work", model: "claude-opus-5-5[1m]" };
    const session = sessionSchema.parse(await f.harness.behavior.callRpc("start", input));
    expect(session).toMatchObject({ status: "working", mode: "result", workerModel: "claude-opus-5-5[1m]", reviewerProvider: "codex", reviewerModel: "gpt-5.6-sol" });
    expect(f.harness.inspection.sdk.callsTo("providers.models")).toHaveLength(1);
    expect(f.harness.inspection.sdk.callsTo("providers.models")[0][0]).toMatchObject({ providerId: "codex" });
    expect(f.harness.inspection.sdk.callsTo("threads.spawn")[0][0]).toMatchObject({ providerId: "claude-work", model: "claude-opus-5-5[1m]" });
  });
  it("fails preflight before creating a worker when the review model is unavailable", async () => {
    const f = await setup(); const task = await f.create();
    f.harness.inspection.sdk.stub("providers.models", () => ({ models: [], modelLoadError: null }));
    await expect(f.start(task.id, task.revision)).rejects.toThrow(/unavailable/);
    expect(f.repo.sessions(task.id)).toHaveLength(0);
    expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
  });
  it("blocks changed worker or reviewer models without creating a proposal", async () => {
    const f = await setup(); const task = await f.create();
    let session = await f.start(task.id, task.revision);
    f.models.set(session.workerThreadId!, "other-model");
    await f.idle(session.workerThreadId!, { summary: "1. Вводные 2. План 3. Проверка", artifacts: [] });
    expect(f.repo.session(session.id).error).toMatch(/worker model/);
    session = await f.start(task.id, task.revision);
    await f.idle(session.workerThreadId!, { summary: "1. Вводные 2. План 3. Проверка", artifacts: [] });
    session = f.repo.session(session.id);
    f.models.set(session.reviewerThreadId!, "other-model");
    await f.idle(session.reviewerThreadId!, f.pass(session));
    expect(f.repo.session(session.id).error).toMatch(/verification model/);
    expect((await f.detail(task.id)).proposals).toHaveLength(0);
  });
  it("allows only one owner and never trusts claims about absent files", async () => {
    const f = await setup(); const task = await f.create(); const started = await f.start(task.id, task.revision);
    await expect(f.start(task.id, task.revision)).rejects.toThrow(/already has a worker/);
    await expect(f.harness.behavior.callRpc("status", { taskId: task.id, revision: task.revision, status: "done" })).rejects.toThrow(/Stop/);
    await f.idle(started.workerThreadId!, { summary: "План готов", artifacts: [{ path: "missing.md", label: "План" }] });
    expect(f.repo.session(started.id).status).toBe("blocked");
    expect((await f.detail(task.id)).proposals).toHaveLength(0);
    expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
  });
  it("prevents cross-task tool access and canonical mutation by a session worker", async () => {
    const f = await setup(); const task = await f.create(); const other = await f.create("Другой контекст"); const session = await f.start(task.id, task.revision);
    const ctx = { threadId: session.workerThreadId!, projectId: "proj_personal", signal: new AbortController().signal };
    await expect(f.harness.behavior.callAgentTool("c247_read", { taskId: other.id }, ctx)).rejects.toThrow(/only its own task dossier/);
    await expect(f.harness.behavior.callAgentTool("c247_create", { title: "Новая", description: "", requestId: randomUUID() }, ctx)).rejects.toThrow(/A worker/);
    expect(await f.harness.behavior.callAgentTool("c247_submit_result", { summary: "Результат", artifacts: [] }, ctx)).toContain("canonicalTaskChanged");
    expect((await f.detail(task.id)).projection.summary).toBeNull();
    const config = await f.harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({ origin: { pluginId: "247c", kind: null }, thread: { title: `247C · проверка 0 · ${session.id}` } }));
    expect(config.tools).toHaveLength(0);
  });
  it("blocks stale work and malicious evidence paths before reviewer launch", async () => {
    const f = await setup(); const task = await f.create(); let session = await f.start(task.id, task.revision);
    await f.harness.behavior.callRpc("note", { taskId: task.id, revision: task.revision, kind: "constraint", text: "Изменились условия", requestId: randomUUID() });
    await f.idle(session.workerThreadId!, { summary: "Готово", artifacts: [] });
    expect(f.repo.session(session.id).status).toBe("blocked");
    const current = f.repo.kernel.getTask(task.id);
    session = await f.start(task.id, current.revision);
    await f.idle(session.workerThreadId!, { summary: "Готово", artifacts: [{ path: "../../.ssh/id_rsa", label: "Secret" }] });
    expect(f.repo.session(session.id).error).toMatch(/outside the session workspace/);
    expect(f.harness.inspection.sdk.callsTo("files.read")).toHaveLength(0);
  });
  it("repairs in the same worker at most twice, with a fresh reviewer each round", async () => {
    const f = await setup(); const task = await f.create(); const started = await f.start(task.id, task.revision);
    for (let round = 0; round < 3; round++) {
      await f.idle(started.workerThreadId!, { summary: "Пока только один этап", artifacts: [] });
      const reviewing = f.repo.session(started.id);
      expect(reviewing.round).toBe(round);
      await f.idle(reviewing.reviewerThreadId!, { verdict: "repair", findings: ["Добавить ещё два этапа"], criteria: [{ index: 0, passed: false, reason: "Этап только один", evidenceRefs: ["answer"] }] });
    }
    expect(f.repo.session(started.id).status).toBe("blocked");
    expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(4);
    expect(f.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(2);
    for (const [args] of f.harness.inspection.sdk.callsTo("threads.send")) expect(args).toMatchObject({ threadId: started.workerThreadId });
    expect((await f.detail(task.id)).proposals).toHaveLength(0);
  });
  it("rejects fake pass verdicts and changing artifacts after review", async () => {
    const f = await setup(); const task = await f.create(); let session = await f.start(task.id, task.revision);
    await f.idle(session.workerThreadId!, { summary: "1. Вводные 2. План 3. Проверка", artifacts: [] });
    session = f.repo.session(session.id);
    await f.idle(session.reviewerThreadId!, { verdict: "pass", findings: [], criteria: [{ index: 0, passed: true, reason: "Тесты прошли", evidenceRefs: ["made-up-test"] }] });
    expect(f.repo.session(session.id).status).toBe("blocked");
    session = await f.start(task.id, task.revision);
    f.files.set("/work/plan.md", "1. Вводные 2. План 3. Проверка");
    await f.idle(session.workerThreadId!, { summary: "1. Вводные 2. План 3. Проверка", artifacts: [{ path: "plan.md", label: "План" }] });
    session = f.repo.session(session.id);
    await f.idle(session.reviewerThreadId!, f.pass(session));
    session = f.repo.session(session.id);
    f.files.set("/work/plan.md", "Другой результат");
    await expect(f.harness.behavior.callRpc("accept", { proposalId: session.proposalId, revision: task.revision })).rejects.toThrow(/Files changed/);
    expect((await f.detail(task.id)).projection.summary).toBeNull();
  });
  it("cannot resurrect a cancelled session when a file read completes late", async () => {
    const f = await setup(); const task = await f.create(); const session = await f.start(task.id, task.revision);
    let resolve!: (value: unknown) => void;
    const read = new Promise((r) => { resolve = r; });
    let entered!: () => void;
    const waiting = new Promise<void>((r) => { entered = r; });
    f.harness.inspection.sdk.stub("files.read", async () => { entered(); return read; });
    const finishing = f.idle(session.workerThreadId!, { summary: "Результат", artifacts: [{ path: "plan.md", label: "План" }] });
    await waiting;
    await f.harness.behavior.callRpc("cancel", { sessionId: session.id });
    resolve({ content: "result", contentEncoding: "utf8", sha256: "hash", sizeBytes: 6 });
    await finishing;
    expect(f.repo.session(session.id).status).toBe("cancelled");
    expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
    expect((await f.detail(task.id)).proposals).toHaveLength(0);
  });
  it("releases runtimes when a session times out", async () => {
    const f = await setup(); const task = await f.create(); const session = await f.start(task.id, task.revision);
    f.repo.saveSession({ ...session, deadlineAt: Date.now() - 1 });
    await f.idle(session.workerThreadId!, { summary: "Готово", artifacts: [] });
    expect(f.repo.session(session.id).error).toMatch(/timed out/);
    expect(f.harness.inspection.sdk.callsTo("threads.stop").flat()).toContainEqual({ threadId: session.workerThreadId });
  });
});

it("uses only public BB APIs", async () => {
  const result = await experimental_scanPublicSdkOnly(import.meta.dirname, { allow: [/^@modelcontextprotocol\/sdk\//, /^@get-bb\/plugin-sdk\/testing$/, /^@hugeicons\//, /^@radix-ui\//, /^@testing-library\//, /^vitest$/, /^react(?:-dom)?(?:\/|$)/, /^sonner$/, /^better-sqlite3$/, /^class-variance-authority$/, /^clsx$/, /^tailwind-merge$/, /^cron-parser$/, /^monaco-editor(?:\/|$)/, /^esbuild$/] });
  result.violations = result.violations.map(item => ({ ...item, file: item.file.replace(/\\/g, "/") }));
  // The only computed import loads our shipped Monaco bundle through a BB preview lease.
  const assetImport = { file: "file-editor/lib/monaco-loader.ts", reason: "dynamic-specifier", specifier: "/* @vite-ignore */ `${baseUrl}/editor.js`" };
  expect(result.violations.filter(item => !(item.file === assetImport.file && item.reason === assetImport.reason && item.specifier === assetImport.specifier))).toEqual([]);
  expect(result.violations.filter(item => item.reason === "dynamic-specifier")).toEqual([assetImport]);
  expect(result.privateDependencies).toEqual([]);
});

it("uses local planning configuration in RPC output and keeps it across reload", async () => {
  const f = await setup();
  await f.harness.behavior.setSettings({ timeZone: "America/Los_Angeles", updateStartHour: 9, updateEndHour: 18 });
  expect(await f.harness.behavior.callRpc("day", {})).toMatchObject({ timeZone: "America/Los_Angeles" });
  expect(await f.harness.behavior.callRpc("threadProject", {})).toMatchObject({ timeZone: "America/Los_Angeles" });
  await f.reload();
  expect(await f.harness.behavior.callRpc("day", {})).toMatchObject({ timeZone: "America/Los_Angeles" });
});
