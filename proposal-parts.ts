import type { Extraction, PartDecision, SyncCandidate } from "./contracts.js";
import type { ProposalEvidence, StewardChanges, TaskDossier } from "./core/types.js";
import { PolicyError } from "./core/errors.js";

export function proposalParts(changes: StewardChanges, extraction?: Extraction): string[] {
  return [...Object.keys(extraction ? extraction.changes ?? {} : changes).map(field => `field:${field}`),
    ...(extraction?.facts.map((_, i) => `fact:${i}`) ?? []),
    ...(extraction?.knowledge.map((_, i) => `knowledge:${i}`) ?? [])];
}

export function sourceParts(candidate: SyncCandidate): string[] {
  return [...Object.keys(candidate.changes).map(field => `field:${field}`),
    ...(candidate.recordFactIndexes ?? candidate.facts.map((_, i) => i)).map(i => `fact:${i}`)];
}

export function partitionParts(all: string[], input: Pick<PartDecision, "parts" | "decision">) {
  const selected = new Set(input.parts);
  if (!selected.size || selected.size !== input.parts.length || input.parts.some(part => !all.includes(part))) {
    throw new PolicyError("Select distinct parts from this proposal. Refresh if it changed.");
  }
  return {
    accepted: input.decision === "accept" ? input.parts : [],
    rejected: input.decision === "reject" ? input.parts : [],
    remaining: all.filter(part => !selected.has(part)),
  };
}

export function pickChanges(changes: StewardChanges, parts: string[]): StewardChanges {
  return Object.fromEntries(Object.entries(changes).filter(([field]) => parts.includes(`field:${field}`)));
}

export function extractionRefMap(extraction: Extraction, parts: string[], proposalId: string) {
  let index = 0;
  return new Map(extraction.facts.map((_, i) => [`fact:${i}`, parts.includes(`fact:${i}`) ? `fact:${index++}` : `review:${proposalId}:fact:${i}`]));
}

export function pickExtraction(extraction: Extraction, parts: string[], proposalId: string): Extraction {
  const refs = extractionRefMap(extraction, parts, proposalId);
  const remap = (values: string[]) => values.map(ref => refs.get(ref) ?? ref);
  const changes = Object.fromEntries(Object.entries(pickChanges(extraction.changes ?? {}, parts))
    .map(([field, change]) => [field, { ...change, evidenceRefs: remap(change!.evidenceRefs) }]));
  return { ...extraction, changes: Object.keys(changes).length ? changes : null,
    facts: extraction.facts.filter((_, i) => parts.includes(`fact:${i}`)),
    knowledge: extraction.knowledge.filter((_, i) => parts.includes(`knowledge:${i}`)).map(entry => ({ ...entry, evidenceRefs: remap(entry.evidenceRefs) })) };
}

// Records-only approvals use the existing receipted no-op projection pattern.
// Evidence remains an immutable source, independently of which records are saved.
export function receiptDraft(changes: StewardChanges, dossier: TaskDossier, evidence: ProposalEvidence[]) {
  if (Object.keys(changes).length) return { changes, evidence };
  const ref = "partial-review:unchanged-summary";
  return { changes: { summary: { value: dossier.projection.summary, evidenceRefs: [ref] } },
    evidence: [...evidence.filter(e => e.ref !== ref), { ref, kind: "description" as const,
      text: dossier.projection.summary ?? "Keep the accepted summary unchanged.", source: "accepted-projection", sourceRef: null }] };
}
