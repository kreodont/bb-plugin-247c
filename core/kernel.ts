import { createHash, randomUUID } from "node:crypto";
import type { Statement as StatementSync } from "better-sqlite3";
import { ConflictError, NotFoundError, PolicyError } from "./errors.js";
import { Store } from "./database.js";
import { factKinds, type ApplicationReceipt, type FactKind, type PreparedTaskBrief, type ProposalApproval, type ProposalEvidence, type StewardChanges, type StewardProposal, type TaskDossier, type TaskFact, type TaskProjection, type TaskRecord } from "./types.js";
import { parseProposalDraft, validateEvidence } from "./validation.js";

type Row = Record<string, unknown>;

function now(): string {
  return new Date().toISOString();
}

function rows(statement: StatementSync, ...parameters: (string | number | null)[]): Row[] {
  return statement.all(...parameters) as Row[];
}

function taskFrom(row: Row): TaskRecord {
  return {
    id: String(row.id),
    title: String(row.title),
    status: row.status as TaskRecord["status"],
    revision: Number(row.revision),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function factFrom(row: Row): TaskFact {
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    kind: row.kind as FactKind,
    text: String(row.text),
    source: String(row.source),
    sourceRef: row.source_ref === null ? null : String(row.source_ref),
    occurredAt: String(row.occurred_at),
    createdAt: String(row.created_at),
  };
}

function projectionFrom(row: Row): TaskProjection {
  return {
    taskId: String(row.task_id),
    summary: row.summary === null ? null : String(row.summary),
    nextStep: row.next_step === null ? null : String(row.next_step),
    openQuestions: JSON.parse(String(row.open_questions_json)) as string[],
    blockers: JSON.parse(String(row.blockers_json)) as string[],
    artifacts: JSON.parse(String(row.artifacts_json)) as TaskProjection["artifacts"],
    updatedAt: String(row.updated_at),
  };
}

function proposalFrom(row: Row): StewardProposal {
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    baseRevision: Number(row.base_revision),
    model: String(row.model),
    rationale: String(row.rationale),
    confidence: Number(row.confidence),
    changes: JSON.parse(String(row.changes_json)) as StewardChanges,
    status: row.status as StewardProposal["status"],
    createdAt: String(row.created_at),
    resolvedAt: row.resolved_at === null ? null : String(row.resolved_at),
    idempotencyKey: row.idempotency_key === null ? null : String(row.idempotency_key),
  };
}

export class Kernel {
  constructor(readonly store: Store) {}

  createTask(input: { id?: string; title: string }): TaskRecord {
    if (input.title.trim() === "") throw new PolicyError("task title cannot be empty");
    const id = input.id ?? randomUUID();
    const timestamp = now();
    return this.store.transaction(() => {
      this.store.db.prepare(
        "INSERT INTO tasks(id, title, status, revision, created_at, updated_at) VALUES (?, ?, 'open', 0, ?, ?)",
      ).run(id, input.title.trim(), timestamp, timestamp);
      this.store.db.prepare(
        "INSERT INTO task_projections(task_id, summary, next_step, open_questions_json, blockers_json, artifacts_json, updated_at) VALUES (?, NULL, NULL, '[]', '[]', '[]', ?)",
      ).run(id, timestamp);
      this.event(id, "task.created", { title: input.title.trim() }, timestamp);
      return this.getTask(id);
    });
  }

  appendFact(input: {
    taskId: string;
    kind: FactKind;
    text: string;
    source?: string;
    sourceRef?: string | null;
    occurredAt?: string;
    id?: string;
  }): TaskFact {
    this.getTask(input.taskId);
    if (!factKinds.includes(input.kind)) throw new PolicyError(`unknown fact kind: ${input.kind}`);
    if (input.text.trim() === "") throw new PolicyError("fact text cannot be empty");
    const id = input.id ?? randomUUID();
    const timestamp = now();
    const occurredAt = input.occurredAt ?? timestamp;
    return this.store.transaction(() => {
      this.store.db.prepare(`
        INSERT INTO task_facts(id, task_id, kind, text, source, source_ref, occurred_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, input.taskId, input.kind, input.text.trim(), input.source ?? "user", input.sourceRef ?? null, occurredAt, timestamp);
      this.bumpRevision(input.taskId, timestamp);
      this.event(input.taskId, "fact.appended", { factId: id, kind: input.kind }, timestamp);
      return this.getFact(id);
    });
  }

  getTask(taskId: string): TaskRecord {
    const row = this.store.db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as Row | undefined;
    if (!row) throw new NotFoundError(`task not found: ${taskId}`);
    return taskFrom(row);
  }

  hasTask(taskId: string): boolean {
    return this.store.db.prepare("SELECT 1 FROM tasks WHERE id = ?").get(taskId) !== undefined;
  }

  setTaskStatus(taskId: string, status: TaskRecord["status"], expectedRevision: number): TaskRecord {
    if (!["open", "done", "archived"].includes(status)) throw new PolicyError("invalid task status");
    return this.store.transaction(() => {
      const task = this.getTask(taskId);
      if (task.revision !== expectedRevision) throw new ConflictError("Task changed; refresh before changing its status");
      if (task.status === status) return task;
      const timestamp = now();
      this.store.db.prepare("UPDATE tasks SET status=?,revision=revision+1,updated_at=? WHERE id=?").run(status, timestamp, taskId);
      this.event(taskId, "task.status-changed", { before: task.status, after: status, actor: "human" }, timestamp);
      return this.getTask(taskId);
    });
  }

  listProposals(taskId?: string): StewardProposal[] {
    return rows(this.store.db.prepare(`SELECT * FROM proposals ${taskId ? "WHERE task_id=?" : ""} ORDER BY created_at DESC LIMIT 200`), ...(taskId ? [taskId] : [])).map(proposalFrom);
  }

  getFact(factId: string): TaskFact {
    const row = this.store.db.prepare("SELECT * FROM task_facts WHERE id = ?").get(factId) as Row | undefined;
    if (!row) throw new NotFoundError(`fact not found: ${factId}`);
    return factFrom(row);
  }

  hasFact(factId: string): boolean {
    return this.store.db.prepare("SELECT 1 FROM task_facts WHERE id = ?").get(factId) !== undefined;
  }

  getDossier(taskId: string): TaskDossier {
    const task = this.getTask(taskId);
    const projectionRow = this.store.db.prepare("SELECT * FROM task_projections WHERE task_id = ?").get(taskId) as Row;
    const factRows = rows(this.store.db.prepare("SELECT * FROM task_facts WHERE task_id = ? ORDER BY occurred_at, created_at"), taskId);
    return { task, projection: projectionFrom(projectionRow), facts: factRows.map(factFrom), planning: this.getPlanning(taskId) };
  }

  getPlanning(taskId: string): TaskDossier["planning"] {
    const row = this.store.db.prepare("SELECT * FROM planning WHERE task_id=?").get(taskId) as Row | undefined;
    return { urgent: row?.urgent == null ? null : Boolean(row.urgent), important: row?.important == null ? null : Boolean(row.important), revision: Number(row?.revision ?? 0) };
  }

  createProposal(input: { taskId: string; baseRevision: number; model: string; output: unknown; idempotencyKey?: string; additionalEvidence?: readonly ProposalEvidence[] }): StewardProposal {
    if (input.idempotencyKey) {
      const existing = this.store.db.prepare("SELECT * FROM proposals WHERE idempotency_key = ?").get(input.idempotencyKey) as Row | undefined;
      if (existing) return proposalFrom(existing);
    }
    const dossier = this.getDossier(input.taskId);
    if (dossier.task.revision !== input.baseRevision) {
      throw new ConflictError(`task revision is ${dossier.task.revision}, proposal used ${input.baseRevision}`);
    }
    const draft = parseProposalDraft(input.output);
    const additionalEvidence = normalizeProposalEvidence(input.additionalEvidence ?? []);
    validateEvidence(draft, dossier, additionalEvidence);
    const id = randomUUID();
    const timestamp = now();
    this.store.transaction(() => {
      this.store.db.prepare(`
        INSERT INTO proposals(id, task_id, base_revision, model, rationale, confidence, changes_json, status, created_at, resolved_at, idempotency_key)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL, ?)
      `).run(id, input.taskId, input.baseRevision, input.model, draft.rationale, draft.confidence, JSON.stringify(draft.changes), timestamp, input.idempotencyKey ?? null);
      const evidenceStatement = this.store.db.prepare(`INSERT INTO proposal_evidence(
        proposal_id, evidence_ref, kind, text, source, source_ref
      ) VALUES (?, ?, ?, ?, ?, ?)`);
      for (const evidence of additionalEvidence) {
        evidenceStatement.run(id, evidence.ref, evidence.kind, evidence.text, evidence.source, evidence.sourceRef);
      }
      this.event(input.taskId, "proposal.created", { proposalId: id, model: input.model }, timestamp);
    });
    return this.getProposal(id);
  }

  getProposal(proposalId: string): StewardProposal {
    const row = this.store.db.prepare("SELECT * FROM proposals WHERE id = ?").get(proposalId) as Row | undefined;
    if (!row) throw new NotFoundError(`proposal not found: ${proposalId}`);
    return proposalFrom(row);
  }

  findProposalByIdempotencyKey(idempotencyKey: string): StewardProposal | undefined {
    const row = this.store.db.prepare("SELECT * FROM proposals WHERE idempotency_key = ?").get(idempotencyKey) as Row | undefined;
    return row ? proposalFrom(row) : undefined;
  }

  proposalEvidence(proposalId: string): ProposalEvidence[] {
    this.getProposal(proposalId);
    return (this.store.db.prepare("SELECT * FROM proposal_evidence WHERE proposal_id = ? ORDER BY evidence_ref").all(proposalId) as Row[]).map((row) => ({
      ref: String(row.evidence_ref), kind: row.kind as FactKind, text: String(row.text), source: String(row.source),
      sourceRef: row.source_ref === null ? null : String(row.source_ref),
    }));
  }

  approveProposal(proposalId: string, actor = "human:cli"): ProposalApproval {
    return this.store.transaction(() => {
      const proposal = this.getProposal(proposalId);
      if (proposal.status !== "pending") throw new PolicyError(`proposal is already ${proposal.status}`);
      const approval: ProposalApproval = {
        id: randomUUID(),
        proposalId,
        proposalHash: this.proposalHash(proposal),
        actor,
        createdAt: now(),
      };
      this.store.db.prepare(
        "INSERT INTO proposal_approvals(id, proposal_id, proposal_hash, actor, created_at) VALUES (?, ?, ?, ?, ?)",
      ).run(approval.id, approval.proposalId, approval.proposalHash, approval.actor, approval.createdAt);
      this.store.db.prepare("UPDATE proposals SET status = 'approved' WHERE id = ? AND status = 'pending'").run(proposalId);
      this.event(proposal.taskId, "proposal.approved", { proposalId, approvalId: approval.id, actor }, approval.createdAt);
      return approval;
    });
  }

  applyProposal(proposalId: string): TaskDossier {
    const result = this.store.transaction((): TaskDossier | { conflict: string } => {
      const proposal = this.getProposal(proposalId);
      if (proposal.status !== "approved") throw new PolicyError(`proposal must be approved, found ${proposal.status}`);
      const dossier = this.getDossier(proposal.taskId);
      if (dossier.task.revision !== proposal.baseRevision) {
        const message = `task changed after proposal: expected ${proposal.baseRevision}, found ${dossier.task.revision}`;
        const timestamp = now();
        this.store.db.prepare("UPDATE proposals SET status = 'conflicted', resolved_at = ? WHERE id = ?").run(timestamp, proposalId);
        this.event(proposal.taskId, "proposal.conflicted", { proposalId, message }, timestamp);
        return { conflict: message };
      }
      validateEvidence(proposal, dossier, this.proposalEvidence(proposal.id));
      const approvalRow = this.store.db.prepare("SELECT * FROM proposal_approvals WHERE proposal_id = ?").get(proposalId) as Row | undefined;
      if (!approvalRow || String(approvalRow.proposal_hash) !== this.proposalHash(proposal)) {
        throw new PolicyError("approval does not match the exact proposal");
      }
      const next: TaskProjection = { ...dossier.projection };
      if (proposal.changes.summary) next.summary = proposal.changes.summary.value;
      if (proposal.changes.nextStep) next.nextStep = proposal.changes.nextStep.value;
      if (proposal.changes.openQuestions) next.openQuestions = proposal.changes.openQuestions.value;
      if (proposal.changes.blockers) next.blockers = proposal.changes.blockers.value;
      if (proposal.changes.artifacts) next.artifacts = proposal.changes.artifacts.value;
      const nextStatus = proposal.changes.status?.value ?? dossier.task.status;
      const nextTitle = proposal.changes.title?.value ?? dossier.task.title;
      const nextPlanning = { ...dossier.planning };
      if (proposal.changes.urgent) nextPlanning.urgent = proposal.changes.urgent.value;
      if (proposal.changes.important) nextPlanning.important = proposal.changes.important.value;
      const timestamp = now();
      this.store.db.prepare(`
        UPDATE task_projections
        SET summary = ?, next_step = ?, open_questions_json = ?, blockers_json = ?, artifacts_json = ?, updated_at = ?
        WHERE task_id = ?
      `).run(next.summary, next.nextStep, JSON.stringify(next.openQuestions), JSON.stringify(next.blockers), JSON.stringify(next.artifacts), timestamp, proposal.taskId);
      this.store.db.prepare("UPDATE proposals SET status = 'applied', resolved_at = ? WHERE id = ?").run(timestamp, proposalId);
      if (nextStatus !== dossier.task.status) {
        this.store.db.prepare("UPDATE tasks SET status=? WHERE id=?").run(nextStatus, proposal.taskId);
        this.event(proposal.taskId, "task.status-changed", { before: dossier.task.status, after: nextStatus, actor: approvalRow.actor, proposalId }, timestamp);
      }
      if (nextTitle !== dossier.task.title) {
        this.store.db.prepare("UPDATE tasks SET title=? WHERE id=?").run(nextTitle, proposal.taskId);
        this.event(proposal.taskId, "task.title-changed", { before: dossier.task.title, after: nextTitle, actor: approvalRow.actor, proposalId }, timestamp);
      }
      if (nextPlanning.urgent !== dossier.planning.urgent || nextPlanning.important !== dossier.planning.important) {
        this.store.db.prepare("INSERT OR IGNORE INTO planning(task_id) VALUES (?)").run(proposal.taskId);
        this.store.db.prepare("UPDATE planning SET urgent=?,important=?,revision=revision+1 WHERE task_id=?").run(nextPlanning.urgent === null ? null : Number(nextPlanning.urgent), nextPlanning.important === null ? null : Number(nextPlanning.important), proposal.taskId);
        this.event(proposal.taskId, "planning.changed", { before: dossier.planning, after: this.getPlanning(proposal.taskId), actor: approvalRow.actor, proposalId }, timestamp);
      }
      this.bumpRevision(proposal.taskId, timestamp);
      const afterRevision = dossier.task.revision + 1;
      const receiptId = randomUUID();
      this.store.db.prepare(`
        INSERT INTO application_receipts(id, proposal_id, approval_id, task_id, before_revision, after_revision, fields_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(receiptId, proposalId, String(approvalRow.id), proposal.taskId, dossier.task.revision, afterRevision, JSON.stringify(Object.keys(proposal.changes)), timestamp);
      this.store.db.prepare("INSERT INTO application_snapshots(proposal_id,before_json,after_json) VALUES(?,?,?)").run(proposalId,
        JSON.stringify({ ...dossier.projection, status: dossier.task.status, title: dossier.task.title, urgent: dossier.planning.urgent, important: dossier.planning.important }),
        JSON.stringify({ ...next, status: nextStatus, title: nextTitle, urgent: nextPlanning.urgent, important: nextPlanning.important }));
      this.event(proposal.taskId, "proposal.applied", { proposalId, approvalId: approvalRow.id, receiptId, fields: Object.keys(proposal.changes) }, timestamp);
      return this.getDossier(proposal.taskId);
    });
    if ("conflict" in result) throw new ConflictError(result.conflict);
    return result;
  }

  /** Reversal is a new exact, evidence-backed proposal; history and later work survive. */
  proposeRevert(proposalId: string): StewardProposal {
    const applied = this.getProposal(proposalId);
    if (applied.status !== "applied") throw new PolicyError("Only an applied proposal can be reversed");
    const snapshot = this.store.db.prepare("SELECT * FROM application_snapshots WHERE proposal_id=?").get(proposalId) as Row | undefined;
    if (!snapshot) throw new PolicyError("This legacy application has no before snapshot; inspect its history and propose a correction");
    type Snapshot = TaskProjection & { status?: TaskRecord["status"]; title?: string; urgent?: boolean | null; important?: boolean | null };
    const before = JSON.parse(String(snapshot.before_json)) as Snapshot;
    const after = JSON.parse(String(snapshot.after_json)) as Snapshot;
    const dossier = this.getDossier(applied.taskId);
    const current = { ...dossier.projection, status: dossier.task.status, title: dossier.task.title, urgent: dossier.planning.urgent, important: dossier.planning.important };
    const changes: Record<string, unknown> = {}, additionalEvidence: ProposalEvidence[] = [];
    for (const field of Object.keys(applied.changes) as Array<keyof StewardChanges>) {
      if (!(field in before) || !(field in after)) throw new PolicyError("The saved operation does not contain the previous task field value.");
      if (JSON.stringify(current[field]) !== JSON.stringify(after[field])) throw new ConflictError(`${field} changed after this application; automatic reversal would overwrite newer work`);
      const values = Array.isArray(before[field]) ? before[field] as unknown[] : [before[field]];
      const evidenceRefs: string[] = [];
      for (const [index, value] of (values.length ? values : [null]).entries()) {
        const ref = `revert:${proposalId}:${field}:${index}`;
        evidenceRefs.push(ref);
        additionalEvidence.push({ ref, kind: ["status", "title", "urgent", "important"].includes(field) ? "decision" : field === "nextStep" ? "explicit_next_step" : field === "openQuestions" ? "open_question" : field === "blockers" ? "blocker" : field === "artifacts" ? "artifact" : "description", text: value === null ? `Restore previously accepted empty ${field}` : typeof value === "string" ? value : JSON.stringify(value), source: `accepted-projection:${proposalId}`, sourceRef: field === "artifacts" && value ? (value as { uri: string }).uri : null });
      }
      changes[field] = { value: before[field], evidenceRefs };
    }
    return this.createProposal({ taskId: applied.taskId, baseRevision: dossier.task.revision, model: "kernel:compensating-revert-v1", output: { rationale: `Restore fields from before application ${proposalId}`, confidence: 1, changes }, additionalEvidence, idempotencyKey: `revert:${proposalId}:${dossier.task.revision}` });
  }

  rejectProposal(proposalId: string): StewardProposal {
    return this.store.transaction(() => {
      const proposal = this.getProposal(proposalId);
      if (proposal.status !== "pending" && proposal.status !== "approved") throw new PolicyError(`proposal is already ${proposal.status}`);
      const timestamp = now();
      const changed = this.store.db.prepare("UPDATE proposals SET status = 'rejected', resolved_at = ? WHERE id = ? AND status IN ('pending', 'approved')").run(timestamp, proposalId);
      if (Number(changed.changes) !== 1) throw new ConflictError("proposal status changed concurrently");
      this.event(proposal.taskId, "proposal.rejected", { proposalId }, timestamp);
      return this.getProposal(proposalId);
    });
  }

  getApplicationReceipt(proposalId: string): ApplicationReceipt {
    const row = this.store.db.prepare("SELECT * FROM application_receipts WHERE proposal_id = ?").get(proposalId) as Row | undefined;
    if (!row) throw new NotFoundError(`application receipt not found for proposal: ${proposalId}`);
    return {
      id: String(row.id), proposalId: String(row.proposal_id), approvalId: String(row.approval_id), taskId: String(row.task_id),
      beforeRevision: Number(row.before_revision), afterRevision: Number(row.after_revision),
      fields: JSON.parse(String(row.fields_json)) as string[], createdAt: String(row.created_at),
    };
  }

  prepareBrief(taskId: string): PreparedTaskBrief {
    const { task, projection, facts, planning } = this.getDossier(taskId);
    const lines = [`# ${task.title}`, "", `Task: ${task.id} · revision ${task.revision} · ${task.status}`];
    lines.push(`Priority: urgent=${planning.urgent}, important=${planning.important} (null = unclassified).`);
    if (projection.summary) lines.push("", "## Current summary", projection.summary);
    if (projection.nextStep) lines.push("", "## Explicit next step", projection.nextStep);
    if (projection.openQuestions.length) lines.push("", "## Open questions", ...projection.openQuestions.map((item) => `- ${item}`));
    if (projection.blockers.length) lines.push("", "## Blockers", ...projection.blockers.map((item) => `- ${item}`));
    if (projection.artifacts.length) lines.push("", "## Artifacts", ...projection.artifacts.map((item) => `- [${escapeMarkdown(item.label)}](<${item.uri.replaceAll(">", "%3E")}>)`));
    const recent = facts.slice(-20);
    if (recent.length) {
      lines.push("", "## Evidence", ...recent.map((fact) => `- [${fact.id}] ${fact.kind}: ${fact.text}`));
    }
    if (!projection.nextStep) lines.push("", "No explicit next step has been accepted.");
    return { taskId, revision: task.revision, markdown: lines.join("\n") + "\n" };
  }

  private bumpRevision(taskId: string, timestamp: string): void {
    this.store.db.prepare("UPDATE tasks SET revision = revision + 1, updated_at = ? WHERE id = ?").run(timestamp, taskId);
  }

  private event(taskId: string | null, type: string, payload: unknown, timestamp: string): void {
    this.store.db.prepare(
      "INSERT INTO kernel_events(id, task_id, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(randomUUID(), taskId, type, JSON.stringify(payload), timestamp);
  }

  private proposalHash(proposal: StewardProposal): string {
    return createHash("sha256").update(JSON.stringify({
      id: proposal.id, taskId: proposal.taskId, baseRevision: proposal.baseRevision, model: proposal.model,
      rationale: proposal.rationale, confidence: proposal.confidence, changes: proposal.changes, createdAt: proposal.createdAt,
    })).digest("hex");
  }
}

function escapeMarkdown(value: string): string {
  return value.replace(/[\\\[\]]/g, "\\$&");
}

function normalizeProposalEvidence(input: readonly ProposalEvidence[]): ProposalEvidence[] {
  const seen = new Set<string>();
  return input.map((item) => {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(item.ref) || seen.has(item.ref)) throw new PolicyError("proposal evidence ref is invalid or duplicated");
    if (!factKinds.includes(item.kind) || item.text.trim() === "" || item.source.trim() === "") throw new PolicyError("proposal evidence is invalid");
    seen.add(item.ref);
    return { ...item, text: item.text.trim(), source: item.source.trim() };
  });
}
