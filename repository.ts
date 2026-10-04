import { CUSTOMER_MIGRATION } from "./migration-compatibility.js";
import { reviewFailures } from "./review-failures.js";
import { TASK_STATUS_MIGRATION } from "./task-status-migration.js";
import { isLiveTask, statusNeedsStoppedSession } from "./task-status.js";
import { SessionTime } from "./session-time.js";
import { DayPlanning } from "./day-planning.js";
import { DAY_TIME_ZONE } from "./day-contracts.js";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type Database from "better-sqlite3";
import { Kernel } from "./core/kernel.js";
import { Store } from "./core/database.js";
import { ConflictError, PolicyError } from "./core/errors.js";
import type { FactKind, StewardProposalDraft, TaskRecord } from "./core/types.js";
import { extractionRefMap, partitionParts, pickChanges, pickExtraction, proposalParts, receiptDraft } from "./proposal-parts.js";
import { DAY_SCHEMA } from "./day-schema.js";
import { AGENT_TIME_SCHEMA } from "./agent-time-schema.js";
import { sourceUrl, taskSourceLinks, taskReferenceTerms } from "./task-sources.js";
import type { TaskSourceLink } from "./contracts.js";
import { sessionSchema, sessionUpdateSchema, transcriptSchema, knowledgeEntrySchema, fileKnowledgeEntrySchema, knowledgeImportSchema, syncCandidateSchema, type Dossier, type Session, type TaskCard, type Transcript, type Extraction, type KnowledgeEntry, type KnowledgeImport, type PartDecision, type PartReview } from "./contracts.js";

export const EXTRA_SCHEMA = [
  `CREATE TABLE planning (task_id TEXT PRIMARY KEY REFERENCES tasks(id), urgent INTEGER, important INTEGER, revision INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE requests (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result_json TEXT NOT NULL)`,
  `CREATE TABLE sessions (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), status TEXT NOT NULL, value_json TEXT NOT NULL, request_json TEXT NOT NULL)`,
  `CREATE INDEX session_task ON sessions(task_id)`,
  `CREATE UNIQUE INDEX one_active_session ON sessions(task_id) WHERE status IN ('starting','working','collecting','review_starting','reviewing','repair_starting')`,
  `CREATE TABLE session_events (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), kind TEXT NOT NULL, detail TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE INDEX session_event_order ON session_events(session_id, created_at)`,
  `CREATE TABLE session_threads (thread_id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), role TEXT NOT NULL, round INTEGER NOT NULL)`,
  `CREATE TABLE session_transcripts (session_id TEXT PRIMARY KEY REFERENCES sessions(id), value_json TEXT NOT NULL)`,
  `CREATE TABLE session_updates (proposal_id TEXT PRIMARY KEY REFERENCES proposals(id), session_id TEXT NOT NULL REFERENCES sessions(id), value_json TEXT NOT NULL)`,
  `CREATE TABLE knowledge_entries (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), proposal_id TEXT NOT NULL REFERENCES proposals(id), fingerprint TEXT NOT NULL UNIQUE, search_text TEXT NOT NULL, value_json TEXT NOT NULL)`,
  `CREATE TABLE closed_task_thread_archives (thread_id TEXT PRIMARY KEY REFERENCES session_threads(thread_id), task_revision INTEGER NOT NULL, archived_at TEXT, retry_at INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE knowledge_files (id TEXT PRIMARY KEY, source_key TEXT NOT NULL, relative_path TEXT NOT NULL, search_text TEXT NOT NULL, value_json TEXT NOT NULL, UNIQUE(source_key, relative_path))`,
  `CREATE TABLE source_sync_runs (id TEXT PRIMARY KEY, status TEXT NOT NULL, thread_id TEXT UNIQUE, value_json TEXT NOT NULL, request_json TEXT NOT NULL)`,
  `CREATE UNIQUE INDEX one_active_source_sync ON source_sync_runs((1)) WHERE status IN ('starting','working')`,
  `CREATE TABLE source_sync_checkpoints (source TEXT PRIMARY KEY, through TEXT NOT NULL)`,
  `CREATE TABLE source_sync_candidates (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES source_sync_runs(id), task_id TEXT REFERENCES tasks(id), status TEXT NOT NULL, fingerprint TEXT NOT NULL UNIQUE, value_json TEXT NOT NULL)`,
  `CREATE INDEX source_sync_candidate_task ON source_sync_candidates(task_id,status)`,
  `CREATE TABLE source_sync_exports (run_id TEXT PRIMARY KEY REFERENCES source_sync_runs(id), value_json TEXT NOT NULL)`,
  ...DAY_SCHEMA,
  `CREATE TABLE task_views (task_id TEXT PRIMARY KEY REFERENCES tasks(id), seen_revision INTEGER NOT NULL);
   INSERT INTO task_views(task_id,seen_revision) SELECT id,revision FROM tasks;`,
  `CREATE TABLE part_reviews (kind TEXT NOT NULL, id TEXT NOT NULL, value_json TEXT NOT NULL, PRIMARY KEY(kind,id))`,
  ...AGENT_TIME_SCHEMA,
  `CREATE TABLE task_source_preferences (task_id TEXT PRIMARY KEY REFERENCES tasks(id), url TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1)`,
  // Reserve index 34 for installations retaining the retired time migration at 33.
  `SELECT 1`,
  CUSTOMER_MIGRATION,
  TASK_STATUS_MIGRATION,
];
export const ACTIVE = new Set<Session["status"]>(["starting", "working", "collecting", "review_starting", "reviewing", "repair_starting"]);
export const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const now = () => new Date().toISOString();
type Row = Record<string, unknown>;

export class Repository {
  readonly store: Store;
  readonly kernel: Kernel;
  readonly sessionTime: SessionTime;
  constructor(readonly db: Database.Database, readonly changed: () => void, timeZone: () => string = () => DAY_TIME_ZONE) {
    this.store = new Store(db);
    this.kernel = new Kernel(this.store);
    this.sessionTime = new SessionTime(this, new DayPlanning(this, () => new Date(), timeZone));
  }

  request<T>(id: string, payload: unknown, execute: () => T): T {
    return this.store.transaction(() => {
      const fingerprint = digest(payload);
      const previous = this.db.prepare("SELECT * FROM requests WHERE id=?").get(id) as Row | undefined;
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new PolicyError("This request has already been used with different data.");
        return JSON.parse(String(previous.result_json)) as T;
      }
      const result = execute();
      this.db.prepare("INSERT INTO requests VALUES (?,?,?)").run(id, fingerprint, JSON.stringify(result));
      return result;
    });
  }

  create(input: { title: string; description: string; primarySourceUrl?: string | null; customer?: string | null; requestId: string }): TaskRecord {
    const result = this.request(input.requestId, { kind: "create", ...input }, () => {
      const url = input.primarySourceUrl ? sourceUrl(input.primarySourceUrl)?.href : null;
      if (input.primarySourceUrl && !url) throw new PolicyError("Invalid primary source URL.");
      const task = this.kernel.createTask({ title: input.title });
      this.db.prepare("INSERT INTO planning(task_id) VALUES (?)").run(task.id);
      if (input.description || url) this.kernel.appendFact({ taskId: task.id, kind: "description", text: input.description || `Task source: ${url}`, source: "human:bb", sourceRef: url ?? undefined });
      if (url) this.db.prepare("INSERT INTO task_source_preferences(task_id,url) VALUES (?,?)").run(task.id, url);
      if (input.customer != null) {
        if (!input.customer.trim() || input.customer.trim().length > 200) throw new PolicyError("Customer must contain 1 to 200 characters.");
        this.db.prepare("UPDATE task_projections SET customer=? WHERE task_id=?").run(input.customer.trim(), task.id);
        this.kernel.appendFact({ taskId: task.id, kind: "user_instruction", text: `Customer: ${input.customer.trim()}`, source: "human:bb-customer" });
      }
      return this.kernel.getTask(task.id);
    });
    this.changed();
    return result;
  }

  assertCurrent(taskId: string, revision: number, requireOpen = true) {
    const task = this.kernel.getTask(taskId);
    if (task.revision !== revision) throw new ConflictError("The dossier changed. Refresh it and check the new data.");
    if (requireOpen && !isLiveTask(task.status)) throw new PolicyError("The task is closed. Reopen it first.");
    return task;
  }

  note(input: { taskId: string; revision: number; kind: FactKind; text: string; requestId: string }) {
    const fact = this.request(input.requestId, { kind: "note", input }, () => {
      this.assertCurrent(input.taskId, input.revision);
      return this.kernel.appendFact({ taskId: input.taskId, kind: input.kind, text: input.text, source: "human:bb" });
    });
    this.changed();
    return fact;
  }

  customers(): string[] {
    return (this.db.prepare("SELECT customer FROM task_projections WHERE customer IS NOT NULL GROUP BY lower(customer) ORDER BY customer COLLATE NOCASE").all() as { customer: string }[]).map(row => row.customer);
  }

  setCustomer(input: { taskId: string; revision: number; customer: string | null; requestId: string }) {
    const result = this.request(input.requestId, { kind: "customer", ...input }, () => {
      this.assertCurrent(input.taskId, input.revision, false);
      const customer = input.customer?.trim() || null;
      if (customer && customer.length > 200) throw new PolicyError("Customer must be at most 200 characters.");
      if ((this.kernel.getDossier(input.taskId).projection.customer ?? null) === customer) return this.kernel.getTask(input.taskId);
      this.db.prepare("UPDATE task_projections SET customer=?,updated_at=? WHERE task_id=?").run(customer, now(), input.taskId);
      this.kernel.appendFact({ taskId: input.taskId, kind: "user_instruction", text: customer === null ? "Customer: not specified (manually cleared)." : `Customer: ${customer}`, source: "human:bb-customer" });
      return this.kernel.getTask(input.taskId);
    });
    this.changed(); return result;
  }

  planning(taskId: string) {
    return this.kernel.getPlanning(taskId);
  }

  classify(input: { taskId: string; revision: number; urgent: boolean | null; important: boolean | null }) {
    const result = this.store.transaction(() => {
      this.kernel.getTask(input.taskId);
      if (this.planning(input.taskId).revision !== input.revision) throw new ConflictError("Priority changed in another window. Refresh the dossier.");
      const previous = this.planning(input.taskId);
      if (previous.urgent === input.urgent && previous.important === input.important) return previous;
      this.db.prepare("INSERT OR IGNORE INTO planning(task_id) VALUES (?)").run(input.taskId);
      this.db.prepare("UPDATE planning SET urgent=?,important=?,revision=revision+1 WHERE task_id=?").run(input.urgent === null ? null : Number(input.urgent), input.important === null ? null : Number(input.important), input.taskId);
      // All canonical edits invalidate older proposals, including a priority
      // changed manually while a recorder was reading its snapshot.
      this.db.prepare("UPDATE tasks SET revision=revision+1,updated_at=? WHERE id=?").run(now(), input.taskId);
      this.db.prepare("INSERT INTO kernel_events(id,task_id,type,payload_json,created_at) VALUES (?,?,?,?,?)").run(randomUUID(), input.taskId, "planning.changed", JSON.stringify(input), now());
      return this.planning(input.taskId);
    });
    this.changed();
    return result;
  }

  status(taskId: string, status: TaskRecord["status"], revision: number) {
    if (statusNeedsStoppedSession(this.kernel.getTask(taskId).status, status) && this.active().some((s) => s.taskId === taskId)) throw new PolicyError("Stop the current work session first.");
    const task = this.kernel.setTaskStatus(taskId, status, revision);
    this.changed();
    return task;
  }

  pendingTotal(): number {
    if (!this.db.inTransaction) this.sessionTime.reconcile();
    return Number((this.db.prepare("SELECT (SELECT count(*) FROM proposals WHERE status IN ('pending','approved')) + (SELECT count(*) FROM source_sync_candidates WHERE status='pending') AS n").get() as Row).n);
  }
  list(history = false): { tasks: TaskCard[]; total: number; pendingTotal: number } {
    if (!this.db.inTransaction) this.sessionTime.reconcile();
    const failures = new Map(reviewFailures(this).failures.slice().reverse().map(failure => [failure.taskId, failure.sessionId]));
    const where = history ? "" : "WHERE t.status IN ('open','waiting')";
    const total = Number((this.db.prepare(`SELECT count(*) AS n FROM tasks t ${where}`).get() as Row).n);
    const tasks = (this.db.prepare(`SELECT t.*,p.summary,p.next_step,p.customer,v.seen_revision,
      ((SELECT count(*) FROM proposals x WHERE x.task_id=t.id AND x.status IN ('pending','approved')) +
       (SELECT count(*) FROM source_sync_candidates c WHERE c.task_id=t.id AND c.status='pending')) AS pending_count,
      (SELECT id FROM sessions s WHERE s.task_id=t.id AND s.status IN ('starting','working','collecting','review_starting','reviewing','repair_starting') LIMIT 1) AS active_session
      FROM tasks t JOIN task_projections p ON p.task_id=t.id LEFT JOIN task_views v ON v.task_id=t.id ${where} ORDER BY t.updated_at DESC,t.id LIMIT 500`).all() as Row[]).map((row) => ({
        ...this.kernel.getTask(String(row.id)), sourceReferences: taskReferenceTerms(this.kernel.getDossier(String(row.id)), this.kernel.listProposals(String(row.id)).filter(p => p.status === "applied").map(p => p.rationale)), failedReviewId: failures.get(String(row.id)) ?? null, unseen: row.seen_revision == null ? "new" as const : Number(row.seen_revision) < Number(row.revision) ? "updated" as const : null, planning: this.planning(String(row.id)), customer: row.customer == null ? null : String(row.customer), summary: row.summary === null ? null : String(row.summary), nextStep: row.next_step === null ? null : String(row.next_step), pendingCount: Number(row.pending_count), activeSession: row.active_session === null ? null : String(row.active_session),
      }));
    return { tasks, total, pendingTotal: this.pendingTotal() };
  }

  detail(taskId: string, sessionId?: string): Dossier {
    // A partial acceptance reads its dossier before retiring the original draft.
    // Do not reconcile that draft midway through the enclosing transaction.
    if (!this.db.inTransaction) this.sessionTime.reconcile(taskId);
    const linkedSession = sessionId ? this.session(sessionId) : null;
    if (linkedSession && linkedSession.taskId !== taskId) throw new PolicyError("The linked session belongs to a different task.");
    const dossier = this.kernel.getDossier(taskId);
    const drafts = this.kernel.listProposals(taskId);
    // A thread link must still work after the recent-history limits are reached.
    if (linkedSession?.proposalId && !drafts.some(p => p.id === linkedSession.proposalId)) {
      const proposal = this.kernel.getProposal(linkedSession.proposalId);
      if (proposal.taskId !== taskId) throw new PolicyError("The linked proposal belongs to a different task.");
      drafts.unshift(proposal);
    }
    const proposals = drafts.map((proposal) => {
      const receipt = proposal.status === "applied" ? this.kernel.getApplicationReceipt(proposal.id) : null;
      return { ...proposal, ...this.partReviewFields("proposal", proposal.id), evidence: this.kernel.proposalEvidence(proposal.id), receipt: receipt ? { id: receipt.id, beforeRevision: receipt.beforeRevision, afterRevision: receipt.afterRevision, createdAt: receipt.createdAt } : null };
    });
    const events = (this.db.prepare("SELECT id,type,created_at,payload_json FROM kernel_events WHERE task_id=? ORDER BY sequence DESC LIMIT 100").all(taskId) as Row[]).map((r) => ({ id: String(r.id), kind: String(r.type), createdAt: String(r.created_at), detail: String(r.payload_json) }));
    const sessionUpdates = (this.db.prepare("SELECT u.value_json FROM session_updates u JOIN proposals p ON p.id=u.proposal_id WHERE p.task_id=? ORDER BY p.created_at DESC LIMIT 200").all(taskId) as Row[]).map((r) => sessionUpdateSchema.parse(JSON.parse(String(r.value_json))));
    if (linkedSession?.proposalId && !sessionUpdates.some(u => u.proposalId === linkedSession.proposalId)) {
      const row = this.db.prepare("SELECT value_json FROM session_updates WHERE proposal_id=? AND session_id=?").get(linkedSession.proposalId, linkedSession.id) as Row | undefined;
      if (row) sessionUpdates.unshift(sessionUpdateSchema.parse(JSON.parse(String(row.value_json))));
    }
    const sessions = this.sessions(taskId);
    if (linkedSession && !sessions.some(s => s.id === linkedSession.id)) sessions.unshift(linkedSession);
    const syncUpdates = (this.db.prepare("SELECT value_json FROM source_sync_candidates WHERE task_id=? ORDER BY rowid DESC LIMIT 200").all(taskId) as Row[]).map((r) => syncCandidateSchema.parse(JSON.parse(String(r.value_json)))).map(candidate => ({ ...candidate, ...this.partReviewFields("source", candidate.id) }));
    // Read accepted provenance independently of the recent review-history limit,
    // so the original source remains visible after many later checks.
    const acceptedSources = this.db.prepare("SELECT value_json FROM source_sync_candidates WHERE task_id=? AND status='applied' ORDER BY rowid").iterate(taskId) as Iterable<{ value_json: string }>;
    function* sources() { for (const row of acceptedSources) yield syncCandidateSchema.parse(JSON.parse(row.value_json)); }
    const sourceLinks = taskSourceLinks({ ...dossier, proposals }, sources());
    return { ...dossier, planning: this.planning(taskId), proposals, sessions, events, brief: this.kernel.prepareBrief(taskId).markdown, sessionUpdates, syncUpdates, sourceLinks, ...this.sourceSelection(taskId, sourceLinks) };
  }

  sourceSelection(taskId: string, links: TaskSourceLink[]) {
    const saved = this.db.prepare("SELECT url,revision FROM task_source_preferences WHERE task_id=?").get(taskId) as { url: string; revision: number } | undefined;
    return { primarySource: links.find(link => link.url === saved?.url) ?? links[0] ?? null, sourceRevision: saved?.revision ?? 0 };
  }

  initializePrimarySource(taskId: string) {
    const primary = this.detail(taskId).primarySource;
    if (primary) this.db.prepare("INSERT OR IGNORE INTO task_source_preferences(task_id,url) VALUES (?,?)").run(taskId, primary.url);
  }

  // Selecting an already accepted source is a navigation preference, independent
  // of task revisions and approvals. A stale window cannot overwrite a choice.
  setPrimarySource(input: { taskId: string; url: string; revision: number; requestId: string }) {
    const result = this.request(input.requestId, { kind: "primary-source", input }, () => {
      const dossier = this.detail(input.taskId);
      if (dossier.sourceRevision !== input.revision) throw new ConflictError("The primary source changed in another window. Refresh the task.");
      const url = sourceUrl(input.url)?.href;
      if (!url || !dossier.sourceLinks.some(link => link.url === url)) throw new PolicyError("Choose a source already accepted for this task.");
      this.db.prepare(`INSERT INTO task_source_preferences(task_id,url) VALUES (?,?)
        ON CONFLICT(task_id) DO UPDATE SET url=excluded.url,revision=revision+1 WHERE url!=excluded.url`).run(input.taskId, url);
      return this.sourceSelection(input.taskId, dossier.sourceLinks);
    });
    this.changed();
    return result;
  }

  markSeen(taskId: string, revision: number) {
    const current = this.kernel.getTask(taskId);
    if (!Number.isSafeInteger(revision) || revision < 0 || revision > current.revision) throw new PolicyError("Invalid viewed task revision.");
    const result = this.db.prepare(`INSERT INTO task_views(task_id,seen_revision) VALUES (?,?)
      ON CONFLICT(task_id) DO UPDATE SET seen_revision=MAX(seen_revision,excluded.seen_revision)
      WHERE seen_revision<excluded.seen_revision`).run(taskId, revision);
    if (result.changes) this.changed();
    return this.db.prepare("SELECT seen_revision AS seenRevision FROM task_views WHERE task_id=?").get(taskId) as { seenRevision: number };
  }

  partReview(kind: string, id: string): PartReview | undefined {
    const row = this.db.prepare("SELECT value_json FROM part_reviews WHERE kind=? AND id=?").get(kind, id) as { value_json: string } | undefined;
    return row ? JSON.parse(row.value_json) : undefined;
  }
  partReviewFields(kind: string, id: string): { partReview?: PartReview } {
    const partReview = this.partReview(kind, id);
    return partReview ? { partReview } : {};
  }
  savePartReview(kind: string, id: string, review: PartReview) {
    this.db.prepare("INSERT INTO part_reviews VALUES (?,?,?)").run(kind, id, JSON.stringify(review));
  }

  reviewParts(input: PartDecision) {
    const result = this.request(input.requestId, { kind: "review-parts", input }, () => {
      this.sessionTime.reconcile(this.kernel.getProposal(input.id).taskId);
      const proposal = this.kernel.getProposal(input.id);
      if (proposal.status === "rejected" && this.sessionTime.isOmittedOnly(input.id)) return { taskId: proposal.taskId, remainingId: null };
      if (proposal.status !== "pending") throw new PolicyError("This proposal was already reviewed. Refresh the list.");
      const task = this.assertCurrent(proposal.taskId, input.revision!, false);
      if (task.revision !== proposal.baseRevision) throw new ConflictError("The proposal is stale. Request a new review.");
      if (this.active().some(s => s.discussionProposalId === proposal.id)) throw new PolicyError("Finish discussing this review first.");
      const row = this.db.prepare("SELECT value_json FROM session_updates WHERE proposal_id=?").get(proposal.id) as { value_json: string } | undefined;
      const update = row ? sessionUpdateSchema.parse(JSON.parse(row.value_json)) : undefined;
      const all = proposalParts(proposal.changes, update?.extraction);
      // A stale browser may still submit the automatically omitted time part.
      // Validate its original selection, then remove only that obsolete part.
      if (update?.omittedReportedTime && input.parts.includes("reportedTime")) partitionParts([...all, "reportedTime"], input);
      const parts = update?.omittedReportedTime ? input.parts.filter(part => part !== "reportedTime") : input.parts;
      if (!parts.length && input.parts.length && update?.omittedReportedTime) return { taskId: task.id, remainingId: proposal.id };
      const split = partitionParts(all, { ...input, parts });
      const evidence = this.kernel.proposalEvidence(proposal.id);
      const make = (parts: string[], suffix: string) => {
        const extraction = update ? pickExtraction(update.extraction, parts, proposal.id) : undefined;
        const picked = extraction ? extraction.changes ?? {} : pickChanges(proposal.changes, parts);
        const refs = update ? extractionRefMap(update.extraction, parts, proposal.id) : new Map<string, string>();
        const draft = receiptDraft(picked, this.kernel.getDossier(task.id), evidence.map(e => ({ ...e, ref: refs.get(e.ref) ?? e.ref })));
        const child = this.kernel.createProposal({ taskId: task.id, baseRevision: this.kernel.getTask(task.id).revision,
          model: proposal.model, output: { rationale: proposal.rationale, confidence: proposal.confidence, changes: draft.changes },
          additionalEvidence: draft.evidence, idempotencyKey: `parts:${input.requestId}:${suffix}` });
        if (update && extraction) this.db.prepare("INSERT INTO session_updates VALUES (?,?,?)").run(child.id, update.sessionId, JSON.stringify({ ...update, proposalId: child.id, extraction }));
        return child;
      };
      // The original draft and its evidence remain intact in history. Only exact
      // selected subsets receive approvals; the rest get a fresh pending identity.
      const accepted = split.accepted.length ? make(split.accepted, "accepted") : null;
      if (accepted) this.accept(accepted.id, task.revision);
      const remaining = split.remaining.length ? make(split.remaining, "remaining") : null;
      this.kernel.rejectProposal(proposal.id);
      for (const session of this.sessions(task.id)) if (session.proposalId === proposal.id) {
        this.saveSession({ ...session, proposalId: remaining?.id ?? accepted?.id ?? proposal.id,
          baseRevision: remaining?.baseRevision ?? session.baseRevision,
          acceptedPartProposalIds: [...(session.acceptedPartProposalIds ?? []), ...(accepted ? [accepted.id] : [])],
          ...(update ? { extraction: remaining ? pickExtraction(update.extraction, split.remaining, proposal.id) : accepted ? pickExtraction(update.extraction, split.accepted, proposal.id) : update.extraction } : {}),
          status: remaining ? "awaiting_approval" : accepted || session.acceptedPartProposalIds?.length ? "applied" : "rejected" });
      }
      this.savePartReview("proposal", proposal.id, { ...split, acceptedId: accepted?.id ?? null, remainingId: remaining?.id ?? null, createdAt: now() });
      return { taskId: task.id, remainingId: remaining?.id ?? null };
    });
    this.changed(); return result;
  }

  propose(input: { taskId: string; revision: number; draft: StewardProposalDraft; requestId: string }, model: string) {
    const proposal = this.request(input.requestId, { kind: "propose", input, model }, () => {
      this.assertCurrent(input.taskId, input.revision, false);
      return this.kernel.createProposal({ taskId: input.taskId, baseRevision: input.revision, model, output: input.draft, idempotencyKey: input.requestId });
    });
    this.changed();
    return proposal;
  }

  accept(proposalId: string, revision: number) {
    this.sessionTime.reconcile(this.kernel.getProposal(proposalId).taskId);
    const proposal = this.kernel.getProposal(proposalId);
    if (proposal.status === "applied") return this.detail(proposal.taskId);
    if (proposal.status === "rejected" && this.sessionTime.isOmittedOnly(proposalId)) return this.detail(proposal.taskId);
    this.store.transaction(() => {
      this.assertCurrent(proposal.taskId, revision, false);
      if (proposal.baseRevision !== revision) throw new ConflictError("The proposal targets an old dossier revision. A new result is required.");
      if (proposal.changes.status && statusNeedsStoppedSession(this.kernel.getTask(proposal.taskId).status, proposal.changes.status.value) && this.active().some((s) => s.taskId === proposal.taskId)) throw new PolicyError("Finish this task's current work session first.");
      if (this.active().some((s) => s.discussionProposalId === proposalId)) throw new PolicyError("Finish discussing this review first. Its revised proposal will appear after the session ends.");
      if (proposal.status === "pending") this.kernel.approveProposal(proposalId, "human:bb-panel");
      this.kernel.applyProposal(proposalId);
      this.applySessionUpdate(proposalId);
      for (const session of this.sessions(proposal.taskId)) if (session.proposalId === proposalId) this.saveSession({ ...session, status: "applied" });
    });
    this.changed();
    return this.detail(proposal.taskId);
  }

  reject(proposalId: string) {
    const proposal = this.kernel.getProposal(proposalId);
    if (proposal.status === "rejected") return proposal;
    const result = this.store.transaction(() => {
      const result = this.kernel.rejectProposal(proposalId);
      for (const session of this.sessions(proposal.taskId)) if (session.proposalId === proposalId) this.saveSession({ ...session, status: session.acceptedPartProposalIds?.length ? "applied" : "rejected" });
      return result;
    });
    this.changed();
    return result;
  }

  saveTranscript(sessionId: string, value: Transcript) {
    // A finished conversation is an immutable source, also used for retries.
    this.db.prepare("INSERT OR IGNORE INTO session_transcripts VALUES (?,?)").run(sessionId, JSON.stringify(transcriptSchema.parse(value)));
  }
  transcript(sessionId: string): Transcript | null {
    const row = this.db.prepare("SELECT value_json FROM session_transcripts WHERE session_id=?").get(sessionId) as Row | undefined;
    return row ? transcriptSchema.parse(JSON.parse(String(row.value_json))) : null;
  }
  saveSessionUpdate(session: Session, proposalId: string, extraction: Extraction) {
    const transcript = this.transcript(session.id);
    const cited = new Set(extraction.facts.flatMap((f) => f.citations.map((c) => c.messageRef)));
    const speakers = Object.fromEntries((transcript?.messages ?? []).filter((m) => cited.has(m.ref)).map((m) => [m.ref, m.role]));
    const sources = Object.fromEntries((transcript?.messages ?? []).filter((m) => cited.has(m.ref)).map((m) => [m.ref, m.source ?? { threadId: transcript!.threadId, messageRef: m.ref }]));
    const value = sessionUpdateSchema.parse({ proposalId, sessionId: session.id, threadId: session.workerThreadId, extraction, ...(session.reportedTimeContext ? { reportedTimeContext: session.reportedTimeContext } : {}), warnings: transcript?.warnings ?? [], speakers, sources });
    this.db.prepare("INSERT INTO session_updates VALUES (?,?,?)").run(proposalId, session.id, JSON.stringify(value));
  }
  private applySessionUpdate(proposalId: string) {
    const row = this.db.prepare("SELECT value_json FROM session_updates WHERE proposal_id=?").get(proposalId) as Row | undefined;
    if (!row) return;
    const update = sessionUpdateSchema.parse(JSON.parse(String(row.value_json)));
    const session = this.session(update.sessionId);
    const task = this.kernel.getTask(session.taskId);
    this.sessionTime.apply(update, task.id, proposalId);
    const timestamp = now();
    const existing = new Set(this.kernel.getDossier(task.id).facts.map((f) => digest([f.kind, f.text.trim().toLocaleLowerCase()])));
    // These inserts belong to the same approved application and revision as the
    // projection. Calling appendFact here would create extra, unreceipted revisions.
    for (const [index, fact] of update.extraction.facts.entries()) {
      const key = digest([fact.kind, fact.text.trim().toLocaleLowerCase()]);
      if (existing.has(key)) continue;
      existing.add(key);
      const citation = fact.citations[0];
      const source = update.sources[citation.messageRef] ?? { threadId: update.threadId, messageRef: citation.messageRef };
      this.db.prepare("INSERT INTO task_facts(id,task_id,kind,text,source,source_ref,occurred_at,created_at) VALUES (?,?,?,?,?,?,?,?)").run(
        `session:${session.id}:${proposalId}:fact:${index}`, task.id, fact.kind, fact.text,
        `approved-conversation:${proposalId}`, `bb-thread:${source.threadId}#${source.messageRef}`, session.finishedAt ?? timestamp, timestamp,
      );
    }
    for (const entry of update.extraction.knowledge) {
      const fingerprint = digest([entry.title.toLocaleLowerCase(), entry.body.toLocaleLowerCase()]);
      const value = knowledgeEntrySchema.parse({ ...entry, id: randomUUID(), taskId: task.id, taskTitle: task.title, sessionId: session.id, threadId: update.threadId, proposalId, createdAt: timestamp });
      this.db.prepare("INSERT OR IGNORE INTO knowledge_entries VALUES (?,?,?,?,?,?)").run(value.id, task.id, proposalId, fingerprint, [entry.title, entry.body, ...entry.tags].join("\n").toLocaleLowerCase(), JSON.stringify(value));
    }
    this.sessionEvent(session.id, "knowledge-applied", "Conversation records and knowledge were saved together with the dossier.", { proposalId, facts: update.extraction.facts.length, knowledge: update.extraction.knowledge.length });
  }

  importKnowledge(input: KnowledgeImport) {
    const parsed = knowledgeImportSchema.parse(input);
    const result = this.request(parsed.requestId, { kind: "import-knowledge", ...parsed }, () => {
      const source = { ...parsed.source, rootPath: path.posix.normalize(parsed.source.rootPath).replace(/\/$/, "") || "/" };
      const sourceKey = digest([source.hostId, source.rootPath]);
      const timestamp = now();
      const counts = { imported: 0, updated: 0, unchanged: 0, documents: parsed.documents.length };
      for (const document of parsed.documents) {
        const id = `file:${digest([sourceKey, document.relativePath])}`;
        const row = this.db.prepare("SELECT value_json FROM knowledge_files WHERE id=?").get(id) as Row | undefined;
        const previous = row ? fileKnowledgeEntrySchema.parse(JSON.parse(String(row.value_json))) : null;
        const value = fileKnowledgeEntrySchema.parse({
          kind: "file", id, title: document.title, body: document.body, tags: document.tags,
          createdAt: previous?.createdAt ?? timestamp, updatedAt: timestamp,
          source: { ...source, relativePath: document.relativePath, path: path.posix.join(source.rootPath, document.relativePath), sha256: createHash("sha256").update(document.body, "utf8").digest("hex"), modifiedAt: document.modifiedAt },
        });
        if (previous && digest([previous.title, previous.body, previous.tags, previous.source]) === digest([value.title, value.body, value.tags, value.source])) { counts.unchanged++; continue; }
        this.db.prepare("INSERT INTO knowledge_files VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET search_text=excluded.search_text,value_json=excluded.value_json").run(
          id, sourceKey, document.relativePath, [value.title, value.body, ...value.tags, source.label, document.relativePath].join("\n").toLocaleLowerCase(), JSON.stringify(value),
        );
        if (previous) counts.updated++; else counts.imported++;
      }
      return counts;
    });
    this.changed();
    return result;
  }

  allKnowledge(): KnowledgeEntry[] {
    return (this.db.prepare("SELECT value_json FROM (SELECT value_json FROM knowledge_entries UNION ALL SELECT value_json FROM knowledge_files) ORDER BY json_extract(value_json, '$.id')").all() as Row[])
      .map(row => knowledgeEntrySchema.parse(JSON.parse(String(row.value_json))));
  }

  knowledgeEntry(id: string): KnowledgeEntry | null {
    const row = this.db.prepare("SELECT value_json FROM knowledge_entries WHERE id=? UNION ALL SELECT value_json FROM knowledge_files WHERE id=?").get(id, id) as Row | undefined;
    return row ? knowledgeEntrySchema.parse(JSON.parse(String(row.value_json))) : null;
  }

  knowledge(query = "", offset = 0) {
    const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean).slice(0, 20);
    const where = terms.length ? `WHERE ${terms.map(() => "search_text LIKE ? ESCAPE '\\'").join(" AND ")}` : "";
    const params = terms.map((t) => `%${t.replace(/[\\%_]/g, "\\$&")}%`);
    const combined = "WITH knowledge AS (SELECT id,search_text,value_json FROM knowledge_entries UNION ALL SELECT id,search_text,value_json FROM knowledge_files)";
    const total = Number((this.db.prepare(`${combined} SELECT count(*) AS n FROM knowledge ${where}`).get(...params) as Row).n);
    const rows = this.db.prepare(`${combined} SELECT value_json FROM knowledge ${where} ORDER BY json_extract(value_json,'$.createdAt') DESC,id LIMIT 50 OFFSET ?`).all(...params, offset) as Row[];
    const entries: KnowledgeEntry[] = [];
    let bytes = 0;
    for (const row of rows) {
      const entry = knowledgeEntrySchema.parse(JSON.parse(String(row.value_json)));
      const size = Buffer.byteLength(JSON.stringify(entry, null, 2)) + 256;
      if (entries.length && bytes + size > 512 * 1024) break;
      entries.push(entry); bytes += size;
    }
    const next = offset + entries.length;
    return { entries, total, nextOffset: next < total ? next : null };
  }

  session(id: string): Session {
    const row = this.db.prepare("SELECT value_json FROM sessions WHERE id=?").get(id) as Row | undefined;
    if (!row) throw new PolicyError("Work session not found.");
    return sessionSchema.parse(JSON.parse(String(row.value_json)));
  }
  sessions(taskId: string): Session[] {
    return (this.db.prepare("SELECT value_json FROM sessions WHERE task_id=? ORDER BY rowid DESC LIMIT 100").all(taskId) as Row[]).map((r) => sessionSchema.parse(JSON.parse(String(r.value_json))));
  }
  active(): Session[] {
    return (this.db.prepare("SELECT value_json FROM sessions WHERE status IN ('starting','working','collecting','review_starting','reviewing','repair_starting')").all() as Row[]).map((r) => sessionSchema.parse(JSON.parse(String(r.value_json))));
  }
  forThread(threadId: string): Session | undefined {
    const row = this.db.prepare("SELECT s.value_json FROM sessions s JOIN session_threads t ON s.id=t.session_id WHERE t.thread_id=?").get(threadId) as Row | undefined;
    return row ? sessionSchema.parse(JSON.parse(String(row.value_json))) : undefined;
  }
  insertSession(session: Session, request: unknown) {
    this.db.prepare("INSERT INTO sessions VALUES (?,?,?,?,?)").run(session.id, session.taskId, session.status, JSON.stringify(session), JSON.stringify(request));
    this.changed();
  }
  saveSession(session: Session): Session {
    const value = sessionSchema.parse({ ...session, updatedAt: now() });
    this.db.prepare("UPDATE sessions SET status=?,value_json=? WHERE id=?").run(value.status, JSON.stringify(value), value.id);
    for (const [threadId, role] of [[value.workerThreadId, "worker"], [value.reviewerThreadId, "reviewer"]] as const) {
      if (threadId) this.db.prepare("INSERT OR IGNORE INTO session_threads VALUES (?,?,?,?)").run(threadId, value.id, role, value.round);
    }
    this.changed();
    return value;
  }
  sessionRequest(id: string): unknown {
    return JSON.parse(String((this.db.prepare("SELECT request_json FROM sessions WHERE id=?").get(id) as Row).request_json));
  }
  sessionEvent(id: string, kind: string, detail: string, payload: unknown = {}) {
    this.db.prepare("INSERT INTO session_events VALUES (?,?,?,?,?,?)").run(randomUUID(), id, kind, detail, JSON.stringify(payload), now());
  }
  threadIds(sessionId: string): Array<{ threadId: string; role: string }> {
    return (this.db.prepare("SELECT thread_id,role FROM session_threads WHERE session_id=?").all(sessionId) as Row[]).map((r) => ({ threadId: String(r.thread_id), role: String(r.role) }));
  }
  recorderThreads(sessionId: string): Array<{ threadId: string; round: number }> {
    return (this.db.prepare("SELECT thread_id,round FROM session_threads WHERE session_id=? AND role='reviewer' ORDER BY round DESC,thread_id LIMIT 20").all(sessionId) as Row[])
      .map((r) => ({ threadId: String(r.thread_id), round: Number(r.round) }));
  }
  pendingThreadArchives(taskId?: string): Array<{ threadId: string; taskId: string; revision: number }> {
    // Accepted session results can outlive an open task. A successful receipt
    // stays valid across its later edits, preserving a manual thread unarchive.
    // Closing the whole task still creates a new archival pass by revision.
    return (this.db.prepare(`WITH RECURSIVE accepted_sessions(id) AS (
        SELECT id FROM sessions WHERE status='applied'
        UNION SELECT json_extract(s.value_json,'$.continuedFrom') FROM sessions s JOIN accepted_sessions a ON s.id=a.id
          WHERE json_extract(s.value_json,'$.continuedFrom') IS NOT NULL
      ) SELECT st.thread_id,s.task_id,t.revision FROM session_threads st
      JOIN sessions s ON s.id=st.session_id JOIN tasks t ON t.id=s.task_id
      LEFT JOIN closed_task_thread_archives a ON a.thread_id=st.thread_id
      WHERE (t.status IN ('done','archived') OR s.id IN (SELECT id FROM accepted_sessions)) AND (? IS NULL OR t.id=?)
        AND s.status NOT IN ('starting','working','collecting','review_starting','reviewing','repair_starting')
        AND (a.thread_id IS NULL OR (t.status IN ('done','archived') AND a.task_revision<>t.revision) OR (a.archived_at IS NULL AND a.retry_at<=?))
      ORDER BY t.updated_at,st.thread_id LIMIT 100`).all(taskId ?? null, taskId ?? null, Date.now()) as Row[])
      .map((row) => ({ threadId: String(row.thread_id), taskId: String(row.task_id), revision: Number(row.revision) }));
  }
  sessionResultsAccepted(sessionId: string) {
    return Boolean(this.db.prepare(`WITH RECURSIVE descendants(id) AS (
      SELECT id FROM sessions WHERE id=?
      UNION SELECT s.id FROM sessions s JOIN descendants d ON json_extract(s.value_json,'$.continuedFrom')=d.id
    ) SELECT 1 FROM sessions WHERE id IN (SELECT id FROM descendants) AND status='applied' LIMIT 1`).get(sessionId));
  }
  recordThreadArchive(threadId: string, revision: number, succeeded: boolean) {
    this.db.prepare(`INSERT INTO closed_task_thread_archives(thread_id,task_revision,archived_at,retry_at) VALUES(?,?,?,?)
      ON CONFLICT(thread_id) DO UPDATE SET task_revision=excluded.task_revision,archived_at=excluded.archived_at,retry_at=excluded.retry_at`)
      .run(threadId, revision, succeeded ? now() : null, succeeded ? 0 : Date.now() + 30000);
  }
}
