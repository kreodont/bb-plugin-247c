import { randomUUID } from "node:crypto";
import { nativeRequest, syncStartSchema, type SyncRun, type SyncSubmit } from "./contracts.js";
import { fixture, type TimelineRow } from "./test-support.js";
import { SourceSyncStore, readSourceCalls, type SourceCall } from "./source-sync.js";

export function connectorCall(f: Awaited<ReturnType<typeof fixture>>, threadId: string, toolName: string, args: Record<string, unknown>, output: unknown, extra: Record<string, unknown> = {}) {
  const rows = f.conversations.get(threadId) ?? [];
  const seq = rows.length + 1;
  const row = { id: `source_${seq}`, kind: "work", workKind: "tool", callId: `call_${seq}`, createdAt: Date.now(), startedAt: Date.now(), completedAt: Date.now(),
    sourceSeqStart: seq, sourceSeqEnd: seq, threadId, turnId: null, approvalStatus: null, status: "completed", toolName, toolArgs: args,
    output: typeof output === "string" ? output : JSON.stringify(output), ...extra } as TimelineRow;
  f.conversations.set(threadId, [...rows, row]);
}

export async function startSourceSync(f: Awaited<ReturnType<typeof fixture>>, since: string | null = null) {
  const request = f.startInput("unused", 0).request;
  request.providerId = "claude-work"; request.model = "claude-opus-5[1m]";
  const input = syncStartSchema.parse({ requestId: randomUUID(), since, request });
  // Seed the persisted pre-script format to keep its receipt/approval lifecycle
  // covered. The actual script-first start is exercised in source-collection.test.
  const store = new SourceSyncStore(f.repo);
  let run = store.insert(input);
  const thread = await f.bb.sdk.threads.spawn({ ...nativeRequest(input.request), title: `247C · обновления · ${run.id}` });
  run = store.save({ ...run, threadId: thread.id, status: "working" });
  return { run, input };
}

export async function sourceData(f: Awaited<ReturnType<typeof fixture>>, run: SyncRun, taskId: string | null = null) {
  const threadId = run.threadId!;
  const quote = "Please send the revised report. This is no longer blocked.";
  connectorCall(f, threadId, "mcp__claude_ai_Gmail__search_threads", { query: "is:unread in:inbox after:1234", pageSize: 50 }, { threads: [] });
  connectorCall(f, threadId, "mcp__claude_ai_Gmail__search_threads", { query: "after:1234", pageSize: 50 }, { threads: [{ id: "thread-gmail-1" }] });
  connectorCall(f, threadId, "mcp__claude_ai_Gmail__get_thread", { threadId: "thread-gmail-1", messageFormat: "PLAIN_TEXT" }, { messages: [{ id: "msg-1", text: quote }] });
  connectorCall(f, threadId, "mcp__slack__slack_search_public_and_private", { query: "after:2026-09-01" }, { messages: [], has_more: false });
  connectorCall(f, threadId, "mcp__claude_ai_Atlassian__searchJiraIssuesUsingJql", { jql: "updated >= -1d" }, { issues: [], isLast: true });
  const calls = await readSourceCalls(f.bb, threadId);
  const read = calls.find((call) => call.source === "gmail" && call.read)!;
  const citation = { callRef: read.ref, source: "gmail" as const, url: "https://mail.google.com/mail/u/0/#all/thread-gmail-1", messageId: "msg-1", occurredAt: new Date(Date.parse(run.until) - 3600000).toISOString(), quote };
  const step = "Подготовить обновлённый отчёт.";
  const input: SyncSubmit = { reports: reportsFor(calls), suggestions: [{ taskId, title: "Обновить отчёт", rationale: "Пришёл ответ с просьбой обновить отчёт; прежнее ожидание снято.", confidence: 0.9,
    facts: [{ kind: "progress", text: "Получен ответ, ограничение снято.", citations: [citation] }, { kind: "explicit_next_step", text: step, citations: [citation] }],
    changes: { summary: { value: "Нужно подготовить обновлённый отчёт. Прежнее ограничение снято.", evidenceRefs: ["fact:0", "fact:1"] }, nextStep: { value: step, evidenceRefs: ["fact:1"] }, blockers: { value: [], evidenceRefs: ["fact:0"] } } }] };
  return { calls, input, citation, quote };
}

export function reportsFor(calls: SourceCall[]): SyncSubmit["reports"] {
  return (["gmail", "slack", "jira"] as const).map((source) => ({ source, status: "complete", detail: "Поиск, треды и связанные задачи проверены.", callRefs: calls.filter((c) => c.source === source).map((c) => c.ref),
    paginationComplete: true, linkedTasksChecked: true, scanned: source === "gmail" ? 1 : 0, threadsRead: calls.filter((c) => c.source === source && c.read).length }));
}

export async function submitSourceData(f: Awaited<ReturnType<typeof fixture>>, run: SyncRun, input: SyncSubmit) {
  return f.harness.behavior.callAgentTool("c247_sync_submit", input, { threadId: run.threadId!, projectId: "proj_personal", signal: new AbortController().signal });
}
