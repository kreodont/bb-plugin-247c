import { PolicyError } from "./errors.js";
import type { Artifact, ProposalEvidence, ProposedValue, StewardChanges, StewardProposalDraft, TaskDossier } from "./types.js";

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PolicyError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function onlyKeys(record: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(record).find((key) => !allowedSet.has(key));
  if (unknown) throw new PolicyError(`${label} contains unsupported field: ${unknown}`);
}

function evidence(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new PolicyError(`${label}.evidenceRefs must be an array of fact ids`);
  }
  return [...new Set(value)];
}

function proposed<T>(
  input: unknown,
  label: string,
  parseValue: (value: unknown) => T,
): ProposedValue<T> {
  const record = object(input, label);
  onlyKeys(record, ["value", "evidenceRefs"], label);
  return {
    value: parseValue(record.value),
    evidenceRefs: evidence(record.evidenceRefs, label),
  };
}

function nullableString(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.trim() === "") throw new PolicyError("value must be a non-empty string or null");
  return value.trim();
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.trim() === "")) {
    throw new PolicyError("value must be an array of non-empty strings");
  }
  return value.map((entry) => entry.trim());
}

function artifacts(value: unknown): Artifact[] {
  if (!Array.isArray(value)) throw new PolicyError("artifacts must be an array");
  return value.map((entry, index) => {
    const record = object(entry, `artifact[${index}]`);
    onlyKeys(record, ["label", "uri"], `artifact[${index}]`);
    if (typeof record.label !== "string" || typeof record.uri !== "string") {
      throw new PolicyError(`artifact[${index}] needs string label and uri`);
    }
    return { label: record.label, uri: record.uri };
  });
}

export function parseProposalDraft(input: unknown): StewardProposalDraft {
  const record = object(input, "proposal");
  onlyKeys(record, ["rationale", "confidence", "changes"], "proposal");
  if (typeof record.rationale !== "string" || record.rationale.trim() === "") {
    throw new PolicyError("proposal.rationale must be a non-empty string");
  }
  if (typeof record.confidence !== "number" || record.confidence < 0 || record.confidence > 1) {
    throw new PolicyError("proposal.confidence must be between 0 and 1");
  }
  const rawChanges = object(record.changes, "proposal.changes");
  onlyKeys(rawChanges, ["title", "status", "urgent", "important", "summary", "nextStep", "openQuestions", "blockers", "artifacts"], "proposal.changes");
  const changes: StewardChanges = {};
  if ("title" in rawChanges) changes.title = proposed(rawChanges.title, "title", (value) => {
    if (typeof value !== "string" || !value.trim() || value.trim().length > 200) throw new PolicyError("Название должно содержать от 1 до 200 символов.");
    return value.trim();
  });
  for (const field of ["urgent", "important"] as const) {
    if (field in rawChanges) changes[field] = proposed(rawChanges[field], field, (value) => {
      if (value !== null && typeof value !== "boolean") throw new PolicyError("Приоритет должен быть true, false или null.");
      return value;
    });
  }
  if ("status" in rawChanges) changes.status = proposed(rawChanges.status, "status", (value) => {
    if (value !== "open" && value !== "done" && value !== "archived") throw new PolicyError("proposed status must be open, done or archived");
    return value;
  });
  if ("summary" in rawChanges) changes.summary = proposed(rawChanges.summary, "summary", nullableString);
  if ("nextStep" in rawChanges) changes.nextStep = proposed(rawChanges.nextStep, "nextStep", nullableString);
  if ("openQuestions" in rawChanges) changes.openQuestions = proposed(rawChanges.openQuestions, "openQuestions", stringArray);
  if ("blockers" in rawChanges) changes.blockers = proposed(rawChanges.blockers, "blockers", stringArray);
  if ("artifacts" in rawChanges) changes.artifacts = proposed(rawChanges.artifacts, "artifacts", artifacts);
  if (Object.keys(changes).length === 0) throw new PolicyError("proposal contains no changes");
  return { rationale: record.rationale.trim(), confidence: record.confidence, changes };
}

export function validateEvidence(draft: StewardProposalDraft, dossier: TaskDossier, additional: readonly ProposalEvidence[] = []): void {
  const facts = new Map([
    ...dossier.facts.map((fact) => [fact.id, fact] as const),
    ...additional.map((item) => [item.ref, { ...item, id: item.ref, taskId: dossier.task.id, occurredAt: dossier.task.updatedAt, createdAt: dossier.task.updatedAt }] as const),
  ]);
  for (const [field, change] of Object.entries(draft.changes)) {
    if (!change) continue;
    if (change.evidenceRefs.length === 0) throw new PolicyError(`${field} needs evidence`);
    for (const reference of change.evidenceRefs) {
      if (!facts.has(reference)) throw new PolicyError(`${field} cites unknown task fact ${reference}`);
    }
  }

  const status = draft.changes.status;
  if (status && !status.evidenceRefs.some((id) => ["progress", "decision", "user_instruction"].includes(facts.get(id)!.kind))) {
    throw new PolicyError("Изменение статуса требует основания о результате или решения по задаче.");
  }
  for (const field of ["title", "urgent", "important"] as const) {
    const change = draft.changes[field];
    if (change && !change.evidenceRefs.some((id) => ["decision", "user_instruction"].includes(facts.get(id)!.kind))) {
      throw new PolicyError(`${field}: требуется решение или поручение об изменении задачи.`);
    }
  }

  const nextStep = draft.changes.nextStep;
  if (nextStep) {
    const explicitKinds = new Set(["explicit_next_step", "user_instruction"]);
    if (nextStep.value === null) {
      // A fulfilled or cancelled step can be cleared while the larger task
      // remains open. This proposes removing an action, not assigning a new one;
      // the supporting result/decision and its meaning still need human review.
      const clearingKinds = new Set([...explicitKinds, "progress", "decision"]);
      if (!nextStep.evidenceRefs.some((id) => clearingKinds.has(facts.get(id)!.kind))) {
        throw new PolicyError("Очистка nextStep требует progress/decision о выполнении или отмене шага, либо explicit_next_step/user_instruction. Завершать всю задачу для этого не нужно.");
      }
    } else {
      if (!nextStep.evidenceRefs.some((id) => explicitKinds.has(facts.get(id)!.kind))) {
        throw new PolicyError("nextStep needs explicit_next_step or user_instruction evidence");
      }
      const normalized = normalizeText(nextStep.value);
      const matches = nextStep.evidenceRefs.some((id) => {
        const fact = facts.get(id)!;
        return explicitKinds.has(fact.kind) && normalizeText(fact.text) === normalized;
      });
      if (!matches) throw new PolicyError("nextStep must exactly match explicit evidence");
    }
  }

  // A summary is a proposed paraphrase for human review. Token overlap cannot
  // verify meaning: inflection and attribution caused false rejections, while
  // a high-overlap sentence can still contradict its evidence. Require real
  // evidence refs above; conversation facts additionally require source quotes.

  const questions = draft.changes.openQuestions;
  if (questions?.value.length) {
    const questionFacts = questions.evidenceRefs.map((id) => facts.get(id)!).filter((fact) => fact.kind === "open_question");
    for (const value of questions.value) {
      if (!questionFacts.some((fact) => normalizeText(fact.text) === normalizeText(value))) {
        throw new PolicyError("each open question must exactly match open_question evidence");
      }
    }
  }


  const blockers = draft.changes.blockers;
  if (blockers?.value.length) {
    const blockerFacts = blockers.evidenceRefs.map((id) => facts.get(id)!).filter((fact) => fact.kind === "blocker" || fact.kind === "constraint");
    if (blockerFacts.length === 0) throw new PolicyError("blockers need blocker or constraint evidence");
    for (const value of blockers.value) {
      if (!blockerFacts.some((fact) => normalizeText(fact.text) === normalizeText(value))) {
        throw new PolicyError("each blocker must exactly match blocker evidence");
      }
    }
  }


  const artifacts = draft.changes.artifacts;
  if (artifacts?.value.length) {
    const artifactFacts = artifacts.evidenceRefs.map((id) => facts.get(id)!).filter((fact) => fact.kind === "artifact");
    for (const artifact of artifacts.value) {
      let protocol: string;
      try { protocol = new URL(artifact.uri).protocol; } catch { throw new PolicyError("artifact URI must be absolute"); }
      if (!new Set(["https:", "http:", "file:"]).has(protocol)) throw new PolicyError("artifact URI scheme is not allowed");
      if (!artifactFacts.some((fact) => fact.sourceRef === artifact.uri)) throw new PolicyError("each artifact URI must exactly match artifact evidence");
    }
  }
}

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}
