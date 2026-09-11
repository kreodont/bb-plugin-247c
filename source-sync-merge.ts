import type { SyncCandidate, SyncDraft } from "./contracts.js";
import type { TaskDossier } from "./core/types.js";
import { PolicyError } from "./core/errors.js";

// A fresh read of the same source fact can replace its old receipt without
// multiplying the fact. Different messages, edits and quotations stay distinct.
function factIdentity(fact: SyncDraft["facts"][number]): string {
  return JSON.stringify([fact.kind, fact.text, fact.citations.map(c =>
    [c.source, c.url, c.messageId, c.occurredAt, c.quote]).sort()]);
}

export function mergeSyncDraft(draft: SyncDraft, parents: SyncCandidate[], dossier: TaskDossier): SyncDraft & { recordFactIndexes?: number[] } {
  if (!parents.length) return draft;
  const facts: SyncDraft["facts"] = [];
  const indices = new Map<string, number>();
  const add = (fact: SyncDraft["facts"][number]) => {
    const key = factIdentity(fact), existing = indices.get(key);
    if (existing !== undefined) return existing;
    const index = facts.length;
    facts.push(fact); indices.set(key, index);
    return index;
  };
  const remap = (refs: string[], positions: number[]) => refs.map(ref =>
    /^fact:\d+$/.test(ref) && positions[Number(ref.slice(5))] !== undefined
      ? "fact:" + positions[Number(ref.slice(5))] : ref);
  const omitted = new Set(parents.flatMap(parent => parent.recordFactIndexes
    ? parent.facts.filter((_, i) => !parent.recordFactIndexes!.includes(i)).map(factIdentity) : []));
  const records = new Set<number>();
  const positions = draft.facts.map(fact => { const i = add(fact); if (!omitted.has(factIdentity(fact))) records.add(i); return i; });
  const changes = Object.fromEntries(Object.entries(draft.changes).map(([field, change]) =>
    [field, { ...change, evidenceRefs: remap(change!.evidenceRefs, positions) }])) as SyncDraft["changes"];
  const previous = new Map<string, { change: NonNullable<SyncDraft["changes"][keyof SyncDraft["changes"]]>; parent: SyncCandidate }[]>();
  for (const parent of parents) {
    const indices = parent.facts.map((fact, index) => { const i = add(fact); if (!parent.recordFactIndexes || parent.recordFactIndexes.includes(index)) records.add(i); return i; });
    for (const [field, change] of Object.entries(parent.changes)) {
      const entries = previous.get(field) ?? [];
      entries.push({ parent, change: { ...change!, evidenceRefs: remap(change!.evidenceRefs, indices) } });
      previous.set(field, entries);
    }
  }
  const current = { ...dossier.task, ...dossier.planning, ...dossier.projection };
  for (const [field, entries] of previous) {
    if (field in changes) continue;
    const unresolved = entries.filter(({ change }) => !draft.taskId ||
      JSON.stringify(change.value) !== JSON.stringify(current[field as keyof typeof current]));
    if (!unresolved.length) continue;
    const values = new Set(unresolved.map(({ change }) => JSON.stringify(change.value)));
    if (values.size > 1 || unresolved.some(({ parent }) => parent.taskId && parent.baseRevision !== dossier.task.revision)) {
      throw new PolicyError("Reconcile the previous " + field + " changes explicitly against the current dossier. The pending proposals are preserved.");
    }
    Object.assign(changes, { [field]: { ...unresolved[0].change,
      evidenceRefs: [...new Set(unresolved.flatMap(({ change }) => change.evidenceRefs))] } });
  }
  if (facts.length > 300) throw new PolicyError("The combined proposal exceeds 300 distinct facts. The pending proposals are preserved.");
  return { ...draft, facts, changes, mergeCandidateIds: parents.map(p => p.id), ...(parents.some(p => p.recordFactIndexes) ? { recordFactIndexes: [...records].sort((a, b) => a - b) } : {}) };
}
