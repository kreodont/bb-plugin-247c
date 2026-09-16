import { randomUUID } from "node:crypto";
import type { Repository } from "./repository.js";
import { sessionUpdateSchema, type ProposalRefreshInput } from "./contracts.js";
import { ConflictError, PolicyError } from "./core/errors.js";
import { extractionRefMap, partitionParts, pickChanges, pickExtraction, proposalParts, receiptDraft } from "./proposal-parts.js";

function updateFor(repo: Repository, id: string) {
  const row = repo.db.prepare("SELECT value_json FROM session_updates WHERE proposal_id=?").get(id) as { value_json: string } | undefined;
  return row ? sessionUpdateSchema.parse(JSON.parse(row.value_json)) : undefined;
}

export function proposalRefreshPreview(repo: Repository, proposalId: string) {
  const proposal = repo.kernel.getProposal(proposalId), dossier = repo.kernel.getDossier(proposal.taskId);
  const blockedReason = proposal.status !== "pending" ? "This proposal has already been reviewed. Refresh the list."
    : proposal.baseRevision === dossier.task.revision ? "This proposal already uses the current task."
    : repo.active().some(session => session.taskId === proposal.taskId) ? "Finish the active work or review discussion before refreshing this proposal." : null;
  // Use event sequence, not wall-clock timestamps: multiple edits may share a millisecond.
  const created = repo.db.prepare("SELECT sequence FROM kernel_events WHERE task_id=? AND type='proposal.created' AND json_extract(payload_json,'$.proposalId')=? ORDER BY sequence DESC LIMIT 1").get(proposal.taskId, proposal.id) as { sequence: number } | undefined;
  const events = created ? repo.db.prepare("SELECT type FROM kernel_events WHERE task_id=? AND sequence>? ORDER BY sequence").all(proposal.taskId, created.sequence) as { type: string }[] : [];
  const neutral = new Set(["proposal.created", "proposal.approved", "proposal.rejected", "proposal.conflicted", "proposal.refreshed"]);
  const edits = events.filter(event => !neutral.has(event.type));
  const priorityOnly = Boolean(created) && edits.length > 0 && edits.length === dossier.task.revision - proposal.baseRevision && edits.every(event => event.type === "planning.changed");
  // Conversation records and knowledge can also depend on priority. They require a human review.
  const safe = !blockedReason && priorityOnly && !proposal.changes.urgent && !proposal.changes.important && !updateFor(repo, proposalId);
  return { proposalId, revision: dossier.task.revision, safe, blockedReason, dossier,
    reason: safe ? "Only priority changed. This proposal does not change priority; its contents can be kept without another model run."
      : priorityOnly ? "Priority changed. Review the current task and select the parts you still want to keep."
      : "The task content changed, or its earlier context cannot be verified. Review the current task before keeping any proposed changes." };
}

export function refreshProposal(repo: Repository, input: ProposalRefreshInput) {
  const result = repo.request(input.requestId, { kind: "refresh-proposal", input }, () => {
    const preview = proposalRefreshPreview(repo, input.proposalId);
    if (preview.revision !== input.revision) throw new ConflictError("The task changed again. Review its latest version before refreshing the proposal.");
    if (preview.blockedReason) throw new PolicyError(preview.blockedReason);
    const old = repo.kernel.getProposal(input.proposalId), update = updateFor(repo, old.id);
    const all = proposalParts(old.changes, update?.extraction);
    const split = partitionParts(all, { parts: input.parts, decision: "accept" });
    if (!input.reviewed && (!preview.safe || input.parts.length !== all.length)) throw new PolicyError("Review the current task and confirm the selected parts first.");
    const extraction = update ? pickExtraction(update.extraction, input.parts, old.id) : undefined;
    const refs = update ? extractionRefMap(update.extraction, input.parts, old.id) : new Map<string, string>();
    const draft = receiptDraft(extraction ? extraction.changes ?? {} : pickChanges(old.changes, input.parts), preview.dossier,
      repo.kernel.proposalEvidence(old.id).map(evidence => ({ ...evidence, ref: refs.get(evidence.ref) ?? evidence.ref })));
    const replacement = repo.kernel.createProposal({ taskId: old.taskId, baseRevision: preview.revision, model: old.model,
      output: { rationale: old.rationale, confidence: old.confidence, changes: draft.changes }, additionalEvidence: draft.evidence,
      idempotencyKey: `refresh:${input.requestId}` });
    if (update && extraction) repo.db.prepare("INSERT INTO session_updates VALUES (?,?,?)").run(replacement.id, update.sessionId, JSON.stringify({ ...update, proposalId: replacement.id, extraction }));
    // Retire the original only after the replacement validates. No task fields, records,
    // approvals, transcripts or measured/manual time change during this transaction.
    repo.kernel.rejectProposal(old.id);
    for (const session of repo.sessions(old.taskId)) if (session.proposalId === old.id) repo.saveSession({ ...session,
      proposalId: replacement.id, baseRevision: preview.revision, status: "awaiting_approval", ...(extraction ? { extraction } : {}) });
    repo.savePartReview("proposal", old.id, { accepted: [], rejected: split.remaining, remaining: input.parts,
      acceptedId: null, remainingId: replacement.id, createdAt: new Date().toISOString() });
    repo.db.prepare("INSERT INTO kernel_events(id,task_id,type,payload_json,created_at) VALUES (?,?,?,?,?)").run(randomUUID(), old.taskId, "proposal.refreshed",
      JSON.stringify({ proposalId: replacement.id, replacesId: old.id, fromRevision: old.baseRevision, revision: preview.revision, reviewed: input.reviewed, parts: input.parts }), new Date().toISOString());
    return replacement;
  });
  repo.changed();
  return result;
}
