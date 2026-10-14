import type { Dossier } from "./contracts.js";

export const CONTEXT_COMPACTION_THRESHOLD_BYTES = 48 * 1024;
export const CONTEXT_TARGET_BYTES = 32 * 1024;
const RECENT_PROGRESS_MINIMUM = 3;
const RECENT_PROGRESS_MAXIMUM = 12;

export function acceptedDossier(dossier: Dossier) {
  const { task, projection, planning, facts, sourceLinks, primarySource, sourceRevision } = dossier;
  return { task, projection, planning, facts, sourceLinks, primarySource, sourceRevision };
}

// A derived reading view, never a replacement for accepted evidence. In
// particular, do not ask a model to rewrite instructions or infer which old
// decisions have expired. The accepted projection remains the current state.
export function workingDossier(dossier: Dossier) {
  const accepted = acceptedDossier(dossier);
  const fullBytes = Buffer.byteLength(JSON.stringify(accepted));
  const selected = new Set<string>();
  if (fullBytes <= CONTEXT_COMPACTION_THRESHOLD_BYTES) {
    for (const fact of accepted.facts) selected.add(fact.id);
  } else {
    for (const fact of accepted.facts) {
      if ((fact.kind !== "progress" && fact.kind !== "explicit_next_step")
        || fact.text === accepted.projection.nextStep) selected.add(fact.id);
    }
    // Acceptance time matters: a newly accepted correction may describe an
    // older event. Use the original position to break equal timestamp ties.
    const progress = accepted.facts.map((fact, index) => ({ fact, index }))
      .filter(({ fact }) => fact.kind === "progress")
      .sort((a, b) => b.fact.createdAt.localeCompare(a.fact.createdAt) || b.index - a.index);
    for (const { fact } of progress.slice(0, RECENT_PROGRESS_MINIMUM)) selected.add(fact.id);
    let bytes = Buffer.byteLength(JSON.stringify({ ...accepted, facts: accepted.facts.filter(fact => selected.has(fact.id)) }));
    for (const { fact } of progress.slice(RECENT_PROGRESS_MINIMUM, RECENT_PROGRESS_MAXIMUM)) {
      const extra = Buffer.byteLength(JSON.stringify(fact)) + 1;
      // Keep a contiguous recent window instead of cherry-picking short facts.
      if (bytes + extra > CONTEXT_TARGET_BYTES) break;
      selected.add(fact.id); bytes += extra;
    }
  }
  const facts = accepted.facts.filter(fact => selected.has(fact.id));
  const deferred = accepted.facts.filter(fact => !selected.has(fact.id));
  const deferredByKind: Record<string, number> = {};
  for (const fact of deferred) deferredByKind[fact.kind] = (deferredByKind[fact.kind] ?? 0) + 1;
  const dates = deferred.map(fact => fact.createdAt).sort();
  return { ...accepted, facts, compaction: {
    version: 1, applied: deferred.length > 0, totalFacts: accepted.facts.length,
    includedFacts: facts.length, deferredFacts: deferred.length, deferredByKind,
    deferredAcceptedFrom: dates[0] ?? null, deferredAcceptedThrough: dates.at(-1) ?? null,
    fullAcceptedBytes: fullBytes, thresholdBytes: CONTEXT_COMPACTION_THRESHOLD_BYTES,
    targetBytes: CONTEXT_TARGET_BYTES,
    summarySource: "Current accepted projection; no generated summary or evidence rewriting.",
    policy: "Keep all descriptions, instructions, constraints, decisions, questions, blockers, artifacts, exact current next-step evidence and at least the three latest accepted progress facts. Older progress and next-step records remain available on demand. The size target is soft: protected records are never truncated.",
    history: { section: "facts", query: "Optional keywords (all must match), factIds or kinds; omit filters to read all accepted facts." },
  } };
}
