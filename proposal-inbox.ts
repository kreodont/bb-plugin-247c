import { reviewDossierSchema, type ReviewItem, type ReviewSelection } from "./contracts.js";
import { ACTIVE, Repository } from "./repository.js";
import { SourceSyncStore } from "./source-sync.js";
import { ConflictError, PolicyError } from "./core/errors.js";
import type { SessionRuntime } from "./runtime.js";

type Row = { kind: "source" | "proposal"; id: string };
export class ProposalInbox {
  constructor(readonly repo: Repository, readonly sync: SourceSyncStore, readonly runtime: Pick<SessionRuntime, "accept">) {}
  item(kind: Row["kind"], id: string): ReviewItem {
    if (kind === "source") {
      const candidate = this.sync.candidate(id);
      const task = candidate.taskId ? this.repo.kernel.getTask(candidate.taskId) : null;
      const active = task ? this.repo.active().some(s => s.taskId === task.id) : false;
      const currentTask = task ? { revision: task.revision, status: task.status, activeSession: active ? "active" : null } : null;
      const duplicate = !task && this.repo.list(true).tasks.some(t => t.title.trim().toLocaleLowerCase() === candidate.title.trim().toLocaleLowerCase());
      const blockedReason = task && (task.revision !== candidate.baseRevision || task.status !== "open") ? "Досье изменилось после проверки. Нужен обновлённый вариант предложения."
        : active && candidate.changes.status ? "Сначала заверши рабочую сессию, чтобы изменить статус задачи."
        : duplicate ? "Задача с таким названием уже создана. Проверь, не дубликат ли это." : null;
      return { kind, candidate, currentTask, blockedReason };
    }
    const raw = this.repo.kernel.getProposal(id), dossier = this.repo.kernel.getDossier(raw.taskId);
    const proposal = { ...raw, evidence: this.repo.kernel.proposalEvidence(id), receipt: null };
    const sessions = this.repo.sessions(raw.taskId).filter(s => ACTIVE.has(s.status)).map(({ id, status, discussionProposalId }) => ({ id, status, discussionProposalId }));
    const update = this.repo.db.prepare("SELECT value_json FROM session_updates WHERE proposal_id=?").get(id) as { value_json: string } | undefined;
    const used = new Set(Object.values(raw.changes).flatMap(change => change?.evidenceRefs ?? []));
    const context = reviewDossierSchema.parse({ ...dossier, facts: dossier.facts.filter(f => used.has(f.id)), sessions, sessionUpdates: update ? [JSON.parse(update.value_json)] : [] });
    const blockedReason = raw.baseRevision !== dossier.task.revision ? "Досье изменилось после подготовки. Нужен результат по новой версии."
      : sessions.some(s => s.discussionProposalId === id) ? "Сначала заверши обсуждение этого разбора."
      : raw.changes.status && sessions.length ? "Сначала заверши рабочую сессию, чтобы изменить статус задачи." : null;
    return { kind, proposal, dossier: context, blockedReason };
  }
  list(offset = 0) {
    const rows = this.repo.db.prepare(`SELECT kind,id FROM (
      SELECT 'source' AS kind,id,created_at FROM (SELECT id,json_extract(value_json,'$.createdAt') AS created_at FROM source_sync_candidates WHERE status='pending')
      UNION ALL SELECT 'proposal' AS kind,id,created_at FROM proposals WHERE status IN ('pending','approved')
    ) ORDER BY created_at,kind,id LIMIT 50 OFFSET ?`).all(offset) as Row[];
    const items: ReviewItem[] = []; let bytes = 0;
    for (const row of rows) {
      const item = this.item(row.kind, row.id), size = Buffer.byteLength(JSON.stringify(item));
      if (items.length && bytes + size > 3 * 1024 * 1024) break;
      if (size > 3 * 1024 * 1024) throw new PolicyError("Предложение слишком большое для общего списка. Открой его в досье задачи.");
      items.push(item); bytes += size;
    }
    const total = this.repo.pendingTotal();
    return { items, total, nextOffset: offset + items.length < total ? offset + items.length : null };
  }
  async accept(items: ReviewSelection[]) {
    // A task revision can be approved once. Never arbitrarily pick the first of
    // two conflicting proposals selected in different tabs or a stale client.
    const taskIds = new Set<string>(), keys = new Set<string>();
    for (const item of items) {
      const key = `${item.kind}:${item.id}`;
      if (keys.has(key)) throw new PolicyError("Одно предложение выбрано несколько раз.");
      keys.add(key);
      let taskId: string | null;
      try { taskId = item.kind === "source" ? this.sync.candidate(item.id).taskId : this.repo.kernel.getProposal(item.id).taskId; }
      catch { continue; } // The per-item result below reports a missing entry.
      if (taskId && taskIds.has(taskId)) throw new PolicyError("Для одной задачи выбрано несколько предложений. Выбери одно; после принятия остальные потребуют обновления.");
      if (taskId) taskIds.add(taskId);
    }
    const applied: { kind: ReviewSelection["kind"]; id: string; taskId: string }[] = [];
    const failed: { kind: ReviewSelection["kind"]; id: string; message: string }[] = [];
    for (const item of items) {
      try {
        const value = item.kind === "source" ? this.sync.candidate(item.id) : this.repo.kernel.getProposal(item.id);
        if (value.baseRevision !== item.revision) throw new ConflictError("Предложение изменилось. Обнови список и проверь его ещё раз.");
        const dossier = item.kind === "source" ? this.sync.accept(item.id) : await this.runtime.accept(item.id, item.revision!);
        applied.push({ kind: item.kind, id: item.id, taskId: dossier.task.id });
      } catch (error) { failed.push({ kind: item.kind, id: item.id, message: error instanceof Error ? error.message : String(error) }); }
    }
    return { applied, failed };
  }
}
