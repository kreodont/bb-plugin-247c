export const factKinds = [
  "description",
  "progress",
  "user_instruction",
  "explicit_next_step",
  "decision",
  "open_question",
  "artifact",
  "constraint",
  "blocker",
] as const;

export type FactKind = (typeof factKinds)[number];

export interface TaskRecord {
  id: string;
  title: string;
  status: import("../task-status.js").TaskStatus;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface TaskFact {
  id: string;
  taskId: string;
  kind: FactKind;
  text: string;
  source: string;
  sourceRef: string | null;
  occurredAt: string;
  createdAt: string;
}

export interface Artifact {
  label: string;
  uri: string;
}

export interface TaskProjection {
  taskId: string;
  summary: string | null;
  nextStep: string | null;
  openQuestions: string[];
  blockers: string[];
  artifacts: Artifact[];
  updatedAt: string;
}

export interface TaskDossier {
  task: TaskRecord;
  projection: TaskProjection;
  facts: TaskFact[];
  planning: { urgent: boolean | null; important: boolean | null; revision: number };
}

export interface ProposedValue<T> {
  value: T;
  evidenceRefs: string[];
}

export interface StewardChanges {
  title?: ProposedValue<string>;
  status?: ProposedValue<TaskRecord["status"]>;
  urgent?: ProposedValue<boolean | null>;
  important?: ProposedValue<boolean | null>;
  summary?: ProposedValue<string | null>;
  nextStep?: ProposedValue<string | null>;
  openQuestions?: ProposedValue<string[]>;
  blockers?: ProposedValue<string[]>;
  artifacts?: ProposedValue<Artifact[]>;
}

export interface StewardProposalDraft {
  rationale: string;
  confidence: number;
  changes: StewardChanges;
}

export type ProposalStatus = "pending" | "approved" | "applied" | "rejected" | "conflicted";

export interface StewardProposal extends StewardProposalDraft {
  id: string;
  taskId: string;
  baseRevision: number;
  model: string;
  status: ProposalStatus;
  createdAt: string;
  resolvedAt: string | null;
  idempotencyKey: string | null;
}

/** Durable proposal-only evidence. It is never canonical task truth. */
export interface ProposalEvidence {
  ref: string;
  kind: FactKind;
  text: string;
  source: string;
  sourceRef: string | null;
}

export interface PreparedTaskBrief {
  taskId: string;
  revision: number;
  markdown: string;
}

export interface ProposalApproval {
  id: string;
  proposalId: string;
  proposalHash: string;
  actor: string;
  createdAt: string;
}

export interface ApplicationReceipt {
  id: string;
  proposalId: string;
  approvalId: string;
  taskId: string;
  beforeRevision: number;
  afterRevision: number;
  fields: string[];
  createdAt: string;
}

export interface StewardModel {
  readonly name: string;
  propose(dossier: TaskDossier): Promise<unknown>;
}
