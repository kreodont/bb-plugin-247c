import { isLiveTask } from "./task-status.js";
import type { SlackTarget } from "./source-slack-evidence.js";
import { confirmedJiraReferences, jiraProject, jiraProjectAllowed, jiraReferenceDetails, jiraReferences, pullRequestReferences } from "./source-links.js";
import { defaultSourceConfig, type SourceConfig } from "./source-config.js";
import { randomUUID } from "node:crypto";
import type { SyncCandidate, SyncRun, NativeSyncSource as SyncSource, SyncSubmit } from "./contracts.js";
import type { TaskDossier } from "./core/types.js";
import type { SourceCall } from "./source-sync.js";
import { connectSources, sourceError, type SourceConnections, type SourceReady } from "./source-connectors.js";
import { SourceBudget } from "./source-budget.js";
import type { ConnectionAttempt } from "./source-diagnostics.js";
import { sourceResponseFailure, sourceThrownFailure } from "./source-errors.js";
import { missingSlackThread, readableSlackChannel, normalizeMissingSlackReport } from "./source-slack-missing.js";

type Json = Record<string, any>;
export type SourceDocument = { ref: string; source: SyncSource; tool: string; args: Record<string, unknown>; content: string };
export type SourceExport = {
  version: 1; runId: string; startedAt: string; finishedAt: string; elapsedMs: number;
  calls: SourceCall[]; documents: SourceDocument[]; reports: SyncSubmit["reports"];
  connectionAttempts?: ConnectionAttempt[];
};
export type CollectionProgress = { source: SyncSource; calls: number; reads: number; detail: string };
export type CollectionOptions = {
  config?: SourceConfig;
  pendingCandidates?: SyncCandidate[];
  signal?: AbortSignal; connect?: (signal: AbortSignal, onReady: SourceReady, onAttempt: (attempt: ConnectionAttempt) => void) => Promise<SourceConnections>;
  onProgress?: (progress: CollectionProgress) => void;
  onConnectionAttempt?: (attempt: ConnectionAttempt) => void;
  // Limits are independent for each source. Setup and idle time do not spend the read budget.
  timeoutMs?: number; maxCalls?: number;
  retryDelayMs?: (attempt: number, rateLimited: boolean) => number;
  resolveSlackLink?: (target: SlackTarget) => SlackTarget | null;
};
// Slack answers rate limits with a bare "ratelimited" payload, sometimes wrapped
// in a transport error. A one-second retry falls inside the same rate window.
export const sourceRetryDelay = (attempt: number, rateLimited: boolean) => rateLimited ? [5000, 15000, 30000][attempt] ?? 30000 : (attempt + 1) * 1000;
// Budget the actual pretty-printed tool response, including JSON escaping.
// Claude moves oversized results to a file the analyst must not need to read.
export const SOURCE_PAGE_BYTES = 24000;
export function sourceExportPage(bundle: SourceExport, page: number) {
  const pages: (SourceDocument & { part: number; parts: number })[][] = [[]];
  const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value, null, 2));
  const envelope = (documents: typeof pages[number]) => ({ runId: bundle.runId, page: 999999, totalPages: 999999, nextPage: 999999, documents });
  for (const doc of bundle.documents) {
    const chunks: string[] = [];
    let offset = 0;
    do {
      let lo = 0, hi = Math.min(doc.content.length - offset, SOURCE_PAGE_BYTES);
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        const value = { ...doc, content: doc.content.slice(offset, offset + mid), part: 999999, parts: 999999 };
        if (size(envelope([value])) <= SOURCE_PAGE_BYTES) lo = mid;
        else hi = mid - 1;
      }
      // Do not split a UTF-16 surrogate pair between pages.
      if (lo && /[\uD800-\uDBFF]/.test(doc.content[offset + lo - 1])) lo--;
      if ((!lo && offset < doc.content.length) || size(envelope([{ ...doc, content: "", part: 999999, parts: 999999 }])) > SOURCE_PAGE_BYTES) throw new Error("Document metadata exceeds the export page size.");
      chunks.push(doc.content.slice(offset, offset + lo)); offset += lo;
    } while (offset < doc.content.length);
    for (const [part, content] of chunks.entries()) {
      const value = { ...doc, content, part: part + 1, parts: chunks.length };
      if (size(envelope([...pages[pages.length - 1], value])) > SOURCE_PAGE_BYTES) pages.push([]);
      pages[pages.length - 1].push(value);
    }
  }
  if (!Number.isInteger(page) || page < 0 || page >= pages.length) throw new Error("Export page not found.");
  return { runId: bundle.runId, page, totalPages: pages.length, nextPage: page + 1 < pages.length ? page + 1 : null, documents: pages[page] };
}
const SOURCES: SyncSource[] = ["gmail", "slack", "jira"];

export function responseData(result: unknown): Json {
  const data = result as Json;
  const parts = (data?.content ?? []).filter((p: Json) => p.type === "text").map((p: Json) => p.text);
  if (parts.length === 1) { try { return JSON.parse(parts[0]); } catch { /* A text response is also valid. */ } }
  // Atlassian's structuredContent is a UI graph (issues.nodes/context), while
  // the text block contains the actual get/search payload and pagination.
  if (data?.structuredContent && typeof data.structuredContent === "object") return data.structuredContent;
  return { text: parts.join("\n") };
}
export function receiptText(data: unknown): string {
  const strings: string[] = [];
  function visit(value: unknown) {
    if (typeof value === "string") strings.push(value);
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object") Object.values(value).forEach(visit);
  }
  visit(data);
  return `${JSON.stringify(data)}\n${[...new Set(strings)].join("\n")}`;
}
export function pageState(data: Json, count: number, limit: number): { token?: string; complete: boolean } {
  const token = data.nextPageToken || data.next_page_token || data.next_cursor || data.response_metadata?.next_cursor
    || /(?:use\s+)?cursor\s+`([^`]+)`/i.exec(data.pagination_info ?? "")?.[1];
  if (typeof token === "string" && token.trim()) return { token, complete: false };
  if (data.isLast === true || data.has_more === false || /no more|end of results/i.test(data.pagination_info ?? "")) return { complete: true };
  if (data.isLast === false || data.has_more === true) return { complete: false };
  return { complete: count < limit };
}
export function sourceLinks(text: string): { gmail: string[]; slack: { channel: string; ts: string }[]; jira: string[] } {
  text = text.replace(/\\\//g, "/");
  const gmail = [...text.matchAll(/mail\.google\.com[^\s"\\]*\/(?:#|%23)(?:all|inbox|sent|label\/[^/]+)\/([a-f0-9]{10,32})\b/g)].map(m => m[1]);
  const slack = [...text.matchAll(/(?:[\w-]+\.)?slack\.com\/archives\/([CDG][A-Z0-9]+)\/p(\d{10})(\d{6})(\?[^\s<>"\\)\]|]*)?/g)].map(m => ({ channel: m[1], ts: /thread_ts=(\d{10}\.\d{6})/.exec(m[4] ?? "")?.[1] ?? `${m[2]}.${m[3]}` }));
  const jira = jiraReferences(text);
  return { gmail: [...new Set(gmail)], slack: [...new Map(slack.map(s => [`${s.channel}:${s.ts}`, s])).values()], jira };
}
async function pool<T>(items: T[], work: (item: T) => Promise<void>, concurrency = 3) {
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => { while (index < items.length) await work(items[index++]); }));
}
function documentContent(source: SyncSource, data: Json, until: number): string {
  if (source === "gmail" && !Array.isArray(data.messages) && typeof data.threadId === "string") data = { id: data.threadId, messages: [data] };
  if (source === "gmail" && Array.isArray(data.messages)) {
    return JSON.stringify({ id: data.id, messages: data.messages.filter((m: Json) => Number(m.internalDate ?? Date.parse(m.date)) <= until).map((m: Json) => ({
      id: m.id, threadId: m.threadId, date: m.date, internalDate: m.internalDate, sender: m.sender, to: m.toRecipients, cc: m.ccRecipients,
      subject: m.subject, labelIds: m.labelIds, body: m.plaintextBody ?? m.plaintext_body ?? "", attachments: m.attachments?.map((a: Json) => ({ filename: a.filename, mimeType: a.mimeType })),
    })) });
  }
  if (source === "jira" && data.fields) {
    const f = data.fields;
    return JSON.stringify({ key: data.key, id: data.id, updated: f.updated, summary: f.summary, status: f.status?.name, priority: f.priority?.name,
      assignee: { name: f.assignee?.displayName, email: f.assignee?.emailAddress }, description: f.description,
      comments: (data.comments ?? f.comment?.comments ?? []).filter((c: Json) => Date.parse(c.updated ?? c.created) <= until).map((c: Json) => ({ id: c.id, author: c.author?.displayName, created: c.created, updated: c.updated, body: c.body })),
    });
  }
  return typeof data.messages === "string" ? data.messages : JSON.stringify(data);
}

export async function collectSources(run: SyncRun, dossiers: TaskDossier[], options: CollectionOptions = {}): Promise<SourceExport> {
  const config = options.config ?? defaultSourceConfig;
  const start = Date.now();
  const signal = options.signal ?? new AbortController().signal;
  const budgets = Object.fromEntries(SOURCES.map(s => [s, new SourceBudget(signal, options.timeoutMs ?? 180000)])) as Record<SyncSource, SourceBudget>;
  const connectionAttempts: ConnectionAttempt[] = [];
  const onAttempt = (attempt: ConnectionAttempt) => { connectionAttempts.push(attempt); options.onConnectionAttempt?.(attempt); };
  const calls: SourceCall[] = [], documents: SourceDocument[] = [];
  const recoveredCalls = new Set<string>();
  const callProblems = new Map<string, string>();
  const problems: Record<SyncSource, string[]> = { gmail: [], slack: [], jira: [] };
  const scanned = { gmail: 0, slack: 0, jira: 0 };
  const contextText = JSON.stringify([dossiers.filter(d => isLiveTask(d.task.status)), options.pendingCandidates ?? []]);
  const linked = { ...sourceLinks(contextText), jira: confirmedJiraReferences(contextText, [], config.jiraProjects) };
  const pending = { gmail: new Set(linked.gmail), slack: new Map(linked.slack.map(s => [`${s.channel}:${s.ts}`, s])), jira: new Set(linked.jira) };
  // Bare identifiers in source prose can also be store, project or customer IDs.
  // Trust projects established by Jira URLs or Jira search results;
  // a direct Jira URL remains authoritative for a newly discovered project.
  const trustedJiraProjects = new Set([...config.jiraProjects, ...linked.jira.map(jiraProject)]);
  const unconfirmedJira = new Set<string>();
  const trustJiraProject = (key: string) => {
    if (!jiraProjectAllowed(key, config.jiraProjects)) return;
    const project = jiraProject(key);
    trustedJiraProjects.add(project);
    for (const candidate of unconfirmedJira) if (jiraProject(candidate) === project) {
      pending.jira.add(candidate); unconfirmedJira.delete(candidate);
    }
  };
  const addJiraLinks = (text: string) => {
    const references = jiraReferenceDetails(text).filter(r => jiraProjectAllowed(r.key, config.jiraProjects));
    // Establish projects before inspecting bare keys, regardless of text order.
    for (const reference of references) if (reference.explicit) trustJiraProject(reference.key);
    for (const reference of references) {
      if (reference.explicit || trustedJiraProjects.has(jiraProject(reference.key))) pending.jira.add(reference.key);
      else unconfirmedJira.add(reference.key);
    }
  };
  // Retain unconfirmed keys in case a later source read establishes the project.
  // They are not requested or counted as missing while still unconfirmed.
  addJiraLinks(contextText);
  const searchedGmail = new Set<string>(), gmailThreads = new Map<string, string>();
  const read = { gmail: new Set<string>(), slack: new Set<string>(), jira: new Set<string>() };
  const knownPullRequests = new Set(pullRequestReferences(JSON.stringify(dossiers)));
  const pendingPullRequests = new Set(pullRequestReferences(JSON.stringify(options.pendingCandidates ?? [])).filter(url => !knownPullRequests.has(url)));
  const searchedPullRequests = new Set<string>();
  const connections = {} as SourceConnections;
  const bytes = { gmail: 0, slack: 0, jira: 0 }, count = { gmail: 0, slack: 0, jira: 0 };
  const error = (source: SyncSource, message: string) => { if (!problems[source].includes(message)) problems[source].push(message); };
  const progress = (source: SyncSource, detail: string) => options.onProgress?.({ source, detail, calls: calls.filter(c => c.source === source).length, reads: calls.filter(c => c.source === source && c.read && c.completed).length });
  const addLinks = (text: string) => {
    const found = sourceLinks(text);
    found.gmail.forEach(id => pending.gmail.add(id));
    addJiraLinks(text);
    found.slack.forEach(s => pending.slack.set(`${s.channel}:${s.ts}`, s));
  };
  async function call(source: SyncSource, tool: string, args: Json, full = false, expectedThreadId?: string): Promise<Json | null> {
    const leave = budgets[source].enter();
    try { return await callWithinBudget(source, tool, args, full, expectedThreadId); }
    finally { leave(); }
  }
  function stoppedMessage(source: SyncSource) {
    return signal.aborted ? "The check was canceled." : `${source} read time budget exhausted (${(options.timeoutMs ?? 180000) / 1000}s); the unchecked interval is preserved.`;
  }
  async function callWithinBudget(source: SyncSource, tool: string, args: Json, full = false, expectedThreadId?: string): Promise<Json | null> {
    const signal = budgets[source].signal;
    if (signal.aborted) { error(source, stoppedMessage(source)); return null; }
    if (count[source] >= (options.maxCalls ?? 600) || bytes[source] > 28 * 1024 * 1024) { error(source, `${source} export limit was reached (${count[source]} calls, ${bytes[source]} bytes); the unchecked interval is preserved.`); return null; }
    const connection = connections[source];
    if ("error" in connection) { error(source, connection.error); return null; }
    count[source]++;
    const ref = `export:${run.id}:${randomUUID()}`;
    const target = args.threadId ?? args.messageId ?? args.issueIdOrKey ?? (args.channel_id && args.message_ts ? `${args.channel_id}:${args.message_ts}` : args.channel_id);
    try {
      let result: unknown;
      for (let attempt = 0; ; attempt++) {
        try {
          result = await connection.call(tool, args, signal);
          const failure = sourceResponseFailure(result as Json, responseData(result));
          if (failure?.retryable) throw failure;
          break;
        }
        catch (cause) {
          const failure = sourceThrownFailure(cause), { rateLimited } = failure;
          if (attempt >= (rateLimited ? 3 : 2) || signal.aborted || !failure.retryable) throw failure;
          await new Promise<void>(resolve => {
            const done = () => { clearTimeout(t); signal.removeEventListener("abort", done); resolve(); };
            const t = setTimeout(done, (options.retryDelayMs ?? sourceRetryDelay)(attempt, rateLimited)); t.unref?.();
            signal.addEventListener("abort", done, { once: true });
          });
        }
      }
      const data = responseData(result), raw = result as Json;
      const failure = sourceResponseFailure(raw, data);
      const output = receiptText(data);
      const shapeOk = tool === "get_message" ? data.id === args.messageId && typeof data.threadId === "string"
        && (!expectedThreadId || data.threadId === expectedThreadId)
        && (!full || typeof (data.plaintextBody ?? data.plaintext_body) === "string" && Number.isFinite(Number(data.internalDate ?? Date.parse(data.date))))
        : !full || (source === "gmail" ? Array.isArray(data.messages) : source === "jira" ? Boolean(data.key && data.fields) : typeof data.messages === "string");
      const completed = !failure && shapeOk;
      const size = Buffer.byteLength(output);
      const truncated = size > 3 * 1024 * 1024 || bytes[source] + size > 32 * 1024 * 1024;
      const savedOutput = truncated ? output.slice(0, 1000) : output;
      bytes[source] += Buffer.byteLength(savedOutput);
      calls.push({ ref, source, tool: `${source}.${tool}`, args, output: savedOutput, completed: completed && !truncated, truncated, read: full });
      if (completed && source === "gmail" && tool === "get_thread" && full && size > 3 * 1024 * 1024) {
        await readLargeGmailThread(data, String(args.threadId), ref);
        return data;
      }
      if (!completed || truncated) {
        const detail = `${tool}${target ? ` (${target})` : ""}: ${truncated ? "response too large" : failure ? failure.message.slice(0, 400) : !shapeOk ? "unrecognized source response format" : sourceError(output).slice(0, 400)}`;
        callProblems.set(ref, detail); error(source, detail);
        return null;
      }
      if (full) {
        const content = documentContent(source, data, Date.parse(run.until));
        // Jira notification subjects establish a project before following bare
        // references in that thread. Ordinary bracketed store codes do not.
        if (source === "gmail") {
          for (const message of JSON.parse(content).messages ?? []) {
            const subject = String(message.subject ?? "");
            if (/\[JIRA\]/i.test(subject)) for (const reference of jiraReferenceDetails(subject)) trustJiraProject(reference.key);
          }
        }
        documents.push({ ref, source, tool, args, content }); addLinks(output);
        for (const url of pullRequestReferences(content)) if (!knownPullRequests.has(url)) pendingPullRequests.add(url);
      }
      progress(source, full ? "Reading full threads and linked issues" : "Loading the list of changes");
      return data;
    } catch (cause) {
      const message = signal.aborted ? stoppedMessage(source) : sourceError(cause);
      calls.push({ ref, source, tool: `${source}.${tool}`, args, output: message, completed: false, truncated: false, read: full });
      const detail = `${tool}${target ? ` (${target})` : ""}: ${message}`;
      callProblems.set(ref, detail); error(source, detail); progress(source, "Some data is unavailable"); return null;
    }
  }
  async function readLargeGmailThread(data: Json, threadId: string, ref: string) {
    const timestamp = (message: Json) => Number(message.internalDate ?? Date.parse(message.date));
    const valid = data.messages.every((message: Json) => typeof message.id === "string" && message.id.length > 0 && Number.isFinite(timestamp(message)));
    const messages = [...new Map<string, Json>(data.messages.filter((message: Json) => typeof message.id === "string" && Number.isFinite(timestamp(message)) && timestamp(message) <= Date.parse(run.until))
      .map((message: Json) => [message.id, message] as const)).values()].sort((a, b) => timestamp(b) - timestamp(a));
    let loaded = 0;
    for (const message of messages) {
      const result = await call("gmail", "get_message", { messageId: message.id, messageFormat: "PLAIN_TEXT" }, true, threadId);
      if (result) loaded++;
      if (budgets.gmail.signal.aborted || count.gmail >= (options.maxCalls ?? 600) || bytes.gmail > 28 * 1024 * 1024) break;
    }
    if (valid && loaded === messages.length) recoveredCalls.add(ref);
    else error("gmail", `get_thread (${threadId}): oversized thread recovery incomplete (${loaded}/${messages.length} messages read${valid ? "" : "; invalid message metadata"}).`);
  }
  async function pages(source: SyncSource, tool: string, args: Json, take: (data: Json) => number, tokenName: string, limit: number, full = false): Promise<boolean> {
    const tokens = new Set<string>();
    for (let page = 0; page < 100; page++) {
      const data = await call(source, tool, args, full); if (!data) return false;
      const n = take(data), state = pageState(data, n, limit);
      if (state.complete) return true;
      if (!state.token || tokens.has(state.token)) { error(source, `${tool}: the end of pagination was not confirmed.`); return false; }
      tokens.add(state.token); args = { ...args, [tokenName]: state.token };
    }
    error(source, `${tool}: page limit exceeded.`);
    return false;
  }
  async function gmailSearch(query: string) {
    await pages("gmail", "search_threads", { query, pageSize: 50, view: "THREAD_VIEW_MINIMAL" }, data => {
      if (!Array.isArray(data.threads)) { if (Object.keys(data).some(k => k !== "resultCountEstimate")) error("gmail", "Unrecognized Gmail search format."); return 0; }
      for (const t of data.threads) { if (typeof t.id === "string") { pending.gmail.add(t.id); searchedGmail.add(t.id); } }
      scanned.gmail += data.threads.length; return data.threads.length;
    }, "pageToken", 50);
  }
  async function gmail() {
    const since = Math.floor(Date.parse(run.ranges.gmail.since) / 1000 - 300), until = Math.floor(Date.parse(run.until) / 1000 + 1);
    await Promise.all([gmailSearch(`is:unread in:inbox after:${since} before:${until}`), gmailSearch(`after:${since} before:${until} ${config.mailFilters}`)]);
    // Stable task keys also find conversations whose dossier has no source URL.
    const keys = [...new Set(JSON.stringify(dossiers.filter(d => isLiveTask(d.task.status))).match(/\b(?:[A-Z][A-Z0-9]*-\d+|SO\d{5,}|E\d{6,}|Q-\d+)\b/g) ?? [])];
    for (let i = 0; i < keys.length; i += 25) await gmailSearch(`after:${since} before:${until} {${keys.slice(i, i + 25).join(" ")}}`);
    await readGmail();
  }
  async function readGmail() {
    const fetchThread = async (id: string) => {
      let threadId = gmailThreads.get(id) ?? id;
      if (!searchedGmail.has(id) && !gmailThreads.has(id)) {
        const message = await call("gmail", "get_message", { messageId: id, messageFormat: "METADATA_ONLY" });
        if (!message) { read.gmail.add(id); return; }
        threadId = message.threadId;
        gmailThreads.set(id, threadId);
      }
      const alreadyRead = read.gmail.has(threadId);
      read.gmail.add(id);
      if (alreadyRead) return;
      read.gmail.add(threadId);
      const data = await call("gmail", "get_thread", { threadId, messageFormat: "PLAIN_TEXT" }, true);
      if (data && Array.isArray(data.messages)) {
        for (const message of data.messages) {
          if (typeof message.id === "string") gmailThreads.set(message.id, threadId);
        }
      }
    };
    // Search results contain canonical thread IDs. Read them first so message
    // permalinks in dossiers can resolve to a full thread already in the export.
    await pool([...searchedGmail].filter(id => !read.gmail.has(id)), fetchThread, 4);
    await pool([...pending.gmail].filter(id => !read.gmail.has(id)), fetchThread, 4);
  }
  async function readPullRequestContext() {
    const urls = [...pendingPullRequests].filter(url => !searchedPullRequests.has(url));
    const until = Math.floor(Date.parse(run.until) / 1000 + 1);
    await pool(urls, async url => {
      searchedPullRequests.add(url);
      await gmailSearch(`"${url}" before:${until}`);
    }, 3);
  }
  async function slack() {
    const after = String(Math.floor(Date.parse(run.ranges.slack.since) / 1000 - 300)), before = String(Date.parse(run.until) / 1000);
    const mentions = config.slackUserId ? [`<@${config.slackUserId}>`] : [];
    await pool(["is:dm", "is:mpim", "to:me", "from:me", ...mentions, ...config.slackChannels.map(c => `in:${c}`)], async query => {
      await pages("slack", "slack_search_public_and_private", { query, after, before, limit: 20, include_context: false, include_bots: true, sort: "timestamp" }, data => {
        const text = String(data.results ?? data.text ?? ""); addLinks(text);
        const n = [...text.matchAll(/### Result \d+/g)].length; scanned.slack += n;
        if ((!text && typeof data.results !== "string") || (!n && !/no (?:results|messages)|0 results|no matches|messages \(0/i.test(text) && text.trim())) error("slack", "Unrecognized Slack search result format.");
        return n;
      }, "cursor", 20);
    });
    await pool(config.slackGroups, async channel => {
      await pages("slack", "slack_read_channel", { channel_id: channel, oldest: after, latest: before, limit: 100 }, data => {
        const text = String(data.messages ?? ""), found = [...text.matchAll(/Message[_ ]TS:\s*(\d{10}\.\d{6})/gi)];
        for (const m of found) pending.slack.set(`${channel}:${m[1]}`, { channel, ts: m[1] });
        scanned.slack += found.length; addLinks(text); return found.length;
      }, "cursor", 100);
    });
    await readSlack();
  }
  async function readSlack() {
    await pool([...pending.slack.values()].filter(s => !read.slack.has(`${s.channel}:${s.ts}`)), async s => {
      read.slack.add(`${s.channel}:${s.ts}`);
      const readThread = (target: SlackTarget) => pages("slack", "slack_read_thread", { channel_id: target.channel, message_ts: target.ts, limit: 1000, latest: String(Date.parse(run.until) / 1000) }, data => {
        const text = String(data.messages ?? "");
        if (!text && !/no more|no thread/i.test(String(data.pagination_info ?? ""))) error("slack", `Could not read thread ${s.channel}:${s.ts}.`);
        return [...text.matchAll(/Message[_ ]TS:/gi)].length;
      }, "cursor", 1000, true);
      const first = calls.length;
      if (await readThread(s)) return;
      const failed = calls.slice(first).filter(c => c.source === "slack" && (c.args as Json).channel_id === s.channel && (c.args as Json).message_ts === s.ts && !c.completed);
      if (failed.length !== 1 || !/\bthread_not_found\b/.test(failed[0].output)) return;
      const target = options.resolveSlackLink?.(s);
      if (!target || target.channel === s.channel && target.ts === s.ts || !await readThread(target)) return;
      const containsMessage = calls.some(c => c.source === "slack" && c.completed && (c.args as Json).channel_id === target.channel && (c.args as Json).message_ts === target.ts
        && [...c.output.matchAll(/Message[_ ]TS:\s*(\d{10}\.\d{6})/gi)].some(m => m[1] === s.ts));
      if (!containsMessage) return;
      recoveredCalls.add(failed[0].ref);
      const detail = callProblems.get(failed[0].ref);
      if (detail) problems.slack = problems.slack.filter(p => p !== detail);
      read.slack.add(`${target.channel}:${target.ts}`);
    }, 4);
  }
  async function jira() {
    // JQL dates use the Jira user's timezone, which can differ from the Mac.
    // Expand by a day, then filter returned ISO timestamps exactly in code.
    const sinceMs = Date.parse(run.ranges.jira.since) - 300000, untilMs = Date.parse(run.until);
    const since = new Date(sinceMs - 86400000).toISOString().slice(0, 10), until = new Date(untilMs + 2 * 86400000).toISOString().slice(0, 10);
    const projects = config.jiraProjects.length ? ` AND project IN (${config.jiraProjects.map(key => `"${key}"`).join(", ")})` : "";
    const jql = `updated >= "${since}" AND updated <= "${until}" AND (${config.jiraScope})${projects} ORDER BY updated DESC`;
    await pages("jira", "searchJiraIssuesUsingJql", { cloudId: config.jiraSite, jql, maxResults: 100, fields: ["summary", "status", "updated"], responseContentFormat: "markdown" }, data => {
      if (!Array.isArray(data.issues)) { error("jira", "Unrecognized Jira search format."); return 0; }
      for (const issue of data.issues) {
        if (typeof issue.key === "string" && !jiraProjectAllowed(issue.key, config.jiraProjects)) continue;
        scanned.jira++;
        const at = Date.parse(issue.fields?.updated);
        if (!Number.isFinite(at)) error("jira", `Missing update time for ${issue.key}.`);
        if (typeof issue.key === "string") trustJiraProject(issue.key);
        if (Number.isFinite(at) && at >= sinceMs && at <= untilMs && typeof issue.key === "string") pending.jira.add(issue.key);
      }
      return data.issues.length;
    }, "nextPageToken", 100);
    await readJira();
  }
  async function readJira() {
    await pool([...pending.jira].filter(id => !read.jira.has(id)), async id => {
      read.jira.add(id);
      const data = await call("jira", "getJiraIssue", { cloudId: config.jiraSite, issueIdOrKey: id, fields: ["summary", "status", "updated", "assignee", "priority", "description", "comment"], responseContentFormat: "markdown", updateHistory: false }, true);
      if (!data) return;
      if (!data.fields || !data.key) { error("jira", `Could not read issue ${id}.`); return; }
      const c = data.fields.comment, comments = data.comments ?? c?.comments;
      if (!Array.isArray(comments) || c?.total > comments.length || c?.startAt > 0 || comments.length >= 100) error("jira", `${id}: the connector did not confirm that all comments were included.`);
    });
  }
  try {
    const ready = {} as Record<SyncSource, () => void>;
    const waiting = Object.fromEntries(SOURCES.map(source => [source, new Promise<void>(resolve => { ready[source] = resolve; })])) as Record<SyncSource, Promise<void>>;
    const onReady: SourceReady = (source, connection) => {
      if (connections[source]) return;
      connections[source] = connection;
      if ("error" in connection) error(source, connection.error);
      ready[source]();
    };
    const connecting = (options.connect ?? ((s, ready, attempt) => connectSources(s, config, ready, attempt)))(signal, onReady, onAttempt)
      .then(all => { for (const source of SOURCES) onReady(source, all[source]); })
      .catch(cause => { for (const source of SOURCES) onReady(source, { error: sourceError(cause) }); });
    const initial = { gmail, slack, jira };
    await Promise.all([connecting, ...SOURCES.map(async source => {
      await waiting[source];
      try { await initial[source](); } catch (cause) { error(source, sourceError(cause)); }
    })]);
    // Drain newly discovered links under the existing request, time and byte
    // limits. A fixed hop count can leave real linked issues unread.
    while (!signal.aborted) {
      const before = read.gmail.size + read.slack.size + read.jira.size + searchedPullRequests.size;
      await readPullRequestContext();
      await Promise.all([readGmail(), readSlack(), readJira()]);
      if (before === read.gmail.size + read.slack.size + read.jira.size + searchedPullRequests.size || signal.aborted) break;
    }
    for (const source of SOURCES) {
      const unread = [...pending[source].keys()].filter(id => !read[source].has(id));
      if (unread.length) error(source, `Linked references were not read: ${unread.slice(0, 10).join(", ")}${unread.length > 10 ? "…" : ""}.`);
    }
    // A missing message is normal, but lost channel access is not. Usually a
    // different linked thread already proves access; otherwise probe once.
    const checkedChannels = new Set<string>();
    for (const missing of calls.filter(missingSlackThread)) {
      if (recoveredCalls.has(missing.ref)) continue;
      const channel = (missing.args as Json).channel_id as string;
      if (checkedChannels.has(channel) || calls.some(c => readableSlackChannel(c, channel))) continue;
      checkedChannels.add(channel);
      const first = calls.length;
      await call("slack", "slack_read_channel", { channel_id: channel, limit: 1, latest: String(Date.parse(run.until) / 1000) });
      const probe = calls[first];
      if (probe?.tool === "slack.slack_read_channel" && (probe.args as Json).channel_id === channel) probe.purpose = "slack-channel-access";
    }
  } catch (cause) {
    for (const source of SOURCES) error(source, sourceError(cause));
  } finally {
    for (const source of SOURCES) budgets[source].dispose();
    await Promise.all(SOURCES.map(async source => { const c = connections?.[source]; if (c && !("error" in c)) await c.close().catch(() => {}); }));
  }
  const reports = SOURCES.map(source => {
    const receipts = calls.filter(c => c.source === source && !recoveredCalls.has(c.ref)), good = receipts.filter(c => c.completed);
    const issues = problems[source];
    return normalizeMissingSlackReport({ source, status: (!good.length ? "unavailable" : issues.length ? "partial" : "complete") as SyncSubmit["reports"][number]["status"],
      detail: issues.length ? issues.join("\n").slice(0, 3800) : `Loaded by script: ${good.filter(c => c.read).length} full threads/messages/issues.`,
      callRefs: receipts.map(c => c.ref), paginationComplete: !issues.length, linkedTasksChecked: !issues.length,
      scanned: scanned[source], threadsRead: good.filter(c => c.read).length,
    }, receipts);
  });
  return { version: 1, runId: run.id, startedAt: new Date(start).toISOString(), finishedAt: new Date().toISOString(), elapsedMs: Date.now() - start, calls, documents, reports, connectionAttempts };
}
