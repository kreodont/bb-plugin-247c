import { afterEach, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixture } from "./test-support.js";
import { SourceSyncStore } from "./source-sync.js";
import { importedSourceCalls, sourceImportBundleSchema } from "./source-import.js";
import { scheduledSourceUpdate } from "./source-schedule.js";
import type { SourceSyncRuntime } from "./source-sync.js";

const hosts: Awaited<ReturnType<typeof fixture>>[] = [], folders: string[] = [];
afterEach(async () => {
  for (const f of hosts.splice(0)) await f.harness.lifecycle.dispose();
  for (const path of folders.splice(0)) await rm(path, { recursive: true, force: true });
});

async function setup(taskId: string | null = null) {
  const f = await fixture(); hosts.push(f);
  const root = await mkdtemp(join(tmpdir(), "247c-source-import-")); folders.push(root);
  await f.harness.behavior.setSettings({ sourceImportRoot: root });
  const until = new Date(Date.now() - 3600000).toISOString(), since = new Date(Date.now() - 86400000).toISOString();
  const quote = "Please prepare the release plan. The review is complete.";
  const read = { callId: "receipt-read", at: until, source: "clickup" as const, tool: "clickup_get_task_comments", args: { task_id: "task123" }, result: { content: [{ type: "text", text: JSON.stringify({ comments: [{ id: "comment1", text: quote }] }) }], isError: false } };
  const query = { ...read, callId: "receipt-search", tool: "clickup_filter_tasks", args: { task_id: "task123" }, result: { content: [{ type: "text", text: "[]" }], isError: false } };
  const citation = { callRef: read.callId, source: "clickup" as const, url: "https://app.clickup.com/t/task123", messageId: "comment1", occurredAt: since, quote };
  const step = "Подготовить план релиза.";
  const bundle = sourceImportBundleSchema.parse({ version: 1, provider: "claude-work", model: "test-model", startedAt: until, until,
    windows: { teams: { since }, outlook: { since }, clickup: { since } }, taskRevisions: {}, receipts: [query, read],
    result: { reports: ["teams", "outlook", "clickup"].map(source => ({ source, status: source === "clickup" ? "complete" : "unavailable", detail: "Collector coverage.", callRefs: source === "clickup" ? [query.callId, read.callId] : [], paginationComplete: source === "clickup", linkedTasksChecked: source === "clickup", scanned: source === "clickup" ? 1 : 0, threadsRead: 0 })),
      suggestions: [{ taskId, title: "План релиза", rationale: "Получена просьба подготовить план.", confidence: 0.9,
        facts: [{ kind: "explicit_next_step", text: step, citations: [citation] }],
        changes: { summary: { value: step, evidenceRefs: ["fact:0"] }, nextStep: { value: step, evidenceRefs: ["fact:0"] } } }] } });
  async function request(value = bundle) {
    const path = join(root, randomUUID() + ".json"), bytes = JSON.stringify(value);
    await writeFile(path, bytes);
    return { requestId: randomUUID(), path, sha256: createHash("sha256").update(bytes).digest("hex") };
  }
  return { f, root, bundle, request, store: new SourceSyncStore(f.repo) };
}

it("imports new requests into the native inbox and creates a task only after human acceptance", async () => {
  const { f, bundle, request, store } = await setup();
  const input = await request();
  const result = await f.harness.behavior.callRpc("syncImport", input);
  expect(result).toMatchObject({ id: input.requestId, provider: "claude-work", suggestions: 1, status: "partial" });
  expect(f.repo.list().total).toBe(0);
  expect(await f.harness.behavior.callRpc("proposalInbox", {})).toMatchObject({ total: 1, items: [{ kind: "source", candidate: { taskId: null, status: "pending" } }] });
  expect(await f.harness.behavior.callRpc("syncImport", input)).toEqual(result);
  expect(store.pendingCandidates()).toHaveLength(1);
  const candidate = store.pendingCandidates()[0];
  await f.reload();
  await f.harness.behavior.callRpc("syncAccept", { candidateId: candidate.id });
  const task = f.repo.list().tasks[0], dossier = await f.detail(task.id);
  expect(dossier.projection.nextStep).toBe(bundle.result.suggestions[0].changes.nextStep!.value);
  expect(dossier.sourceLinks).toMatchObject([{ url: "https://app.clickup.com/t/task123", origin: true }]);
  expect(dossier.facts.some(fact => fact.source.startsWith("approved-external-sync:"))).toBe(true);
});

it("preserves current dossiers and rejects stale analysis without leaving a run or partial proposals", async () => {
  const { f, bundle, request, store } = await setup();
  const task = await f.create(), before = await f.detail(task.id);
  bundle.result.suggestions[0].taskId = task.id;
  bundle.taskRevisions[task.id] = task.revision + 1;
  await expect(f.harness.behavior.callRpc("syncImport", await request())).rejects.toThrow();
  expect(store.state().runs).toHaveLength(0);
  bundle.taskRevisions[task.id] = task.revision;
  await f.harness.behavior.callRpc("syncImport", await request());
  const after = await f.detail(task.id);
  expect(after.task).toEqual(before.task);
  expect(after.projection).toEqual(before.projection);
  expect(after.facts).toEqual(before.facts);
  expect(store.pendingCandidates()).toHaveLength(1);
});

it("rejects forged quotes, source IDs, links, preview reads and mutating receipts atomically", async () => {
  const { f, bundle, request, store } = await setup();
  for (const change of [{ quote: "Invented text" }, { messageId: "absent-message" }, { url: "https://app.clickup.com/t/unknown-task" }, { callRef: "receipt-search" }]) {
    const value = structuredClone(bundle);
    Object.assign(value.result.suggestions[0].facts[0].citations[0], change);
    await expect(f.harness.behavior.callRpc("syncImport", await request(value))).rejects.toThrow();
    expect(store.state().runs).toHaveLength(0);
    expect(store.pendingCandidates()).toHaveLength(0);
  }
  const bad = structuredClone(bundle);
  bad.receipts[1].tool = "clickup_update_task";
  await expect(f.harness.behavior.callRpc("syncImport", await request(bad))).rejects.toThrow(/Unsupported collector operation/);
  expect(store.checkpoints()).toEqual({ gmail: null, slack: null, jira: null });
});

it("confines bundle reads to the configured folder and verifies their bytes", async () => {
  const { f, root, request, store } = await setup();
  const input = await request();
  await expect(f.harness.behavior.callRpc("syncImport", { ...input, sha256: "0".repeat(64) })).rejects.toThrow(/changed/);
  const other = await mkdtemp(join(tmpdir(), "247c-outside-")); folders.push(other);
  await writeFile(join(other, "outside.json"), "{}");
  // Windows directory junctions exercise the same realpath escape without
  // requiring administrator privileges to create a file symlink.
  const escaped = process.platform === "win32" ? join(root, "escape", "outside.json") : join(root, "escape.json");
  if (process.platform === "win32") await symlink(other, join(root, "escape"), "junction");
  else await symlink(join(other, "outside.json"), escaped);
  await expect(f.harness.behavior.callRpc("syncImport", { ...input, path: escaped })).rejects.toThrow(/inside/);
  await f.harness.behavior.setSettings({ sourceImportRoot: "" });
  await expect(f.harness.behavior.callRpc("syncImport", input)).rejects.toThrow(/Configure/);
  expect(store.pendingCandidates()).toHaveLength(0);
});

it("deduplicates subsequent imports and keeps an incomplete source checkpoint", async () => {
  const { f, bundle, request, store } = await setup();
  await f.harness.behavior.callRpc("syncImport", await request());
  await f.harness.behavior.callRpc("syncImport", await request());
  expect(store.pendingCandidates()).toHaveLength(1);
  expect(store.checkpoints().clickup).toBe(bundle.until);
  expect(store.checkpoints().teams).toBeUndefined();
  const state = await f.harness.behavior.callRpc("syncState", {});
  expect(state).toMatchObject({ nextSince: { teams: bundle.windows.teams.since, outlook: bundle.windows.outlook.since } });
  const runtime = { store, repo: f.repo } as SourceSyncRuntime;
  await expect(scheduledSourceUpdate(runtime, async () => true, new Date("2026-09-14T08:00:00Z"))).rejects.toThrow(/Custom check/);
});

it("derives Teams source and full-read authority from the resource operation", () => {
  const receipt = { callId: "teams-read", at: new Date().toISOString(), source: "m365" as const, tool: "read_resource", args: { uri: "teams:///chats/chat/messages/1" }, result: { content: [{ type: "text", text: '{"id":"1","body":{"content":"Please review."}}' }] } };
  expect(importedSourceCalls([receipt])[0]).toMatchObject({ source: "teams", read: true, completed: true });
  expect(() => importedSourceCalls([{ ...receipt, args: { uri: "file:///etc/passwd" } }])).toThrow(/Unsupported/);
});

it("proves a threaded reply's task URL through the actual parent comment", async () => {
  const { f, bundle, request, store } = await setup();
  const parent = bundle.receipts[1];
  const child = structuredClone(parent);
  child.callId = "reply-read";
  child.tool = "clickup_get_threaded_comments";
  child.args = { comment_id: "comment1" };
  child.result = { content: [{ type: "text", text: JSON.stringify({ comments: [{ id: "reply1", comment_text: "Please prepare the revised release plan." }] }) }] };
  bundle.receipts.push(child);
  const cite = bundle.result.suggestions[0].facts[0].citations[0];
  Object.assign(cite, { callRef: child.callId, messageId: "reply1", quote: "Please prepare the revised release plan." });
  for (const corrupt of ["task", "parent", "failed", "quoted-id", "workspace"] as const) {
    const bad = structuredClone(bundle);
    if (corrupt === "task") bad.result.suggestions[0].facts[0].citations[0].url = "https://app.clickup.com/t/unrelated";
    if (corrupt === "parent") bad.receipts[2].args.comment_id = "unrelated";
    if (corrupt === "failed") bad.receipts[1].result.isError = true;
    if (corrupt === "quoted-id") bad.receipts[1].result = { content: [{ type: "text", text: JSON.stringify({ comments: [{ id: "other", comment_text: "comment1" }] }) }] };
    if (corrupt === "workspace") bad.receipts[2].args.workspace_id = "other-workspace";
    await expect(f.harness.behavior.callRpc("syncImport", await request(bad))).rejects.toThrow();
    expect(store.pendingCandidates()).toHaveLength(0);
  }
  await expect(f.harness.behavior.callRpc("syncImport", await request())).resolves.toMatchObject({ suggestions: 1 });
  expect(f.repo.list().total).toBe(0);
});
