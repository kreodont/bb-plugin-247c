import { afterEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { fixture } from "./test-support.js";
import { TaskSearch, searchExpression } from "./search-index.js";
import { searchInputSchema, searchResultSchema } from "./search-contracts.js";
import { readConversation } from "./conversation.js";

const hosts: Awaited<ReturnType<typeof fixture>>[] = [];
afterEach(async () => { for (const f of hosts.splice(0)) await f.harness.lifecycle.dispose(); });
async function setup() {
  const f = await fixture(); hosts.push(f);
  const index = new TaskSearch(f.repo, f.bb, () => {});
  const query = (text: string, extra: object = {}) => index.search(searchInputSchema.parse({ query: text, ...extra }));
  const refresh = () => index.refresh(new AbortController().signal);
  return { f, index, query, refresh };
}

it("indexes current fields and every accepted historical fact across closed tasks without changing canonical data", async () => {
  const { f, query } = await setup();
  const task = f.repo.create({ title: "BK-812: Account export", description: "Договорились проверить выгрузку", requestId: randomUUID() });
  f.repo.kernel.appendFact({ taskId: task.id, kind: "progress", text: "Старое обсуждение rate mismatch", source: "human" });
  f.repo.db.prepare("UPDATE task_projections SET summary='Current agreed solution',customer='Aritzia' WHERE task_id=?").run(task.id);
  const current = f.repo.kernel.getTask(task.id);
  f.repo.status(task.id, "done", current.revision);
  const before = f.repo.kernel.getDossier(task.id);
  expect(query("выгруз").hits).toContainEqual(expect.objectContaining({ taskId: task.id, kind: "fact" }));
  expect(query('"rate mismatch"', { scope: "history" }).total).toBe(1);
  expect(query("Aritzia", { scope: "tasks" }).hits[0]).toMatchObject({ kind: "task", taskStatus: "done" });
  expect(query("BK-812", { status: "unfinished" }).total).toBe(0);
  expect(query("BK-812", { status: "closed" }).hits[0].taskId).toBe(task.id);
  expect(f.repo.kernel.getDossier(task.id)).toEqual(before);
  f.repo.db.prepare("UPDATE task_projections SET summary='Replacement wording' WHERE task_id=?").run(task.id);
  expect(query('"Current agreed solution"').total).toBe(0);
  expect(query("Replacement").total).toBe(1);
  f.repo.db.prepare("DELETE FROM task_facts WHERE task_id=? AND kind='progress'").run(task.id);
  expect(query('"rate mismatch"').total).toBe(0);
});

it("treats operators and malicious input as text, keeps identifiers exact and bounds pages", async () => {
  const { f, query } = await setup();
  for (let i = 0; i < 35; i++) f.repo.create({ title: `Account export ${i}`, description: "Shared searchable evidence", requestId: randomUUID() });
  const exact = f.repo.create({ title: "BK-812", description: "safe", requestId: randomUUID() });
  f.repo.create({ title: "BK-8120", description: "safe", requestId: randomUUID() });
  expect(query("BK-812").hits.map(h => h.taskId)).toEqual([exact.id]);
  const page = query("export");
  expect(page.total).toBe(35); expect(page.hits).toHaveLength(30); expect(page.nextOffset).toBe(30);
  const next = query("export", { offset: 30 }); expect(next.hits).toHaveLength(5); expect(next.nextOffset).toBeNull();
  expect(new Set([...page.hits, ...next.hits].map(h => h.id)).size).toBe(35);
  for (const text of ['"', '*', '(', "'; DROP TABLE tasks; --", 'NEAR(export, 3)', 'export OR missing', 'title:export']) expect(() => searchResultSchema.parse(query(text))).not.toThrow();
  expect(query("export OR missing").total).toBe(0);
  expect(searchExpression('"annual rate" BK-812 выгруз')).toBe('"annual rate" AND "BK 812" AND "выгруз"*');
});

it("indexes saved conversation snapshots immediately, deduplicates continuations and excludes context and file reads", async () => {
  const { f, index, query, refresh } = await setup(), task = await f.create();
  const session = await f.start(task.id, task.revision), threadId = session.workerThreadId!;
  f.message(threadId, "user", "Sent the renewal response");
  f.message(threadId, "assistant", "Verified the renewal response");
  const transcript = await readConversation(f.bb, session);
  transcript.messages.push({ role: "context", ref: "private-context", text: "Hiddencontext", sequence: 999 });
  f.repo.saveTranscript(session.id, transcript);
  expect(query("renewal", { scope: "messages" }).total).toBe(2);
  expect(query("Hiddencontext").total).toBe(0);
  const second = await f.create(), continued = await f.start(second.id, second.revision);
  // A combined discussion snapshot repeats original messages with their source.
  f.repo.saveTranscript(continued.id, { ...transcript, threadId: continued.workerThreadId!, messages: transcript.messages.map(m => ({ ...m, source: { threadId, messageRef: m.ref } })) });
  index.syncLocal();
  expect(query("renewal").total).toBe(2);
  await refresh();
  const hits = query("renewal").hits;
  expect(hits).toHaveLength(2);
  expect(hits.every(h => h.threadId === threadId && h.sessionId === session.id)).toBe(true);
  expect(f.harness.inspection.sdk.callsTo("files.read")).toHaveLength(0);
  expect(f.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
});

it("resumes paged backfill after reload, finds older messages and refreshes edits and new messages without duplicates", async () => {
  const { f, index, query, refresh } = await setup(), task = await f.create();
  const session = await f.start(task.id, task.revision), id = session.workerThreadId!;
  const early = f.message(id, "user", "Earliest distinctiveword");
  const late = f.message(id, "assistant", "Latest distinctiveword");
  const pages: Array<string | undefined> = [];
  const timeline = ({ beforeAnchorId }: { beforeAnchorId?: string }) => {
    pages.push(beforeAnchorId);
    return { rows: beforeAnchorId ? [early] : [late], maxSeq: late.sourceSeqEnd, timelinePage: { hasOlderRows: !beforeAnchorId, olderCursor: beforeAnchorId ? null : { anchorId: "older", anchorSeq: 2 }, kind: "latest", returnedSegmentCount: 1, segmentLimit: 100 } };
  };
  f.harness.inspection.sdk.stub("threads.timeline", timeline);
  await refresh(); expect(index.state().pending).toBe(1);
  expect(query("distinctiveword").total).toBe(1);
  await f.reload();
  f.harness.inspection.sdk.stub("threads.timeline", timeline);
  const reloaded = new TaskSearch(f.repo, f.bb, () => {});
  await reloaded.refresh(new AbortController().signal);
  expect(pages).toEqual([undefined, "older"]);
  expect(reloaded.state()).toMatchObject({ indexedThreads: 1, pending: 0 });
  expect(reloaded.search(searchInputSchema.parse({ query: "distinctiveword" })).total).toBe(2);
  f.harness.inspection.sdk.stub("threads.timeline", () => ({ rows: [{ ...late, text: "Changed uniqueanswer" }, early], maxSeq: 4, timelinePage: { hasOlderRows: false, olderCursor: null, kind: "latest", returnedSegmentCount: 1, segmentLimit: 100 } }));
  reloaded.dirtyThread(id); await reloaded.refresh(new AbortController().signal);
  expect(reloaded.search(searchInputSchema.parse({ query: "Latest" })).total).toBe(0);
  expect(reloaded.search(searchInputSchema.parse({ query: "uniqueanswer" })).hits[0]).toMatchObject({ threadId: id, sequence: late.sourceSeqStart });
});

it("marks unavailable or collapsed chats incomplete, preserves saved results, retries and stops writing after cancellation", async () => {
  const { f, index, query, refresh } = await setup(), task = await f.create(), session = await f.start(task.id, task.revision);
  f.message(session.workerThreadId!, "user", "Recoverable snapshot");
  f.repo.saveTranscript(session.id, await readConversation(f.bb, session));
  f.harness.inspection.sdk.stub("threads.timeline", () => { throw new Error("Private upstream error"); });
  await refresh();
  expect(query("Recoverable").total).toBe(1);
  expect(index.state()).toMatchObject({ unavailableThreads: 1, indexedThreads: 0 });
  expect(JSON.stringify(index.state())).not.toContain("Private");
  f.harness.inspection.sdk.stub("threads.timeline", () => ({ rows: f.conversations.get(session.workerThreadId!)!, maxSeq: 2, timelinePage: { hasOlderRows: false, olderCursor: null, kind: "latest", returnedSegmentCount: 1, segmentLimit: 100 } }));
  index.retry(); await refresh(); expect(index.state()).toMatchObject({ unavailableThreads: 0, indexedThreads: 1 });
  const before = index.state(); index.dirtyThread(session.workerThreadId!);
  const controller = new AbortController(); controller.abort(); await index.refresh(controller.signal);
  expect(index.state()).toEqual(before);
});

it("keeps review output separate and never indexes tool payloads or reviewer snapshot prompts", async () => {
  const { f, query, refresh } = await setup(), task = await f.create(), session = await f.start(task.id, task.revision);
  f.repo.saveSession({ ...session, reviewerThreadId: "reviewer" });
  f.message("reviewer", "user", "Privatesnapshotprompt");
  f.message("reviewer", "assistant", "Reviewrecommendation");
  await refresh();
  expect(query("Privatesnapshotprompt").total).toBe(0);
  expect(query("Reviewrecommendation").hits[0]).toMatchObject({ kind: "review", label: "Review output · not accepted task data" });
});

it("indexes messages beyond the review size limit and does not index unaccepted user input", async () => {
  const { f, query, refresh } = await setup(), task = await f.create(), session = await f.start(task.id, task.revision), id = session.workerThreadId!;
  f.message(id, "assistant", "ordinary ".repeat(80_000) + "Endoflongconversation");
  const rejected = f.message(id, "user", "Rejectedsecretword");
  if (rejected.kind === "conversation" && rejected.role === "user") rejected.turnRequest.status = "rejected";
  await refresh();
  const result = query("Endoflongconversation");
  expect(result.total).toBe(1); expect(result.hits[0].snippet).toContain("Endoflongconversation");
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(10000);
  expect(query("Rejectedsecretword").total).toBe(0);
});

it("does not claim complete coverage for missing nested rows or cyclic pagination and can recover", async () => {
  const { f, index, refresh } = await setup(), task = await f.create(), session = await f.start(task.id, task.revision);
  const row = f.message(session.workerThreadId!, "assistant", "Page one");
  f.harness.inspection.sdk.stub("threads.timeline", () => ({ rows: [{ ...row, kind: "turn", children: null, summaryCount: 1 }], maxSeq: 2, timelinePage: { hasOlderRows: false, olderCursor: null, kind: "latest", returnedSegmentCount: 1, segmentLimit: 100 } }));
  await refresh(); expect(index.state()).toMatchObject({ indexedThreads: 0, unavailableThreads: 1 });
  f.harness.inspection.sdk.stub("threads.timeline", () => ({ rows: [row], maxSeq: 2, timelinePage: { hasOlderRows: true, olderCursor: { anchorId: "same", anchorSeq: 1 }, kind: "latest", returnedSegmentCount: 1, segmentLimit: 100 } }));
  index.retry(); await refresh(); await refresh();
  expect(index.state()).toMatchObject({ indexedThreads: 0, unavailableThreads: 1 });
});

it("discards a timeline response if disposal happens while it is being read", async () => {
  const { f, index, query, refresh } = await setup(), task = await f.create(), session = await f.start(task.id, task.revision);
  const row = f.message(session.workerThreadId!, "assistant", "Latereply");
  let release!: () => void;
  f.harness.inspection.sdk.stub("threads.timeline", () => new Promise(resolve => { release = () => resolve({ rows: [row], maxSeq: 2, timelinePage: { hasOlderRows: false, olderCursor: null, kind: "latest", returnedSegmentCount: 1, segmentLimit: 100 } }); }));
  const pending = refresh(); index.dispose(); release(); await pending;
  expect(query("Latereply").total).toBe(0);
});
