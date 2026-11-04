import { randomUUID } from "node:crypto";
import { syncCandidateSchema, type ProposalRefreshInput } from "./contracts.js";
import { ConflictError, PolicyError } from "./core/errors.js";
import { acceptedEvidence } from "./conversation.js";
import { partitionParts, pickChanges, sourceParts } from "./proposal-parts.js";
import { SourceSyncStore, validateSyncDraft } from "./source-sync.js";

export function sourceProposalRefreshPreview(store: SourceSyncStore, proposalId: string) {
  const old = store.candidate(proposalId);
  if (!old.taskId) throw new PolicyError("Only proposals for existing tasks can be refreshed.");
  const dossier = store.repo.kernel.getDossier(old.taskId);
  const blockedReason = old.status !== "pending" ? "This proposal has already been reviewed. Refresh the list."
    : old.baseRevision === dossier.task.revision ? "This proposal already uses the current task."
    : store.repo.active().some(session => session.taskId === old.taskId) ? "Finish the active work or review discussion before refreshing this proposal." : null;
  return { proposalId, revision: dossier.task.revision, safe: false, blockedReason, dossier,
    reason: "Review the current task and select the changes to keep. The saved source findings will be preserved; sources will not be checked again." };
}

export function refreshSourceProposal(store: SourceSyncStore, input: ProposalRefreshInput) {
  const repo = store.repo;
  const result = repo.request(input.requestId, { kind: "refresh-source-proposal", input }, () => {
    const preview = sourceProposalRefreshPreview(store, input.proposalId);
    if (preview.revision !== input.revision) throw new ConflictError("The task changed again. Review its latest version before refreshing the proposal.");
    if (preview.blockedReason) throw new PolicyError(preview.blockedReason);
    if (!input.reviewed) throw new PolicyError("Review the current task and confirm the selected parts first.");
    const old = store.candidate(input.proposalId), dossier = preview.dossier;
    const split = partitionParts(sourceParts(old), { parts: input.parts, decision: "accept" });
    const changes = pickChanges(old.changes, input.parts);
    // Positional accepted:* references must not silently acquire new meanings.
    const before = old.before ? acceptedEvidence({ task: dossier.task, projection: { ...dossier.projection, ...old.before } }) : [];
    const current = acceptedEvidence(dossier);
    for (const [field, change] of Object.entries(changes)) for (const ref of change?.evidenceRefs ?? []) {
      if (!ref.startsWith("accepted:")) continue;
      const prior = before.find(item => item.ref === ref), next = current.find(item => item.ref === ref);
      if (!prior || !next || prior.text !== next.text || prior.sourceRef !== next.sourceRef) {
        throw new PolicyError(`The accepted evidence for ${field} changed. Uncheck that field or request a new source analysis.`);
      }
    }
    const replacement = syncCandidateSchema.parse({ ...old, id: randomUUID(), partReview: undefined,
      baseRevision: preview.revision, title: dossier.task.title,
      before: { ...dossier.projection, ...dossier.planning, title: dossier.task.title, status: dossier.task.status },
      changes, actions: old.actions?.filter(action => input.parts.includes(`action:${action}`)), chatDelivery: undefined,
      recordFactIndexes: input.parts.filter(part => part.startsWith("fact:")).map(part => Number(part.slice(5))),
      createdAt: new Date().toISOString(), resolvedAt: null, status: "pending", proposalId: null, resultTaskId: null });
    delete replacement.partReview;
    delete replacement.chatDelivery;
    if (replacement.actions === undefined) delete replacement.actions;
    // These immutable receipts were validated when the pending candidate was saved.
    // Recheck field evidence and closed-task rules against today's accepted dossier.
    validateSyncDraft(replacement, store.run(old.runId), [dossier], [], old.facts);
    if (replacement.actions?.includes("reopen") && dossier.task.status === "waiting" && !replacement.changes.nextStep?.value) {
      throw new PolicyError("Keep the source-supported next step when selecting Reopen task.");
    }
    repo.db.prepare("INSERT INTO source_sync_candidates VALUES (?,?,?,?,?,?)").run(replacement.id, replacement.runId,
      replacement.taskId, replacement.status, `refresh:${input.requestId}`, JSON.stringify(replacement));
    repo.db.prepare("UPDATE source_sync_candidates SET status=?,value_json=? WHERE id=?").run("superseded",
      JSON.stringify({ ...old, status: "superseded", resolvedAt: replacement.createdAt }), old.id);
    repo.savePartReview("source", old.id, { accepted: [], rejected: split.remaining, remaining: input.parts,
      acceptedId: null, remainingId: replacement.id, createdAt: replacement.createdAt });
    return replacement;
  });
  repo.changed();
  return result;
}
