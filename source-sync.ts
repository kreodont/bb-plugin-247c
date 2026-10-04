import { SourceStorage, packSourceRequest } from "./source-storage.js";
import { isLiveTask } from "./task-status.js";
import { DAY_TIME_ZONE } from "./day-contracts.js";
import { DAY_REVIEW_INSTRUCTIONS } from "./agent-time.js";
import { partitionParts, pickChanges, receiptDraft, sourceParts } from "./proposal-parts.js";
import { jiraReferences, pullRequestReferences } from "./source-links.js";
import { mergeSyncDraft } from "./source-sync-merge.js";
import { defaultSourceConfig, type SourceConfig } from "./source-config.js";
import { randomUUID } from "node:crypto";
import { ThreadRouting } from "./thread-routing.js";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { nativeRequest, syncCandidateSchema, syncRunSchema, syncStartSchema, syncSubmitSchema, type SyncCandidate, type SyncDraft, type SyncRun, type SyncSource, type SyncStart, type SyncSubmit, type PartDecision } from "./contracts.js";
import type { ProposalEvidence, TaskDossier } from "./core/types.js";
import { ConflictError, PolicyError } from "./core/errors.js";
import { validateEvidence } from "./core/validation.js";
import { acceptedEvidence } from "./conversation.js";
import { digest, Repository } from "./repository.js";
import { syncAnalysisInstructions } from "./source-sync-prompt.js";
import { collectSources, sourceExportPage, type SourceExport } from "./source-collector.js";
import { analysisExport, needsDayAnalysis, planSourceAnalysis, rekeyAnalysisDocuments, sourceAnalysisSchema, type AnalysisWork, type SourceAnalysis } from "./source-analysis.js";

export const SYNC_SOURCES: SyncSource[] = ["gmail", "slack", "jira"];
export const SYNC_ACTIVE = new Set<SyncRun["status"]>(["starting", "working"]);
type Row = Record<string, unknown>;
type RunRequest = { input?: SyncStart; externalImport?: { path: string; sha256: string }; snapshots: TaskDossier[]; pendingCandidates?: SyncCandidate[]; submittedFingerprint?: string; submittedFingerprints?: string[]; submittedBatches?: string[]; dataPagesRead?: number[]; dayItemsRead?: string[]; incremental?: boolean; analysis?: SourceAnalysis };
export type SourceCall = { ref: string; source: SyncSource; tool: string; args: unknown; output: string; completed: boolean; truncated: boolean; read: boolean };
// Threaded replies omit task IDs. Prove their task URL through a successful
// parent-comment listing, matching structured IDs rather than quoted message text.
function replyBelongsToTask(call: SourceCall, calls: SourceCall[], taskId: string): boolean {
  if (call.source !== "clickup" || call.tool !== "clickup_get_threaded_comments" || !call.args || typeof call.args !== "object") return false;
  const args = call.args as Record<string, unknown>;
  if (typeof args.comment_id !== "string") return false;
  return calls.some(parent => {
    if (parent.source !== "clickup" || parent.tool !== "clickup_get_task_comments" || !parent.completed || !parent.read || parent.truncated || !parent.args || typeof parent.args !== "object") return false;
    const parentArgs = parent.args as Record<string, unknown>;
    if (parentArgs.task_id !== taskId || parentArgs.workspace_id !== args.workspace_id) return false;
    try {
      const raw = JSON.parse(parent.output.split("\n")[0]);
      const blocks = Array.isArray(raw.content) ? raw.content : [];
      return blocks.some((block: { type?: string; text?: string }) => {
        if (block.type !== "text" || !block.text) return false;
        try {
          const result = JSON.parse(block.text);
          return Array.isArray(result.comments) && result.comments.some((comment: { id?: unknown }) => String(comment.id) === args.comment_id);
        } catch { return false; }
      });
    } catch { return false; }
  });
}
const now = () => new Date().toISOString();
const normalize = (s: string) => s.trim().replace(/\s+/g, " ").toLocaleLowerCase();
function candidateDraft({ taskId, title, rationale, confidence, facts, changes }: SyncDraft): SyncDraft { return { taskId, title, rationale, confidence, facts, changes }; }

export function syncRanges(checkpoints: Record<string, string | null>, since: string | null, until: string, initialSince?: Record<string, string | null>): SyncRun["ranges"] {
  if (since && Date.parse(since) >= Date.parse(until)) throw new PolicyError("The start date must precede the check's start time.");
  return Object.fromEntries(SYNC_SOURCES.map((source) => [source, {
    since: since ? new Date(since).toISOString() : checkpoints[source] ?? initialSince?.[source] ?? new Date(Date.parse(until) - 86400000).toISOString(),
    previous: checkpoints[source],
  }])) as SyncRun["ranges"];
}

// Only direct, read-only connector calls can substantiate imported evidence.
// Shell output, agent prose, search-tool discovery and 247C's own tools cannot.
export function callSource(name: string): SyncSource | null {
  if (!/(search|read|get|fetch|list)/i.test(name) || /(send|create|update|delete|write|modify|c247|tool_search)/i.test(name)) return null;
  if (/gmail/i.test(name)) return "gmail";
  if (/slack/i.test(name)) return "slack";
  if (/jira/i.test(name) && /jira|atlassian/i.test(name)) return "jira";
  return null;
}

export function decodedText(raw: string): string {
  const strings: string[] = [raw];
  function visit(value: unknown, depth: number) {
    if (depth > 15) return;
    if (typeof value === "string") {
      strings.push(value);
      if (/^[\s]*[\[{]/.test(value)) { try { visit(JSON.parse(value), depth + 1); } catch { /* Plain text. */ } }
    } else if (Array.isArray(value)) value.forEach((item) => visit(item, depth + 1));
    else if (value && typeof value === "object") Object.values(value).forEach((item) => visit(item, depth + 1));
  }
  try { visit(JSON.parse(raw), 0); } catch { /* Plain text connector result. */ }
  return strings.join("\n");
}

export async function readSourceCalls(bb: BbPluginApi, threadId: string): Promise<SourceCall[]> {
  const calls = new Map<string, SourceCall>();
  let size = 0, afterSeq = 0, limit = 20;
  // The timeline is a presentation with a 32K output cap. The public raw-event
  // endpoint hydrates retained outputs; it also preserves the MCP server name.
  for (let pageNumber = 0; pageNumber < 1000; pageNumber++) {
    let page: Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["events"]["list"]>>;
    try { page = await bb.sdk.threads.events.list({ threadId, afterSeq: String(afterSeq), order: "asc", limit: String(limit), types: ["item/completed"] }); }
    catch (error) {
      if (limit > 1 && /413|8 MiB|event_data_too_large/i.test(String(error))) { limit = 1; continue; }
      throw error;
    }
    for (const event of page) {
      if (event.type !== "item/completed" || event.data.item.type !== "toolCall") continue;
      const item = event.data.item;
      const tool = [item.server, item.tool].filter(Boolean).join(".");
      const source = callSource(tool);
      if (!source) continue;
      const ref = `call:${digest(item.id).slice(0, 32)}`;
      if (calls.has(ref)) continue;
      const raw = typeof item.result === "string" ? item.result : JSON.stringify(item.result ?? "");
      const output = decodedText(raw);
      size += Buffer.byteLength(output);
      if (size > 32 * 1024 * 1024 || calls.size >= 2000) throw new PolicyError("Too much source data for one run. Split the check by date; checkpoints are unchanged.");
      calls.set(ref, { ref, source, tool, args: item.arguments ?? {}, output,
        completed: item.status === "completed" && !item.error && !/"isError"\s*:\s*true/.test(output),
        truncated: Boolean(item.truncation?.result || item.truncation?.resultText),
        read: source === "jira" ? /getJiraIssue|fetch.*issue/i.test(tool) : /(?:read|get|fetch).*(?:thread|replies|email)|(?:thread|replies).*(?:read|get|fetch)/i.test(tool),
      });
    }
    if (page.length < limit) return [...calls.values()];
    const next = Math.max(...page.map((event) => event.seq));
    if (next <= afterSeq) throw new PolicyError("Not all source call pages were read.");
    afterSeq = next;
  }
  throw new PolicyError("The check page limit was exceeded. Checkpoints are unchanged.");
}

function emptyDossier(title: string): TaskDossier {
  const timestamp = now();
  return { task: { id: "new", title, status: "open", revision: 0, createdAt: timestamp, updatedAt: timestamp },
    planning: { urgent: null, important: null, revision: 0 }, facts: [],
    projection: { taskId: "new", customer: null, summary: null, nextStep: null, openQuestions: [], blockers: [], artifacts: [], updatedAt: timestamp } };
}

export function syncEvidence(draft: SyncDraft, runId: string, dossier: TaskDossier): ProposalEvidence[] {
  return [...acceptedEvidence(dossier), ...draft.facts.map((fact, index) => ({
    ref: `fact:${index}`, kind: fact.kind, text: fact.text,
    source: `external-sync:${runId}`, sourceRef: fact.citations[0].url,
  }))];
}

export function validateSyncDraft(draft: SyncDraft, run: SyncRun, snapshots: TaskDossier[], calls: SourceCall[], carriedFacts: SyncDraft["facts"] = []): TaskDossier {
  const dossier = draft.taskId ? snapshots.find((d) => d.task.id === draft.taskId) : emptyDossier(draft.title);
  if (!dossier) throw new PolicyError(`taskId ${draft.taskId} is absent from the snapshot. Copy the exact id of the matching task from the snapshot; do not create a duplicate.`);
  const reopening = Boolean(draft.taskId && dossier.task.status === "done");
  if (draft.taskId && !isLiveTask(dossier.task.status) && (!reopening || draft.changes.status?.value !== "open" || !draft.changes.nextStep?.value)) {
    throw new PolicyError(`Task "${dossier.task.title}" (${draft.taskId}) has status=${dossier.task.status}. A done task requires a proposal to reopen it with a specific new next step; archived tasks are not updated automatically.`);
  }
  if (!draft.taskId && (!draft.changes.summary?.value || !draft.changes.nextStep?.value)) throw new PolicyError("A new task must have a summary and a specific next step.");
  if (!draft.taskId && draft.changes.status && draft.changes.status.value !== "open") throw new PolicyError("A new task must remain open.");
  if (!draft.taskId) {
    const urls = new Set(pullRequestReferences(JSON.stringify(draft)));
    const matches = snapshots.filter(d => pullRequestReferences(JSON.stringify(d)).some(url => urls.has(url)));
    if (matches.length) throw new PolicyError(`This pull request is already linked to existing tasks: ${matches.map(d => `${d.task.id} (${d.task.status}: ${d.task.title})`).join(", ")}. Reconcile it with the existing work instead of proposing a separate PR task.`);
  }
  const byRef = new Map(calls.map((call) => [call.ref, call]));
  const carried = new Set(carriedFacts.map(fact => digest(fact)));
  for (const fact of draft.facts) for (const citation of fact.citations) {
    // Only unchanged facts from explicitly selected, still-pending proposals
    // may retain a prior run's verified receipts. They do not prove coverage.
    if (carried.has(digest(fact))) continue;
    const call = byRef.get(citation.callRef);
    if (!call || call.source !== citation.source || !call.completed || !call.read) throw new PolicyError("The quote must reference a successful full source read in this run.");
    if (!call.output.includes(citation.quote)) throw new PolicyError("The quote is absent from the saved connector response. Copy it verbatim without translation or shortening.");
    const url = new URL(citation.url);
    const jiraSite = call.args && typeof call.args === "object" && "cloudId" in call.args ? call.args.cloudId : undefined;
    const proof = `${JSON.stringify(call.args)}\n${call.output}`;
    const pathIds = url.pathname.split("/").filter(Boolean).map(part => decodeURIComponent(part));
    const allowed = citation.source === "gmail" ? url.hostname === "mail.google.com"
      : citation.source === "slack" ? url.hostname === "slack.com" || url.hostname.endsWith(".slack.com")
      : citation.source === "jira" ? url.hostname.endsWith(".atlassian.net") && (typeof jiraSite !== "string" || !jiraSite.includes(".") || url.hostname === jiraSite)
      : citation.source === "teams" ? url.hostname === "teams.microsoft.com" && pathIds[0] === "l" && pathIds[1] === "message" && pathIds.length === 4 && pathIds.slice(2).every(part => proof.includes(part))
      : citation.source === "outlook" ? ["outlook.office.com", "outlook.office365.com", "outlook.live.com"].includes(url.hostname) && proof.includes(citation.url)
      : (url.hostname === "clickup.com" || url.hostname.endsWith(".clickup.com")) && (proof.includes(citation.url) || (pathIds[0] === "t" && (proof.includes(pathIds.at(-1)!) || replyBelongsToTask(call, calls, pathIds.at(-1)!))) || (pathIds[1] === "docs" && pathIds.length === 4 && pathIds.slice(2).every(part => proof.includes(part))));
    if (url.protocol !== "https:" || !allowed || url.username || url.password) throw new PolicyError("A direct HTTPS source link matching the saved connector response is required.");
    if (!`${JSON.stringify(call.args)}\n${call.output}`.includes(citation.messageId)) throw new PolicyError("The message identifier is absent from the source call.");
    if (Date.parse(citation.occurredAt) > Date.parse(run.until)) throw new PolicyError("The message is newer than the interval end. It will be included in the next run.");
  }
  // Every field needs a verified source fact, including preserved merge facts.
  for (const change of Object.values(draft.changes)) {
    if (!change?.evidenceRefs.some((ref) => /^fact:\d+$/.test(ref))) throw new PolicyError("Every change must reference a verified source finding (fact:N).");
  }
  validateEvidence(draft, dossier, syncEvidence(draft, run.id, dossier));
  if (reopening) {
    const fresh = (ref: string, kinds: string[], text?: string) => {
      const index = /^fact:(\d+)$/.exec(ref)?.[1], fact = index === undefined ? undefined : draft.facts[Number(index)];
      return fact && kinds.includes(fact.kind) && (text === undefined || normalize(fact.text) === normalize(text))
        && fact.citations.some(citation => Date.parse(citation.occurredAt) > Date.parse(dossier.task.updatedAt)
          && (carried.has(digest(fact)) || Date.parse(citation.occurredAt) >= Date.parse(run.ranges[citation.source]?.since ?? "") - 300000));
    };
    if (!draft.changes.status!.evidenceRefs.some(ref => fresh(ref, ["progress", "decision"]))
      || !draft.changes.nextStep!.evidenceRefs.some(ref => fresh(ref, ["explicit_next_step"], draft.changes.nextStep!.value!))) {
      throw new PolicyError("Reopening a done task requires a fresh source request for both status and nextStep, after the task's last saved change and within this check's interval, or unchanged evidence from its still-pending follow-up proposal. Old completed results cannot reopen it.");
    }
  }
  return dossier;
}

export function requiredSourceReads(dossiers: TaskDossier[], source: SyncSource, pending: SyncCandidate[] = []): string[] {
  const text = JSON.stringify([dossiers.filter((d) => isLiveTask(d.task.status)), pending]);
  if (source === "jira") return jiraReferences(text);
  if (source === "clickup") return [...new Set([...text.matchAll(/clickup\.com\/t\/(?:\d+\/)?([A-Za-z0-9_-]+)/g)].map(m => m[1]))];
  if (source === "teams" || source === "outlook") return [];
  const found = source === "gmail"
    ? [...text.matchAll(/mail\.google\.com[^\s"\\]*\/(?:#|%23)(?:all|inbox|sent|label\/[^/]+)\/([a-f0-9]{10,32})\b/g)].map((m) => m[1])
    : [...text.matchAll(/slack\.com\/archives\/[A-Z0-9]+\/p(\d{10})(\d{6})/g)].map((m) => `${m[1]}.${m[2]}`);
  return [...new Set(found)];
}

function hasUnfetchedPage(call: SourceCall, selected: SourceCall[]): boolean {
  const tokens = [...call.output.matchAll(/"(?:nextPageToken|next_page_token|next_cursor|nextCursor)"\s*:\s*"([^"\s]+)"/g)].map((m) => m[1]);
  function suppliedTokens(args: unknown): string[] {
    if (!args || typeof args !== "object") return [];
    return Object.entries(args).flatMap(([key, value]) => /^(?:pageToken|page_token|nextPageToken|next_page_token|cursor|next_cursor|nextCursor)$/i.test(key) && typeof value === "string" ? [value] : suppliedTokens(value));
  }
  return tokens.some((token) => !selected.some((other) => other.ref !== call.ref && other.tool === call.tool && other.completed && suppliedTokens(other.args).includes(token)));
}

export function validateSyncReports(reports: SyncSubmit["reports"], calls: SourceCall[], snapshots: TaskDossier[] = [], pending: SyncCandidate[] = []): SyncSubmit["reports"] {
  const byRef = new Map(calls.map((call) => [call.ref, call]));
  return reports.map((report) => {
    const selected = [...new Set(report.callRefs)].map((ref) => {
      const call = byRef.get(ref);
      if (!call || call.source !== report.source) throw new PolicyError("The source status references an unknown call.");
      return call;
    });
    const live = selected.filter((call) => call.completed);
    const queries = live.filter((call) => /search|list|filter_tasks/i.test(call.tool));
    const problems: string[] = [];
    if (report.status === "complete") {
      if (!queries.length) problems.push("no successful search");
      if (report.source === "gmail" && (queries.length < 2 || !queries.some((call) => /is:unread/.test(JSON.stringify(call.args))))) problems.push("both Gmail searches were not confirmed");
      if (!report.paginationComplete) problems.push("pagination is incomplete");
      if (!report.linkedTasksChecked) problems.push("open task links were not checked");
      if (report.scanned > 0 && !live.some((call) => call.read)) problems.push("no thread or Jira comment reads");
      if (selected.some((call) => !call.completed || call.truncated)) problems.push("an error or truncated response is present");
      if (selected.some((call) => hasUnfetchedPage(call, selected))) problems.push("the next source page was not read");
      const missing = requiredSourceReads(snapshots, report.source, pending).filter((id) => !live.some((call) => call.read && `${JSON.stringify(call.args)}\n${call.output}`.includes(id)));
      if (missing.length) problems.push(`linked threads/issues were not read: ${missing.slice(0, 10).join(", ")}${missing.length > 10 ? "…" : ""}`);
    }
    return { ...report, callRefs: selected.map((call) => call.ref), threadsRead: live.filter((call) => call.read).length,
      ...(problems.length ? { status: "partial" as const, detail: `${report.detail}
Incomplete check: ${problems.join("; ")}.`.slice(0, 4000) } : {}) };
  });
}

export class SourceSyncStore {
  readonly storage: SourceStorage;
  constructor(readonly repo: Repository) { this.storage = new SourceStorage(repo.db); }
  run(id: string): SyncRun {
    const row = this.repo.db.prepare("SELECT value_json FROM source_sync_runs WHERE id=?").get(id) as Row | undefined;
    if (!row) throw new PolicyError("Update check not found.");
    return syncRunSchema.parse(JSON.parse(String(row.value_json)));
  }
  request(id: string): RunRequest { return this.storage.request<RunRequest>(id); }
  saveRequest(id: string, request: RunRequest) { this.storage.saveRequest(id, request); }
  export(id: string): SourceExport | null { return this.storage.export<SourceExport>(id); }
  saveExport(bundle: SourceExport) { this.storage.saveExport(bundle.runId, bundle); }
  analysisBaseline(): SourceAnalysis | undefined {
    const row = this.repo.db.prepare("SELECT id,request_json FROM source_sync_runs WHERE status IN ('completed','partial') AND json_extract(request_json,'$.incremental')=1 AND json_extract(request_json,'$.analysis') IS NOT NULL ORDER BY rowid DESC LIMIT 1").get() as { id: string; request_json: string } | undefined;
    const request: RunRequest | undefined = row ? JSON.parse(row.request_json) : undefined;
    const parsed = sourceAnalysisSchema.safeParse(request?.analysis);
    if (!parsed.success) return undefined;
    // An analyst may finish without reviewing some day items. Keep those
    // eligible next time, including when no estimate could be produced yet.
    const plan = parsed.data, read = new Set(request?.dayItemsRead ?? []);
    for (const id of plan.reviewItemIds) if (!read.has(id)) delete plan.dayWork[id];
    const bundle = row ? this.export(row.id) : null;
    return bundle ? rekeyAnalysisDocuments(plan, bundle) : plan;
  }
  recordDayReview(id: string, itemIds: string[]) {
    this.storage.patchMetadata(id, metadata => ({ ...metadata, dayItemsRead: [...new Set([...((metadata as RunRequest).dayItemsRead ?? []), ...itemIds])] }));
  }
  saveAnalysis(id: string, analysis: SourceAnalysis) {
    const parsed = sourceAnalysisSchema.parse(analysis);
    this.storage.patchMetadata(id, metadata => ({ ...metadata, analysis: parsed }));
  }
  analysisExport(id: string, bundle: SourceExport) {
    const plan = this.request(id).analysis;
    return analysisExport(bundle, plan ? sourceAnalysisSchema.parse(plan) : undefined);
  }
  recordDataPage(id: string, page: number) {
    this.storage.patchMetadata(id, metadata => ({ ...metadata, dataPagesRead: [...new Set([...((metadata as RunRequest).dataPagesRead ?? []), page])] }));
  }
  forThread(threadId: string): SyncRun | undefined {
    const row = this.repo.db.prepare("SELECT id FROM source_sync_runs WHERE thread_id=?").get(threadId) as Row | undefined;
    return row ? this.run(String(row.id)) : undefined;
  }
  active(): SyncRun[] {
    return (this.repo.db.prepare("SELECT id FROM source_sync_runs WHERE status IN ('starting','working')").all() as Row[]).map((row) => this.run(String(row.id)));
  }
  save(run: SyncRun): SyncRun {
    const value = syncRunSchema.parse(run);
    this.repo.db.prepare("UPDATE source_sync_runs SET status=?,thread_id=?,value_json=? WHERE id=?").run(value.status, value.threadId, JSON.stringify(value), value.id);
    this.repo.changed(); return value;
  }
  checkpoints(): Record<string, string | null> {
    const rows = this.repo.db.prepare("SELECT * FROM source_sync_checkpoints").all() as Row[];
    return Object.fromEntries([...new Set([...SYNC_SOURCES, ...rows.map(row => String(row.source))])].map((source) => [source, rows.find((row) => row.source === source)?.through ?? null])) as Record<string, string | null>;
  }
  initialSince(): Record<string, string | null> {
    const initial: Record<string, string | null> = Object.fromEntries(SYNC_SOURCES.map(source => [source, null]));
    for (const row of this.repo.db.prepare("SELECT value_json FROM source_sync_runs ORDER BY rowid").all() as Row[]) {
      const run = syncRunSchema.parse(JSON.parse(String(row.value_json)));
      for (const [source, range] of Object.entries(run.ranges)) initial[source] ??= range.since;
    }
    return initial;
  }
  candidate(id: string): SyncCandidate {
    const row = this.repo.db.prepare("SELECT value_json FROM source_sync_candidates WHERE id=?").get(id) as Row | undefined;
    if (!row) throw new PolicyError("Update proposal not found.");
    return { ...syncCandidateSchema.parse(JSON.parse(String(row.value_json))), ...this.repo.partReviewFields("source", id) };
  }
  candidates(): SyncCandidate[] {
    const candidates: SyncCandidate[] = []; let bytes = 0;
    for (const row of this.repo.db.prepare("SELECT value_json FROM source_sync_candidates ORDER BY (status='pending') DESC,rowid DESC LIMIT 300").all() as Row[]) {
      const raw = String(row.value_json); bytes += Buffer.byteLength(raw);
      if (candidates.length && bytes > 1024 * 1024) break;
      const candidate = syncCandidateSchema.parse(JSON.parse(raw));
      candidates.push({ ...candidate, ...this.repo.partReviewFields("source", candidate.id) });
    }
    return candidates;
  }
  pendingCandidates(): SyncCandidate[] {
    // The display list is capped; an analysis must see the complete backlog.
    return (this.repo.db.prepare("SELECT value_json FROM source_sync_candidates WHERE status='pending' ORDER BY rowid").all() as Row[])
      .map(row => syncCandidateSchema.parse(JSON.parse(String(row.value_json))));
  }
  state() {
    const runs = (this.repo.db.prepare("SELECT id FROM source_sync_runs ORDER BY rowid DESC LIMIT 30").all() as Row[]).map((row) => this.run(String(row.id)));
    const pending = Number((this.repo.db.prepare("SELECT count(*) AS n FROM source_sync_candidates WHERE status='pending'").get() as Row).n);
    const checkpoints = this.checkpoints();
    const ranges = syncRanges(checkpoints, null, now(), this.initialSince());
    return { runs, candidates: this.candidates(), pending, checkpoints, nextSince: { ...this.initialSince(), ...Object.fromEntries(Object.entries(checkpoints).filter(([, value]) => value !== null)), ...Object.fromEntries(SYNC_SOURCES.map((source) => [source, ranges[source].since])) } as Record<string, string> };
  }
  insert(input: SyncStart, fingerprint = digest(input), incremental = false): SyncRun {
    return this.repo.store.transaction(() => {
      if (this.active().length) throw new PolicyError("A check is already running. Wait for it to finish or stop it.");
      const list = this.repo.list(true);
      if (list.total > 500) throw new PolicyError("247C contains more than 500 tasks. A complete cross-check exceeds the limit for one run.");
      const snapshots = list.tasks.map((task) => this.repo.kernel.getDossier(task.id));
      const pendingCandidates = this.pendingCandidates();
      const until = now();
      const run: SyncRun = { id: input.requestId, status: "starting", threadId: null, provider: input.request.providerId, model: input.request.model,
        startedAt: until, until, finishedAt: null, manualSince: input.since, ranges: syncRanges(this.checkpoints(), input.since, until, this.initialSince()),
        reports: [], error: null, suggestions: 0, duplicates: 0, fingerprint };
      const request = packSourceRequest({ input, snapshots, pendingCandidates, incremental });
      this.repo.db.prepare("INSERT INTO source_sync_runs(id,status,thread_id,value_json,request_json,context_gzip) VALUES (?,?,?,?,?,?)").run(run.id, run.status, null, JSON.stringify(run), request.metadata, request.context);
      this.repo.changed(); return run;
    });
  }
  importResult(imported: { id: string; provider: string; model: string; startedAt: string; until: string;
    windows: Record<string, { since: string }>; taskRevisions: Record<string, number>; input: SyncSubmit;
    provenance: { path: string; sha256: string } }, calls: SourceCall[]): SyncRun {
    return this.repo.store.transaction(() => {
      if (this.active().length) throw new PolicyError("A check is already running. Retry the saved bundle after it finishes.");
      const list = this.repo.list(true);
      if (list.total > 500) throw new PolicyError("A complete task snapshot exceeds 500 tasks.");
      const snapshots = list.tasks.map(task => this.repo.kernel.getDossier(task.id));
      for (const draft of imported.input.suggestions) if (draft.taskId) {
        const revision = imported.taskRevisions[draft.taskId];
        if (revision === undefined) throw new PolicyError("The collector must supply the task revision used for analysis.");
        this.repo.assertCurrent(draft.taskId, revision, false);
      }
      const checkpoints = this.checkpoints();
      const run: SyncRun = { id: imported.id, status: "working", threadId: null, provider: imported.provider, model: imported.model,
        startedAt: imported.startedAt, until: imported.until, finishedAt: null, manualSince: null,
        ranges: Object.fromEntries(Object.entries(imported.windows).map(([source, range]) => [source, { since: range.since, previous: checkpoints[source] ?? null }])),
        reports: [], error: null, suggestions: 0, duplicates: 0, fingerprint: imported.provenance.sha256 };
      const request = packSourceRequest({ externalImport: imported.provenance, snapshots, pendingCandidates: this.pendingCandidates() });
      this.repo.db.prepare("INSERT INTO source_sync_runs(id,status,thread_id,value_json,request_json,context_gzip) VALUES (?,?,?,?,?,?)").run(run.id, run.status, null, JSON.stringify(run), request.metadata, request.context);
      // Persist the verified connector data with the native run for provenance.
      this.saveExport({ version: 1, runId: run.id, startedAt: run.startedAt, finishedAt: now(), elapsedMs: 0, calls, documents: [], reports: imported.input.reports });
      return this.submit(run.id, imported.input, calls);
    });
  }
  submit(id: string, input: SyncSubmit, calls: SourceCall[], options: { finalize?: boolean; supplement?: boolean } = {}): SyncRun {
    return this.repo.store.transaction(() => {
      const run = this.run(id), request = this.request(id);
      const finalize = options.finalize ?? true, supplement = options.supplement ?? false;
      const fingerprint = digest({ input, finalize, supplement });
      if (request.submittedFingerprints?.includes(fingerprint) || (!supplement && finalize && request.submittedFingerprint === digest(input))) return run;
      if (supplement ? !["completed", "partial"].includes(run.status) : !SYNC_ACTIVE.has(run.status)) throw new PolicyError("The check has already finished. Its result cannot be changed.");
      if ((request.submittedFingerprints?.length ?? 0) >= 101) throw new PolicyError("The proposal batch limit for this run was reached.");
      if (JSON.stringify(input.reports.map(r => r.source).sort()) !== JSON.stringify(Object.keys(run.ranges).sort())) throw new PolicyError("Reports must cover exactly the sources in this run.");
      const reports = validateSyncReports(input.reports, calls, request.snapshots, request.pendingCandidates);
      const batchKey = digest(input.suggestions);
      const replayedBatch = request.submittedBatches?.includes(batchKey) ?? false;
      const suggestions = replayedBatch ? [] : input.suggestions;
      const targets = suggestions.map(s => s.taskId ?? "new:" + normalize(s.title));
      if (new Set(targets).size !== targets.length) throw new PolicyError("Combine findings for the same task into one proposal.");
      const prepared: { draft: SyncDraft; dossier: TaskDossier; parents: SyncCandidate[]; related: SyncCandidate[]; previousBatch?: SyncCandidate }[] = [];
      const errors: string[] = [], claimed = new Set<string>();
      for (const [index, raw] of suggestions.entries()) {
        try {
          const ids = raw.mergeCandidateIds ?? [];
          if (new Set(ids).size !== ids.length) throw new PolicyError("List each mergeCandidateId once.");
          const related = (this.repo.db.prepare("SELECT value_json FROM source_sync_candidates WHERE task_id IS ? OR json_extract(value_json,'$.resultTaskId')=?").all(raw.taskId, raw.taskId) as Row[])
            .map(row => syncCandidateSchema.parse(JSON.parse(String(row.value_json))))
            .filter(c => raw.taskId || normalize(c.title) === normalize(raw.title) || ids.includes(c.id));
          const previousBatch = related.find(c => c.runId === id && c.status === "pending");
          const parents = [...new Map([...ids.map(parentId => this.candidate(parentId)), ...(previousBatch ? [previousBatch] : [])].map(p => [p.id, p])).values()];
          for (const parent of parents) {
            if (parent.status !== "pending") throw new ConflictError("Proposal " + parent.id + " was already reviewed or superseded. Start a new check against the current proposals.");
            if (parent.runId !== id && !request.pendingCandidates?.some(p => p.id === parent.id)) throw new PolicyError("The merge proposal was not in this run's pending snapshot.");
            if (parent.taskId && parent.taskId !== raw.taskId) throw new PolicyError("Cannot merge proposals for different existing tasks.");
            if (claimed.has(parent.id)) throw new PolicyError("A pending proposal cannot be merged into two results in the same batch.");
            claimed.add(parent.id);
            if (!related.some(c => c.id === parent.id)) related.push(parent);
          }
          const snapshot = raw.taskId ? request.snapshots.find(d => d.task.id === raw.taskId) : emptyDossier(raw.title);
          if (!snapshot) throw new PolicyError("taskId " + raw.taskId + " is absent from the snapshot. Copy the exact matching task ID.");
          const draft = mergeSyncDraft(raw, parents, snapshot);
          const dossier = validateSyncDraft(draft, run, request.snapshots, calls, parents.flatMap(p => p.facts));
          if (draft.taskId && (supplement || parents.length || request.pendingCandidates)) this.repo.assertCurrent(draft.taskId, dossier.task.revision, false);
          prepared.push({ draft, dossier, parents, related, previousBatch });
        } catch (error) {
          if (!(error instanceof PolicyError) && !(error instanceof ConflictError)) throw error;
          errors.push(`suggestions[${index}] «${raw.title}» (${raw.taskId ?? "new task"}): ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (errors.length) throw new PolicyError(`The batch was not saved; previous proposals and the run are preserved. Correct the listed proposals and submit again.
${errors.join("\n").slice(0, 16000)}`);
      let duplicates = replayedBatch ? input.suggestions.length : 0;
      for (const { draft, dossier, parents, related, previousBatch } of prepared) {
        const eventIds = (c: SyncDraft) => c.facts.flatMap(f => f.citations.map(q => JSON.stringify([q.source, q.messageId, new Date(q.occurredAt).toISOString()])));
        const incoming = new Set(eventIds(draft));
        if (previousBatch && digest(candidateDraft(previousBatch)) === digest(candidateDraft(draft))) { duplicates++; continue; }
        if (supplement && parents.length) throw new PolicyError("Recovery can only add missing proposals. Existing pending proposals are unchanged.");
        const identityKey = digest([draft.taskId ?? ["new", normalize(draft.title)], draft.taskId ? dossier.task.revision : null, [...incoming].sort()]);
        const key = parents.length ? digest([identityKey, candidateDraft(draft), parents.map(p => p.id).sort()]) : identityKey;
        if (this.repo.db.prepare("SELECT id FROM source_sync_candidates WHERE fingerprint=?").get(key)) { duplicates++; continue; }
        const known = new Set(related.filter(c => (!previousBatch || c.runId !== id || c.status === "applied" || c.status === "rejected") &&
          (c.status === "applied" || (draft.taskId ? c.baseRevision === dossier.task.revision : c.taskId === null))).flatMap(eventIds));
        // One unchanged pending proposal needs no new approval identity. Several
        // missed proposals may be consolidated even without an additional event.
        if (parents.length < 2 && related.filter(c => c.status === "pending").length < 2 && incoming.size && [...incoming].every(event => known.has(event))) { duplicates++; continue; }
        if (!supplement && request.pendingCandidates) {
          const missing = related.filter(c => c.status === "pending" && !parents.some(p => p.id === c.id));
          if (missing.length) throw new PolicyError("Combine this finding with the pending proposals using mergeCandidateIds: " + missing.map(c => c.id).join(", ") + ". All previous findings and untouched fields will be preserved.");
        }
        if (draft.taskId && related.some(c => c.runId === id && ["applied", "rejected"].includes(c.status))) throw new PolicyError(`The proposal for task ${draft.taskId} has already been reviewed by the user. This run cannot replace it; start a new check with the current dossier.`);
        if (!draft.taskId && this.repo.list(true).tasks.some(d => normalize(d.title) === normalize(draft.title))) throw new ConflictError("A task with this title already exists. Start a new check and link the finding to that task.");
        const candidate = syncCandidateSchema.parse({ ...draft, id: randomUUID(), runId: run.id, baseRevision: draft.taskId ? dossier.task.revision : null,
          before: draft.taskId ? { title: dossier.task.title, status: dossier.task.status, urgent: dossier.planning.urgent, important: dossier.planning.important,
            customer: dossier.projection.customer ?? null, summary: dossier.projection.summary, nextStep: dossier.projection.nextStep, openQuestions: dossier.projection.openQuestions, blockers: dossier.projection.blockers, artifacts: dossier.projection.artifacts } : null,
          status: "pending", createdAt: now(), resolvedAt: null, proposalId: null, resultTaskId: null });
        this.repo.db.prepare("INSERT INTO source_sync_candidates VALUES (?,?,?,?,?,?)").run(candidate.id, run.id, candidate.taskId, candidate.status, key, JSON.stringify(candidate));
        for (const parent of parents) this.saveCandidate({ ...parent, status: "superseded", resolvedAt: now() });
        // Preserve recovery behavior for collectors started before merge snapshots.
        if (!request.pendingCandidates) for (const older of related) if (older.status === "pending" && older.baseRevision !== candidate.baseRevision && eventIds(older).every(event => incoming.has(event))) {
          this.saveCandidate({ ...older, status: "superseded", resolvedAt: now() });
        }
      }
      const retained = (this.repo.db.prepare("SELECT value_json FROM source_sync_candidates WHERE run_id=? AND status!='superseded'").all(id) as Row[]).map(row => candidateDraft(JSON.parse(String(row.value_json))));
      if (retained.length > 100 || Buffer.byteLength(JSON.stringify(retained)) > 1024 * 1024) throw new PolicyError("The run limit of 100 proposals or 1 MiB was exceeded. The last batch was not saved.");
      for (const report of finalize && !supplement ? reports : []) {
        const range = run.ranges[report.source];
        const contiguousFrom = range.previous ?? this.initialSince()[report.source];
        if (report.status !== "complete" || (contiguousFrom && range.since > contiguousFrom)) continue;
        this.repo.db.prepare("INSERT INTO source_sync_checkpoints VALUES (?,?) ON CONFLICT(source) DO UPDATE SET through=MAX(through,excluded.through)").run(report.source, run.until);
      }
      this.storage.patchMetadata(run.id, metadata => ({ ...metadata, submittedFingerprints: [...(request.submittedFingerprints ?? []), fingerprint], submittedBatches: [...(request.submittedBatches ?? []), batchKey] }));
      return this.save({ ...run, reports: supplement ? run.reports : reports, suggestions: retained.length, duplicates: run.duplicates + duplicates,
        ...(!supplement && finalize ? { finishedAt: now(), status: reports.every((r) => r.status === "complete") ? "completed" as const : "partial" as const } : {}) });
    });
  }
  private saveCandidate(candidate: SyncCandidate): SyncCandidate {
    this.repo.db.prepare("UPDATE source_sync_candidates SET status=?,task_id=?,value_json=? WHERE id=?").run(candidate.status, candidate.taskId ?? candidate.resultTaskId, JSON.stringify(candidate), candidate.id);
    return candidate;
  }
  accept(id: string, initialPriority?: { urgent: boolean; important: boolean }) {
    const result = this.repo.store.transaction(() => {
      const candidate = this.candidate(id);
      if (initialPriority && candidate.taskId) throw new PolicyError("Initial priority is only available for new tasks.");
      if (candidate.status === "applied") return this.repo.detail(candidate.resultTaskId!);
      if (candidate.status !== "pending") throw new PolicyError("This proposal was already rejected or superseded by a new check.");
      let taskId = candidate.taskId;
      if (taskId) this.repo.assertCurrent(taskId, candidate.baseRevision!, false);
      else {
        const duplicate = this.repo.list(true).tasks.find((task) => normalize(task.title) === normalize(candidate.title));
        if (duplicate) throw new ConflictError("This task was created while the check was running. Reject the duplicate and check again.");
        taskId = this.repo.create({ title: candidate.title, description: "", requestId: candidate.id }).id;
      }
      const dossier = this.repo.kernel.getDossier(taskId);
      const run = this.run(candidate.runId);
      const draft = receiptDraft(candidate.changes, dossier, syncEvidence(candidate, run.id, dossier));
      const proposal = this.repo.kernel.createProposal({ taskId, baseRevision: dossier.task.revision,
        model: `external-sync:${run.provider}:${run.model}`, output: { rationale: candidate.rationale, confidence: candidate.confidence, changes: draft.changes },
        additionalEvidence: draft.evidence, idempotencyKey: `sync:${candidate.id}` });
      this.repo.accept(proposal.id, dossier.task.revision);
      // These facts belong to this human-approved receipt, without extra revisions.
      const timestamp = now();
      for (const [index, fact] of candidate.facts.entries()) {
        if (candidate.recordFactIndexes && !candidate.recordFactIndexes.includes(index)) continue;
        const exists = (this.repo.db.prepare("SELECT kind,text FROM task_facts WHERE task_id=?").all(taskId) as Row[]).some((row) => row.kind === fact.kind && normalize(String(row.text)) === normalize(fact.text));
        if (exists) continue;
        const citation = fact.citations[0];
        this.repo.db.prepare("INSERT INTO task_facts VALUES (?,?,?,?,?,?,?,?)").run(`sync:${candidate.id}:${index}`, taskId, fact.kind, fact.text, `approved-external-sync:${proposal.id}`, citation.url, citation.occurredAt, timestamp);
      }
      if (initialPriority) this.repo.classify({ taskId, revision: this.repo.planning(taskId).revision, ...initialPriority });
      this.saveCandidate({ ...candidate, status: "applied", resolvedAt: timestamp, proposalId: proposal.id, resultTaskId: taskId });
      if (!candidate.taskId) this.repo.initializePrimarySource(taskId);
      return this.repo.detail(taskId);
    });
    this.repo.changed(); return result;
  }
  reviewParts(input: PartDecision) {
    const result = this.repo.request(input.requestId, { kind: "review-source-parts", input }, () => {
      const candidate = this.candidate(input.id);
      if (input.initialPriority && (candidate.taskId || input.decision !== "accept")) throw new PolicyError("Initial priority is only available when accepting a new task.");
      if (candidate.status !== "pending") throw new PolicyError("This proposal was already reviewed. Refresh the list.");
      if (candidate.baseRevision !== input.revision) throw new ConflictError("The proposal changed. Refresh the list.");
      if (candidate.taskId) this.repo.assertCurrent(candidate.taskId, candidate.baseRevision!, false);
      const split = partitionParts(sourceParts(candidate), input);
      const make = (parts: string[], suffix: string, taskId = candidate.taskId) => {
        const dossier = taskId ? this.repo.kernel.getDossier(taskId) : null;
        const child = syncCandidateSchema.parse({ ...candidate, id: randomUUID(), partReview: undefined,
          taskId, baseRevision: dossier?.task.revision ?? null,
          before: dossier ? { ...dossier.projection, ...dossier.planning, title: dossier.task.title, status: dossier.task.status } : null,
          title: dossier?.task.title ?? candidate.title, changes: pickChanges(candidate.changes, parts),
          recordFactIndexes: parts.filter(p => p.startsWith("fact:")).map(p => Number(p.slice(5))),
          createdAt: now(), resolvedAt: null, status: "pending", proposalId: null, resultTaskId: null });
        this.repo.db.prepare("INSERT INTO source_sync_candidates VALUES (?,?,?,?,?,?)").run(child.id, child.runId, child.taskId, child.status, `parts:${input.requestId}:${suffix}`, JSON.stringify(child));
        return child;
      };
      const accepted = split.accepted.length ? make(split.accepted, "accepted") : null;
      const taskId = accepted ? this.accept(accepted.id, input.initialPriority).task.id : candidate.taskId;
      const remaining = split.remaining.length ? make(split.remaining, "remaining", taskId) : null;
      this.saveCandidate({ ...candidate, status: "superseded", resolvedAt: now(), resultTaskId: taskId });
      this.repo.savePartReview("source", candidate.id, { ...split, acceptedId: accepted?.id ?? null, remainingId: remaining?.id ?? null, createdAt: now() });
      return { taskId, remainingId: remaining?.id ?? null };
    });
    this.repo.changed(); return result;
  }
  reject(id: string): SyncCandidate {
    const candidate = this.candidate(id);
    if (candidate.status === "applied") throw new PolicyError("The changes were already accepted. Use an undo proposal in the dossier to reverse them.");
    if (candidate.status === "rejected" || candidate.status === "superseded") return candidate;
    const result = this.saveCandidate({ ...candidate, status: "rejected", resolvedAt: now() });
    this.repo.changed(); return result;
  }
}

export class SourceSyncRuntime {
  readonly store: SourceSyncStore;
  private disposed = false;
  private processing = new Set<string>();
  private collectors = new Map<string, AbortController>();
  private companions = new Map<string, AbortController>();
  constructor(readonly bb: BbPluginApi, readonly repo: Repository, readonly onStart?: (signal: AbortSignal) => Promise<unknown>, readonly sourceConfiguration: () => Promise<SourceConfig> = async () => defaultSourceConfig, readonly threadRouting = new ThreadRouting(bb, async () => ""), readonly timeZone: () => string = () => DAY_TIME_ZONE,
    readonly analysisWork: () => Promise<AnalysisWork> = async () => ({ dayWork: {}, dayComplete: true, policy: "" })) { this.store = new SourceSyncStore(repo); }
  private launchTitle(id: string) { return `247C · updates · ${id}`; }
  private isLaunchTitle(title: string | null, id: string) { return title === this.launchTitle(id) || title === `247C · обновления · ${id}`; }
  resolveThread(threadId: string, title?: string | null): SyncRun | undefined {
    const bound = this.store.forThread(threadId);
    if (bound) return bound;
    const match = /^247C · (?:updates|обновления) · ([a-f0-9-]{36})$/.exec(title ?? "");
    if (match) { try { return this.store.run(match[1]); } catch { /* Unrelated thread. */ } }
    return undefined;
  }
  async created(thread: { id: string; title: string | null; originPluginId: string | null }) {
    if (thread.originPluginId !== this.bb.pluginId) return;
    const run = this.resolveThread(thread.id, thread.title);
    if (!run || run.threadId) return;
    this.store.save({ ...run, threadId: thread.id });
    if (!SYNC_ACTIVE.has(run.status)) await this.bb.sdk.threads.stop({ threadId: thread.id });
  }
  async start(raw: SyncStart, options: { incremental?: boolean } = {}): Promise<SyncRun> {
    const input = syncStartSchema.parse(raw);
    if (this.disposed) throw new PolicyError("The plugin is reloading.");
    const existing = this.repo.db.prepare("SELECT id FROM source_sync_runs WHERE id=?").get(input.requestId);
    if (existing) {
      const run = this.store.run(input.requestId);
      if (run.fingerprint !== digest(input)) throw new PolicyError("The launch key has already been used with different parameters.");
      return run;
    }
    if (input.request.input.some((i) => i.type !== "text")) throw new PolicyError("Check parameters must be text.");
    const routed = { ...input, request: await this.threadRouting.request(input.request) };
    const environment = routed.request.environment;
    const routing = environment.type === "reuse" ? { environmentId: environment.environmentId } : environment.type === "provider" ? { hostId: environment.machine.hostId } : environment.type === "host" && environment.hostId ? { hostId: environment.hostId } : {};
    const [providers, catalog] = await Promise.all([this.bb.sdk.providers.list(routing), this.bb.sdk.providers.models({ ...routing, providerId: input.request.providerId })]);
    if (this.disposed) throw new PolicyError("The plugin is reloading. Try starting again.");
    if (!providers.some((p) => p.id === input.request.providerId && p.available) || catalog.modelLoadError || !catalog.models.some((m) => m.model === input.request.model || m.id === input.request.model)) throw new PolicyError("The selected account or model is unavailable on this machine.");
    let run = this.store.insert(routed, digest(input), options.incremental);
    run = this.store.save({ ...run, collection: { phase: "collecting", calls: 0, reads: 0, elapsedMs: 0 } });
    const controller = new AbortController();
    this.collectors.set(run.id, controller); this.processing.add(run.id);
    // Meetings are deterministic calendar data and do not depend on the LLM
    // analysis, its account limits, or the Gmail/Slack/Jira export succeeding.
    if (this.onStart) {
      this.companions.set(run.id, controller);
      void this.onStart(controller.signal).catch(error => { if (!this.disposed && !controller.signal.aborted) this.bb.log.warn(`Calendar check: ${String(error)}`); })
        .finally(() => this.companions.delete(run.id));
    }
    // Return immediately so the panel can show collection progress and cancel.
    void this.collectAndLaunch(run, routed, controller);
    return run;
  }
  private async collectAndLaunch(initial: SyncRun, input: SyncStart, controller: AbortController) {
    const id = initial.id;
    const progress = new Map<SyncSource, { calls: number; reads: number }>();
    try {
      const config = await this.sourceConfiguration();
      const context = this.store.request(id);
      const bundle = await collectSources(initial, context.snapshots, { config, pendingCandidates: context.pendingCandidates, signal: controller.signal, onProgress: p => {
        if (this.disposed || controller.signal.aborted) return;
        progress.set(p.source, p);
        const run = this.store.run(id);
        if (!SYNC_ACTIVE.has(run.status)) return;
        this.store.save({ ...run, collection: { phase: "collecting", calls: [...progress.values()].reduce((n, v) => n + v.calls, 0), reads: [...progress.values()].reduce((n, v) => n + v.reads, 0), elapsedMs: Date.now() - Date.parse(initial.startedAt) } });
      } });
      if (this.disposed) return;
      this.store.saveExport(bundle);
      let run = this.store.run(id);
      if (!SYNC_ACTIVE.has(run.status) || controller.signal.aborted) return;
      run = this.store.save({ ...run, reports: validateSyncReports(bundle.reports, bundle.calls, context.snapshots, context.pendingCandidates), collection: { phase: "analyzing", calls: bundle.calls.length, reads: bundle.documents.length, elapsedMs: bundle.elapsedMs } });
      if (bundle.reports.every(r => r.status === "unavailable")) throw new PolicyError("The built-in source check could not load any configured sources. See this run’s source reports in Check history; analysis was not started.");
      const work = await this.analysisWork();
      if (this.disposed || controller.signal.aborted || !SYNC_ACTIVE.has(this.store.run(id).status)) return;
      const baseline = this.store.analysisBaseline();
      const plan = planSourceAnalysis(bundle, digest({ config, policy: work.policy, timeZone: this.timeZone() }), work, Boolean(context.incremental), baseline, context.snapshots);
      this.store.saveAnalysis(id, plan);
      const selected = analysisExport(bundle, plan);
      const modelSkipped = Boolean(context.incremental) && !selected.documents.length && !needsDayAnalysis(plan, baseline);
      run = this.store.save({ ...run, analysis: { documents: selected.documents.length, reusedDocuments: bundle.documents.length - selected.documents.length, modelSkipped } });
      if (modelSkipped) {
        this.store.submit(id, { reports: bundle.reports, suggestions: [] }, bundle.calls);
        return;
      }
      const prompt = DAY_REVIEW_INSTRUCTIONS + "\n\n" + syncAnalysisInstructions(run, context.snapshots, [...(context.pendingCandidates ?? this.store.pendingCandidates()), ...this.store.candidates().filter(c => c.status !== "pending")], selected, config, this.timeZone());
      if (Buffer.byteLength(prompt) > 768 * 1024) throw new PolicyError("The task snapshot is too large for one analysis.");
      this.store.recordDataPage(id, 0);
      const request = nativeRequest(input.request);
      const thread = await this.bb.sdk.threads.spawn({ ...request, title: this.launchTitle(id), visibility: "visible", input: [...request.input, { type: "text", text: prompt, mentions: [], visibility: "agent-only" }] });
      if (this.disposed) return;
      run = this.store.save({ ...this.store.run(id), threadId: thread.id });
      if (!SYNC_ACTIVE.has(run.status) || controller.signal.aborted) { await this.bb.sdk.threads.stop({ threadId: thread.id }); return; }
      run = this.store.save({ ...run, status: "working" });
      await this.nameThread(run, thread);
    } catch (error) {
      if (this.disposed) return;
      try { await this.findThread(this.store.run(id)); } catch { /* Keep the original error. */ }
      const run = this.store.run(id);
      if (SYNC_ACTIVE.has(run.status)) this.store.save({ ...run, status: run.threadId ? "working" : "blocked", ...(run.threadId ? {} : { finishedAt: now(), error: error instanceof Error ? error.message : String(error) }) });
    } finally { this.processing.delete(id); this.collectors.delete(id); }
  }
  private async findThread(run: SyncRun) {
    if (this.store.run(run.id).threadId) return;
    for (let offset = 0; offset < 2000; offset += 100) {
      const page = await this.bb.sdk.threads.list({ originPluginId: this.bb.pluginId, includeHidden: true, limit: 100, offset });
      if (this.disposed) return;
      const thread = page.find((t) => this.isLaunchTitle(t.title, run.id));
      if (thread) { this.store.save({ ...this.store.run(run.id), threadId: thread.id }); return; }
      if (page.length < 100) return;
    }
    throw new PolicyError("Could not unambiguously recover the check launch.");
  }
  private async nameThread(run: SyncRun, thread: { id: string; title: string | null; originPluginId: string | null }) {
    if (this.disposed || thread.originPluginId !== this.bb.pluginId || !this.isLaunchTitle(thread.title, run.id)) return;
    try {
      const label = new Intl.DateTimeFormat("en-GB", { timeZone: this.timeZone(), day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(run.startedAt));
      await this.bb.sdk.threads.update({ threadId: thread.id, title: `247C · Updates · ${label}` });
    } catch (error) { if (!this.disposed) this.bb.log.warn(`Could not name source collector: ${String(error)}`); }
  }
  private caller(threadId: string): SyncRun {
    const run = this.store.forThread(threadId);
    if (!run) throw new PolicyError("This tool is available only to the 247C update collector.");
    return run;
  }
  async audit(threadId: string) {
    const run = this.caller(threadId);
    const calls = run.collection ? this.store.export(run.id)?.calls ?? [] : await readSourceCalls(this.bb, threadId);
    return { runId: run.id, ranges: run.ranges, until: run.until, calls: calls.map(({ output, ...call }) => ({ ...call, outputPreview: output.slice(0, 600), chars: output.length })) };
  }
  data(threadId: string, page: number) {
    const run = this.caller(threadId), bundle = this.store.export(run.id);
    if (!bundle) throw new PolicyError("This run has no saved export.");
    const result = sourceExportPage(this.store.analysisExport(run.id, bundle), page);
    this.store.recordDataPage(run.id, page);
    return result;
  }
  context(threadId: string, page: number, ref?: string, query = "") {
    const run = this.caller(threadId), bundle = this.store.export(run.id);
    if (!bundle) throw new PolicyError("This run has no saved export.");
    if (ref) {
      const doc = bundle.documents.find(doc => doc.ref === ref);
      if (!doc) throw new PolicyError("Document not found in this run's export.");
      return sourceExportPage({ ...bundle, documents: [doc] }, page);
    }
    const docs = bundle.documents.filter(doc => JSON.stringify([doc.source, doc.args, doc.content]).toLocaleLowerCase().includes(query.toLocaleLowerCase()));
    const offset = page * 20;
    return { runId: run.id, documents: docs.slice(offset, offset + 20).map(doc => ({ ref: doc.ref, source: doc.source, tool: doc.tool, arguments: JSON.stringify(doc.args).slice(0, 1500) })), nextPage: offset + 20 < docs.length ? page + 1 : null };
  }
  async submit(threadId: string, raw: unknown) {
    const run = this.caller(threadId);
    const bundle = run.collection ? this.store.export(run.id) : null;
    const { finalize: requestedFinalize, ...payload } = raw as { finalize?: boolean; [key: string]: unknown };
    const finalize = requestedFinalize ?? !bundle;
    const input = syncSubmitSchema.parse(bundle ? { ...payload, reports: bundle.reports } : payload);
    if (run.collection && !bundle) throw new PolicyError("No saved source export.");
    if (bundle) {
      const pages = sourceExportPage(this.store.analysisExport(run.id, bundle), 0).totalPages, read = new Set(this.store.request(run.id).dataPagesRead ?? []);
      const missing = Array.from({ length: pages }, (_, n) => n).filter(n => !read.has(n));
      if (missing.length) throw new PolicyError(`First read the export pages with c247_sync_data: ${missing.join(", ")}.`);
      // The model cannot upgrade a partial export to complete coverage.
    }
    const calls = bundle?.calls ?? await readSourceCalls(this.bb, threadId);
    if (this.disposed) throw new PolicyError("The plugin is reloading. Submit the result again.");
    const result = this.store.submit(run.id, input, calls, { finalize });
    return { run: { id: result.id, status: result.status, suggestions: result.suggestions, duplicates: result.duplicates }, canonicalTasksChanged: false,
      pendingProposals: this.repo.db.prepare("SELECT id,task_id AS taskId FROM source_sync_candidates WHERE run_id=? AND status='pending'").all(run.id),
      message: finalize ? "The check is complete. The user will apply proposals in the 247C panel." : "Batch saved; you can submit the remaining proposals. When finished, call c247_sync_submit with {suggestions:[],finalize:true}. Source checkpoints do not advance until completion. The user will apply proposals in the 247C panel." };
  }
  supplement(id: string, raw: unknown) {
    const bundle = this.store.export(id);
    if (!bundle) throw new PolicyError("Recovery requires a saved source export.");
    const input = syncSubmitSchema.parse({ suggestions: raw, reports: bundle.reports });
    const result = this.store.submit(id, input, bundle.calls, { supplement: true, finalize: false });
    return { runId: result.id, status: result.status, suggestions: result.suggestions, canonicalTasksChanged: false, checkpointsChanged: false };
  }
  async cancel(id: string) {
    const run = this.store.run(id);
    if (!SYNC_ACTIVE.has(run.status)) return run;
    const cancelled = this.store.save({ ...run, status: "cancelled", finishedAt: now() });
    this.collectors.get(id)?.abort();
    this.companions.get(id)?.abort();
    if (run.threadId) await this.bb.sdk.threads.stop({ threadId: run.threadId });
    return cancelled;
  }
  async tick(id: string) {
    if (this.disposed || this.processing.has(id)) return;
    this.processing.add(id);
    try {
      let run = this.store.run(id);
      if (!SYNC_ACTIVE.has(run.status)) return;
      if (!run.threadId) { await this.findThread(run); run = this.store.run(id); }
      if (!run.threadId) throw new PolicyError("The check launch was interrupted before the chat was created. Start a new check.");
      const thread = await this.bb.sdk.threads.get({ threadId: run.threadId });
      if (this.disposed || !SYNC_ACTIVE.has(this.store.run(id).status)) return;
      if (["idle", "error", "failed", "archived", "deleted"].includes(thread.status)) throw new PolicyError("The collector stopped without a confirmed result. Open the check chat; source checkpoints are preserved.");
      if (Date.now() - Date.parse(run.startedAt) > 45 * 60000) { await this.cancel(id); return; }
      if (run.status === "starting") this.store.save({ ...run, status: "working" });
      await this.nameThread(run, thread);
    } catch (error) {
      if (!this.disposed && SYNC_ACTIVE.has(this.store.run(id).status)) this.store.save({ ...this.store.run(id), status: "blocked", finishedAt: now(), error: error instanceof Error ? error.message : String(error) });
    } finally { this.processing.delete(id); }
  }
  dispose() { this.disposed = true; for (const c of [...this.collectors.values(), ...this.companions.values()]) c.abort(); this.collectors.clear(); this.companions.clear(); }
}
