import { defaultSourceConfig, type SourceConfig } from "./source-config.js";
import { randomUUID } from "node:crypto";
import type { SyncRun, SyncSource, SyncSubmit } from "./contracts.js";
import type { TaskDossier } from "./core/types.js";
import type { SourceCall } from "./source-sync.js";
import { connectSources, sourceError, type SourceConnections } from "./source-connectors.js";

type Json = Record<string, any>;
export type SourceDocument = { ref: string; source: SyncSource; tool: string; args: Record<string, unknown>; content: string };
export type SourceExport = {
  version: 1; runId: string; startedAt: string; finishedAt: string; elapsedMs: number;
  calls: SourceCall[]; documents: SourceDocument[]; reports: SyncSubmit["reports"];
};
export type CollectionProgress = { source: SyncSource; calls: number; reads: number; detail: string };
export type CollectionOptions = {
  config?: SourceConfig;
  signal?: AbortSignal; connect?: (signal: AbortSignal) => Promise<SourceConnections>;
  onProgress?: (progress: CollectionProgress) => void;
  timeoutMs?: number; maxCalls?: number;
};
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
      if ((!lo && offset < doc.content.length) || size(envelope([{ ...doc, content: "", part: 999999, parts: 999999 }])) > SOURCE_PAGE_BYTES) throw new Error("Метаданные документа превышают размер страницы выгрузки.");
      chunks.push(doc.content.slice(offset, offset + lo)); offset += lo;
    } while (offset < doc.content.length);
    for (const [part, content] of chunks.entries()) {
      const value = { ...doc, content, part: part + 1, parts: chunks.length };
      if (size(envelope([...pages[pages.length - 1], value])) > SOURCE_PAGE_BYTES) pages.push([]);
      pages[pages.length - 1].push(value);
    }
  }
  if (!Number.isInteger(page) || page < 0 || page >= pages.length) throw new Error("Страница выгрузки не найдена.");
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
  const jira = [...new Set([...(text.match(/\b[A-Z][A-Z0-9]*-\d+\b/g) ?? []), ...[...text.matchAll(/[a-z0-9-]+\.atlassian\.net\/browse\/([A-Z][A-Z0-9]+-\d+)/g)].map(m => m[1])])];
  return { gmail: [...new Set(gmail)], slack: [...new Map(slack.map(s => [`${s.channel}:${s.ts}`, s])).values()], jira };
}
async function pool<T>(items: T[], work: (item: T) => Promise<void>, concurrency = 3) {
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => { while (index < items.length) await work(items[index++]); }));
}
function documentContent(source: SyncSource, data: Json, until: number): string {
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
  const signal = AbortSignal.any([options.signal ?? new AbortController().signal, AbortSignal.timeout(options.timeoutMs ?? 180000)]);
  const calls: SourceCall[] = [], documents: SourceDocument[] = [];
  const problems: Record<SyncSource, string[]> = { gmail: [], slack: [], jira: [] };
  const scanned = { gmail: 0, slack: 0, jira: 0 };
  const linked = sourceLinks(JSON.stringify(dossiers.filter(d => d.task.status === "open")));
  const pending = { gmail: new Set(linked.gmail), slack: new Map(linked.slack.map(s => [`${s.channel}:${s.ts}`, s])), jira: new Set(linked.jira) };
  const read = { gmail: new Set<string>(), slack: new Set<string>(), jira: new Set<string>() };
  let connections: SourceConnections;
  let bytes = 0, count = 0;
  const error = (source: SyncSource, message: string) => { if (!problems[source].includes(message)) problems[source].push(message); };
  const progress = (source: SyncSource, detail: string) => options.onProgress?.({ source, detail, calls: calls.filter(c => c.source === source).length, reads: calls.filter(c => c.source === source && c.read && c.completed).length });
  const addLinks = (text: string) => {
    const found = sourceLinks(text);
    found.gmail.forEach(id => pending.gmail.add(id)); found.jira.forEach(id => pending.jira.add(id));
    found.slack.forEach(s => pending.slack.set(`${s.channel}:${s.ts}`, s));
  };
  async function call(source: SyncSource, tool: string, args: Json, full = false): Promise<Json | null> {
    if (signal.aborted || count >= (options.maxCalls ?? 600) || bytes > 28 * 1024 * 1024) { error(source, "Достигнут лимит выгрузки; непроверенный интервал сохранён."); return null; }
    const connection = connections[source];
    if ("error" in connection) { error(source, connection.error); return null; }
    count++;
    const ref = `export:${run.id}:${randomUUID()}`;
    try {
      let result: unknown;
      for (let attempt = 0; ; attempt++) {
        try {
          result = await connection.call(tool, args, signal);
          const response = result as Json;
          if ((response?.isError || response?.statusCode >= 400) && /429|502|503|504|currently unavailable|temporarily unavailable|rate.limit|timed?\s*out|timeout|-32001/i.test(JSON.stringify(response))) throw new Error("Источник временно недоступен (503/429/timeout).");
          break;
        }
        catch (cause) {
          if (attempt >= 2 || signal.aborted || !/429|502|503|504|fetch failed|ECONNRESET|timed?\s*out|timeout|-32001/i.test(sourceError(cause))) throw cause;
          await new Promise<void>(resolve => { const t = setTimeout(resolve, (attempt + 1) * 1000); t.unref?.(); });
        }
      }
      const data = responseData(result), raw = result as Json;
      const output = receiptText(data);
      const shapeOk = !full || (source === "gmail" ? Array.isArray(data.messages) : source === "jira" ? Boolean(data.key && data.fields) : typeof data.messages === "string");
      const completed = !raw?.isError && !(raw?.statusCode >= 400) && !data.error && shapeOk;
      const size = Buffer.byteLength(output);
      const truncated = size > 3 * 1024 * 1024 || bytes + size > 32 * 1024 * 1024;
      bytes += size;
      calls.push({ ref, source, tool: `${source}.${tool}`, args, output: truncated ? output.slice(0, 1000) : output, completed: completed && !truncated, truncated, read: full });
      if (!completed || truncated) { error(source, `${tool}: ${truncated ? "слишком большой ответ" : !shapeOk ? "неизвестный формат полного треда/тикета" : sourceError(output).slice(0, 400)}`); return null; }
      if (full) { documents.push({ ref, source, tool, args, content: documentContent(source, data, Date.parse(run.until)) }); addLinks(output); }
      progress(source, full ? "Читаем полные треды и связанные задачи" : "Загружаем список изменений");
      return data;
    } catch (cause) {
      const message = signal.aborted ? "Выгрузка остановлена по времени или отменена." : sourceError(cause);
      calls.push({ ref, source, tool: `${source}.${tool}`, args, output: message, completed: false, truncated: false, read: full });
      error(source, `${tool}: ${message}`); progress(source, "Часть данных недоступна"); return null;
    }
  }
  async function pages(source: SyncSource, tool: string, args: Json, take: (data: Json) => number, tokenName: string, limit: number, full = false): Promise<void> {
    const tokens = new Set<string>();
    for (let page = 0; page < 100; page++) {
      const data = await call(source, tool, args, full); if (!data) return;
      const n = take(data), state = pageState(data, n, limit);
      if (state.complete) return;
      if (!state.token || tokens.has(state.token)) { error(source, `${tool}: нет подтверждённого конца пагинации.`); return; }
      tokens.add(state.token); args = { ...args, [tokenName]: state.token };
    }
    error(source, `${tool}: превышен лимит страниц.`);
  }
  async function gmailSearch(query: string) {
    await pages("gmail", "search_threads", { query, pageSize: 50, view: "THREAD_VIEW_MINIMAL" }, data => {
      if (!Array.isArray(data.threads)) { if (Object.keys(data).some(k => k !== "resultCountEstimate")) error("gmail", "Неизвестный формат поиска Gmail."); return 0; }
      for (const t of data.threads) { if (typeof t.id === "string") pending.gmail.add(t.id); }
      scanned.gmail += data.threads.length; return data.threads.length;
    }, "pageToken", 50);
  }
  async function gmail() {
    const since = Math.floor(Date.parse(run.ranges.gmail.since) / 1000 - 300), until = Math.floor(Date.parse(run.until) / 1000 + 1);
    await Promise.all([gmailSearch(`is:unread in:inbox after:${since} before:${until}`), gmailSearch(`after:${since} before:${until} ${config.mailFilters}`)]);
    // Stable task keys also find conversations whose dossier has no source URL.
    const keys = [...new Set(JSON.stringify(dossiers.filter(d => d.task.status === "open")).match(/\b(?:[A-Z][A-Z0-9]*-\d+|SO\d{5,}|E\d{6,}|Q-\d+)\b/g) ?? [])];
    for (let i = 0; i < keys.length; i += 25) await gmailSearch(`after:${since} before:${until} {${keys.slice(i, i + 25).join(" ")}}`);
    await readGmail();
  }
  async function readGmail() {
    await pool([...pending.gmail].filter(id => !read.gmail.has(id)), async id => {
      read.gmail.add(id);
      const data = await call("gmail", "get_thread", { threadId: id, messageFormat: "PLAIN_TEXT" }, true);
      if (data && !Array.isArray(data.messages)) error("gmail", `Не прочитаны сообщения треда ${id}.`);
    }, 4);
  }
  async function slack() {
    const after = String(Math.floor(Date.parse(run.ranges.slack.since) / 1000 - 300)), before = String(Date.parse(run.until) / 1000);
    await pool(["is:dm", "is:mpim", "to:me", ...config.slackChannels.map(c => `in:${c}`)], async query => {
      await pages("slack", "slack_search_public_and_private", { query, after, before, limit: 20, include_context: false, include_bots: true, sort: "timestamp" }, data => {
        const text = String(data.results ?? data.text ?? ""); addLinks(text);
        const n = [...text.matchAll(/### Result \d+/g)].length; scanned.slack += n;
        if ((!text && typeof data.results !== "string") || (!n && !/no (?:results|messages)|0 results|no matches|messages \(0/i.test(text) && text.trim())) error("slack", "Неизвестный формат поисковой выдачи Slack.");
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
      await pages("slack", "slack_read_thread", { channel_id: s.channel, message_ts: s.ts, limit: 1000, latest: String(Date.parse(run.until) / 1000) }, data => {
        const text = String(data.messages ?? "");
        if (!text && !/no more|no thread/i.test(String(data.pagination_info ?? ""))) error("slack", `Не прочитан тред ${s.channel}:${s.ts}.`);
        return [...text.matchAll(/Message[_ ]TS:/gi)].length;
      }, "cursor", 1000, true);
    }, 4);
  }
  async function jira() {
    // JQL dates use the Jira user's timezone, which can differ from the Mac.
    // Expand by a day, then filter returned ISO timestamps exactly in code.
    const sinceMs = Date.parse(run.ranges.jira.since) - 300000, untilMs = Date.parse(run.until);
    const since = new Date(sinceMs - 86400000).toISOString().slice(0, 10), until = new Date(untilMs + 2 * 86400000).toISOString().slice(0, 10);
    const jql = `updated >= "${since}" AND updated <= "${until}" AND (${config.jiraScope}) ORDER BY updated DESC`;
    await pages("jira", "searchJiraIssuesUsingJql", { cloudId: config.jiraSite, jql, maxResults: 100, fields: ["summary", "status", "updated"], responseContentFormat: "markdown" }, data => {
      if (!Array.isArray(data.issues)) { error("jira", "Неизвестный формат поиска Jira."); return 0; }
      for (const issue of data.issues) {
        const at = Date.parse(issue.fields?.updated);
        if (!Number.isFinite(at)) error("jira", `Нет времени обновления ${issue.key}.`);
        if (Number.isFinite(at) && at >= sinceMs && at <= untilMs && typeof issue.key === "string") pending.jira.add(issue.key);
      }
      scanned.jira += data.issues.length; return data.issues.length;
    }, "nextPageToken", 100);
    await readJira();
  }
  async function readJira() {
    await pool([...pending.jira].filter(id => !read.jira.has(id)), async id => {
      read.jira.add(id);
      const data = await call("jira", "getJiraIssue", { cloudId: config.jiraSite, issueIdOrKey: id, fields: ["summary", "status", "updated", "assignee", "priority", "description", "comment"], responseContentFormat: "markdown", updateHistory: false }, true);
      if (!data) return;
      if (!data.fields || !data.key) { error("jira", `Не прочитан тикет ${id}.`); return; }
      const c = data.fields.comment, comments = data.comments ?? c?.comments;
      if (!Array.isArray(comments) || c?.total > comments.length || c?.startAt > 0 || comments.length >= 100) error("jira", `${id}: коннектор не подтвердил полноту комментариев.`);
    });
  }
  try {
    connections = await (options.connect ?? ((s) => connectSources(s, config)))(signal);
    for (const source of SOURCES) if ("error" in connections[source]) error(source, (connections[source] as { error: string }).error);
    await Promise.all([gmail(), slack(), jira()]);
    // Resolve links crossing sources and links found inside thread bodies. Bound
    // expansion explicitly instead of silently treating skipped links as checked.
    for (let round = 0; round < 3; round++) {
      const before = read.gmail.size + read.slack.size + read.jira.size;
      await Promise.all([readGmail(), readSlack(), readJira()]);
      if (before === read.gmail.size + read.slack.size + read.jira.size || signal.aborted) break;
    }
    for (const source of SOURCES) if (pending[source].size > read[source].size) error(source, "Не дочитаны все связанные источники.");
  } catch (cause) {
    for (const source of SOURCES) error(source, sourceError(cause));
  } finally {
    await Promise.all(SOURCES.map(async source => { const c = connections?.[source]; if (c && !("error" in c)) await c.close().catch(() => {}); }));
  }
  const reports = SOURCES.map(source => {
    const receipts = calls.filter(c => c.source === source), good = receipts.filter(c => c.completed);
    const issues = problems[source];
    return { source, status: (!good.length ? "unavailable" : issues.length ? "partial" : "complete") as SyncSubmit["reports"][number]["status"],
      detail: issues.length ? issues.join("\n").slice(0, 3800) : `Загружено скриптом: ${good.filter(c => c.read).length} полных тредов/тикетов.`,
      callRefs: receipts.map(c => c.ref), paginationComplete: !issues.length, linkedTasksChecked: !issues.length,
      scanned: scanned[source], threadsRead: good.filter(c => c.read).length,
    };
  });
  return { version: 1, runId: run.id, startedAt: new Date(start).toISOString(), finishedAt: new Date().toISOString(), elapsedMs: Date.now() - start, calls, documents, reports };
}
