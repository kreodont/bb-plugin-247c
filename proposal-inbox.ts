import { statusNeedsStoppedSession } from "./task-status.js";
import { randomUUID } from "node:crypto";
import { reviewDossierSchema, sourceChatDeliverySchema, type ReviewItem, type ReviewSelection } from "./contracts.js";
import { ACTIVE, Repository } from "./repository.js";
import { SourceSyncStore } from "./source-sync.js";
import { ConflictError, PolicyError } from "./core/errors.js";
import type { SessionRuntime } from "./runtime.js";

type Row = { kind: "source" | "proposal"; id: string };
export class ProposalInbox {
  constructor(readonly repo: Repository, readonly sync: SourceSyncStore, readonly runtime: Pick<SessionRuntime, "accept" | "reviewParts">) {}
  item(kind: Row["kind"], id: string): ReviewItem {
    if (kind === "source") {
      const candidate = this.sync.candidate(id);
      const task = candidate.taskId ? this.repo.kernel.getTask(candidate.taskId) : null;
      const active = task ? this.repo.active().some(s => s.taskId === task.id) : false;
      const currentTask = task ? { revision: task.revision, status: task.status, activeSession: active ? "active" : null } : null;
      const duplicate = !task && this.repo.list(true).tasks.some(t => t.title.trim().toLocaleLowerCase() === candidate.title.trim().toLocaleLowerCase());
      const blockedReason = task && task.revision !== candidate.baseRevision ? "The dossier changed after the check. An updated proposal is required."
        : active && candidate.changes.status && task && statusNeedsStoppedSession(task.status, candidate.changes.status.value) ? "Finish the work session before changing the task status."
        : duplicate ? "A task with this title already exists. Check for a duplicate." : null;
      return { kind, candidate, currentTask, blockedReason };
    }
    this.repo.sessionTime.reconcile(this.repo.kernel.getProposal(id).taskId);
    const raw = this.repo.kernel.getProposal(id), dossier = this.repo.kernel.getDossier(raw.taskId);
    const proposal = { ...raw, ...this.repo.partReviewFields("proposal", raw.id), evidence: this.repo.kernel.proposalEvidence(id), receipt: null };
    const sessions = this.repo.sessions(raw.taskId).filter(s => ACTIVE.has(s.status)).map(({ id, status, discussionProposalId }) => ({ id, status, discussionProposalId }));
    const update = this.repo.db.prepare("SELECT value_json FROM session_updates WHERE proposal_id=?").get(id) as { value_json: string } | undefined;
    const used = new Set(Object.values(raw.changes).flatMap(change => change?.evidenceRefs ?? []));
    const context = reviewDossierSchema.parse({ ...dossier, facts: dossier.facts.filter(f => used.has(f.id)), sessions, sessionUpdates: update ? [JSON.parse(update.value_json)] : [] });
    const blockedReason = raw.baseRevision !== dossier.task.revision ? "The dossier changed. Expand this proposal to refresh it or review the current task."
      : sessions.some(s => s.discussionProposalId === id) ? "Finish discussing this review first."
      : raw.changes.status && statusNeedsStoppedSession(dossier.task.status, raw.changes.status.value) && sessions.length ? "Finish the work session before changing the task status." : null;
    return { kind, proposal, dossier: context, blockedReason };
  }
  list(offset = 0) {
    this.repo.sessionTime.reconcile();
    const rows = this.repo.db.prepare(`SELECT kind,id FROM (
      SELECT 'source' AS kind,id,created_at FROM (SELECT id,json_extract(value_json,'$.createdAt') AS created_at FROM source_sync_candidates WHERE status='pending')
      UNION ALL SELECT 'proposal' AS kind,id,created_at FROM proposals WHERE status IN ('pending','approved')
    ) ORDER BY created_at,kind,id LIMIT 50 OFFSET ?`).all(offset) as Row[];
    const items: ReviewItem[] = []; let bytes = 0;
    for (const row of rows) {
      const item = this.item(row.kind, row.id), size = Buffer.byteLength(JSON.stringify(item));
      if (items.length && bytes + size > 3 * 1024 * 1024) break;
      if (size > 3 * 1024 * 1024) throw new PolicyError("The proposal is too large for the shared list. Open it in the task dossier.");
      items.push(item); bytes += size;
    }
    const total = this.repo.pendingTotal();
    return { items, total, nextOffset: offset + items.length < total ? offset + items.length : null, recentlyAccepted: this.recentlyAccepted() };
  }
  recentlyAccepted() {
    // Every successful acceptance, including source imports and partial reviews,
    // has a receipt. Read those receipts so links survive refreshes and restarts
    // without storing another copy of the task or treating failed reviews as saved.
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const tasks = this.repo.db.prepare(`SELECT t.id,t.title,t.status,MAX(r.created_at) AS acceptedAt
      FROM application_receipts r JOIN tasks t ON t.id=r.task_id
      WHERE r.created_at>=? GROUP BY t.id ORDER BY acceptedAt DESC,t.id LIMIT 50`).all(since) as {
        id: string; title: string; status: "open" | "waiting" | "done" | "archived"; acceptedAt: string;
      }[];
    return tasks.map(task => {
      const row = this.repo.db.prepare(`SELECT json_extract(value_json,'$.chatDelivery') AS delivery FROM source_sync_candidates
        WHERE status='applied' AND task_id=? AND json_extract(value_json,'$.chatDelivery') IS NOT NULL
        ORDER BY json_extract(value_json,'$.resolvedAt') DESC,id DESC LIMIT 1`).get(task.id) as { delivery: string } | undefined;
      return { ...task, ...(row ? { chatDelivery: sourceChatDeliverySchema.omit({ message: true, requestId: true }).parse(JSON.parse(row.delivery)) } : {}) };
    });
  }
  async accept(items: ReviewSelection[]) {
    // A task revision can be approved once. Never arbitrarily pick the first of
    // two conflicting proposals selected in different tabs or a stale client.
    const taskIds = new Set<string>(), keys = new Set<string>();
    for (const item of items) {
      const key = `${item.kind}:${item.id}`;
      if (keys.has(key)) throw new PolicyError("The same proposal is selected more than once.");
      keys.add(key);
      let taskId: string | null;
      try { taskId = item.kind === "source" ? this.sync.candidate(item.id).taskId : this.repo.kernel.getProposal(item.id).taskId; }
      catch { continue; } // The per-item result below reports a missing entry.
      if (taskId && taskIds.has(taskId)) throw new PolicyError("Multiple proposals are selected for one task. Choose one; the others will need updating after it is accepted.");
      if (taskId) taskIds.add(taskId);
    }
    const applied: { kind: ReviewSelection["kind"]; id: string; taskId: string }[] = [];
    const failed: { kind: ReviewSelection["kind"]; id: string; message: string }[] = [];
    for (const item of items) {
      try {
        const value = item.kind === "source" ? this.sync.candidate(item.id) : this.repo.kernel.getProposal(item.id);
        if (value.baseRevision !== item.revision) throw new ConflictError("The proposal changed. Refresh the list and review it again.");
        let taskId: string;
        if (item.parts) {
          const input = { ...item, parts: item.parts, decision: "accept" as const, requestId: randomUUID() };
          const result = item.kind === "source" ? this.sync.reviewParts(input) : await this.runtime.reviewParts(input);
          taskId = result.taskId!;
        } else {
          const dossier = item.kind === "source" ? this.sync.accept(item.id, item.initialPriority) : await this.runtime.accept(item.id, item.revision!);
          taskId = dossier.task.id;
        }
        applied.push({ kind: item.kind, id: item.id, taskId });
      } catch (error) { failed.push({ kind: item.kind, id: item.id, message: error instanceof Error ? error.message : String(error) }); }
    }
    return { applied, failed };
  }
}
