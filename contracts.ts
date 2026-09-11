import { z } from "zod";
import { defineRpcContract, type NewThreadRequest } from "@get-bb/plugin-sdk";
import { dayRpcContract } from "./day-contracts.js";

export const idSchema = z.string().min(1).max(120);
export const revisionSchema = z.number().int().nonnegative();
export const statusSchema = z.enum(["open", "done", "archived"]);
export const factKindSchema = z.enum(["description", "progress", "user_instruction", "explicit_next_step", "decision", "open_question", "artifact", "constraint", "blocker"]);
export const axisSchema = z.boolean().nullable();
const text = z.string().trim().min(1).max(12000);
export const artifactSchema = z.object({ label: z.string().min(1).max(300), uri: z.string().min(1).max(4096) }).strict();
const refs = z.array(z.string().min(1).max(256)).min(1).max(80);
const proposed = <T extends z.ZodType>(value: T) => z.object({ value, evidenceRefs: refs }).strict();
export const changesSchema = z.object({
  title: proposed(z.string().trim().min(1).max(200)).optional(),
  status: proposed(statusSchema).optional(),
  urgent: proposed(axisSchema).optional(),
  important: proposed(axisSchema).optional(),
  summary: proposed(text.nullable()).optional(),
  nextStep: proposed(text.nullable()).optional(),
  openQuestions: proposed(z.array(text).max(30)).optional(),
  blockers: proposed(z.array(text).max(30)).optional(),
  artifacts: proposed(z.array(artifactSchema).max(20)).optional(),
}).strict().refine((v) => Object.keys(v).length > 0, "The proposal contains no changes.");
export const draftSchema = z.object({ rationale: text, confidence: z.number().min(0).max(1), changes: changesSchema }).strict();
export const taskSchema = z.object({ id: idSchema, title: z.string(), status: statusSchema, revision: revisionSchema, createdAt: z.string(), updatedAt: z.string() });
export const planningSchema = z.object({ urgent: axisSchema, important: axisSchema, revision: revisionSchema });
export const taskCardSchema = taskSchema.extend({ planning: planningSchema, summary: z.string().nullable(), nextStep: z.string().nullable(), pendingCount: z.number(), activeSession: z.string().nullable() });
export const factSchema = z.object({ id: idSchema, taskId: idSchema, kind: factKindSchema, text: z.string(), source: z.string(), sourceRef: z.string().nullable(), occurredAt: z.string(), createdAt: z.string() });
export const projectionSchema = z.object({ taskId: idSchema, summary: z.string().nullable(), nextStep: z.string().nullable(), openQuestions: z.array(z.string()), blockers: z.array(z.string()), artifacts: z.array(artifactSchema), updatedAt: z.string() });
export const evidenceSchema = z.object({ ref: z.string(), kind: factKindSchema, text: z.string(), source: z.string(), sourceRef: z.string().nullable() });
export const proposalSchema = z.object({
  id: idSchema, taskId: idSchema, baseRevision: revisionSchema, model: z.string(), status: z.enum(["pending", "approved", "applied", "rejected", "conflicted"]),
  createdAt: z.string(), resolvedAt: z.string().nullable(), idempotencyKey: z.string().nullable(), rationale: z.string(), confidence: z.number(), changes: changesSchema,
});
export const proposalViewSchema = proposalSchema.extend({ evidence: z.array(evidenceSchema), receipt: z.object({ id: z.string(), beforeRevision: z.number(), afterRevision: z.number(), createdAt: z.string() }).nullable() });

export const resultSchema = z.object({
  summary: text,
  artifacts: z.array(z.object({ path: z.string().min(1).max(4096), label: z.string().min(1).max(300) }).strict()).max(20),
}).strict();
export const observedArtifactSchema = z.object({ ref: z.string(), path: z.string(), label: z.string(), sha256: z.string(), text: z.string(), bytes: z.number() });
export const reviewSchema = z.object({
  verdict: z.enum(["pass", "repair", "blocked"]),
  findings: z.array(z.string().min(1).max(2000)).max(30),
  criteria: z.array(z.object({ index: z.number().int().nonnegative(), passed: z.boolean(), reason: z.string().min(1).max(3000), evidenceRefs: z.array(z.string().min(1).max(256)).max(40) }).strict()).min(1).max(20),
}).strict();
export const citationSchema = z.object({ messageRef: idSchema, quote: z.string().trim().min(1).max(1500) }).strict();
export const extractedFactSchema = z.object({
  kind: factKindSchema.exclude(["artifact"]), text: z.string().trim().min(1).max(3000),
  citations: z.array(citationSchema).min(1).max(5),
}).strict();
export const knowledgeDraftSchema = z.object({
  title: z.string().trim().min(1).max(200), body: z.string().trim().min(1).max(6000),
  tags: z.array(z.string().trim().min(1).max(60)).max(10), evidenceRefs: refs,
}).strict();
export const extractionSchema = z.object({
  rationale: text, facts: z.array(extractedFactSchema).max(30),
  // null is valid when only facts/knowledge changed, or the conversation adds nothing.
  changes: changesSchema.nullable(), knowledge: z.array(knowledgeDraftSchema).max(10),
}).strict();
export const transcriptSchema = z.object({
  capturedAt: z.string(), threadId: idSchema,
  messages: z.array(z.object({ ref: idSchema, role: z.enum(["user", "assistant", "context"]), text: z.string(), sequence: z.number(), source: z.object({ threadId: idSchema, messageRef: idSchema }).optional() })),
  warnings: z.array(z.string()),
});
const conversationKnowledgeEntrySchema = knowledgeDraftSchema.extend({
  kind: z.literal("conversation").default("conversation"),
  id: idSchema, taskId: idSchema, taskTitle: z.string(), sessionId: idSchema,
  threadId: idSchema, proposalId: idSchema, createdAt: z.string(),
});
const knowledgeFileBodySchema = z.string().max(131072).refine((value) => new TextEncoder().encode(value).length <= 131072 && new TextEncoder().encode(JSON.stringify(value)).length <= 262144, "The document exceeds 128 KiB.");
const knowledgeSourceSchema = z.object({
  label: z.string().trim().min(1).max(200), hostId: idSchema,
  rootPath: z.string().min(1).max(2000).refine((value) => value.startsWith("/") && !value.includes("\0") && !value.split("/").some((part) => part === "." || part === ".."), "An absolute path to the source folder is required."),
}).strict();
export const knowledgeFileInputSchema = z.object({
  relativePath: z.string().min(1).max(2000).refine((value) => /\.md$/i.test(value) && !value.includes("\0") && !value.includes("\\") && value.split("/").every((part) => part !== "" && part !== "." && part !== ".."), "A relative path to a Markdown file within the source is required."),
  title: z.string().trim().min(1).max(200), body: knowledgeFileBodySchema,
  tags: z.array(z.string().trim().min(1).max(60)).max(10).default([]),
  modifiedAt: z.iso.datetime().nullable().default(null),
}).strict();
export const knowledgeImportSchema = z.object({
  requestId: z.uuid(), source: knowledgeSourceSchema,
  documents: z.array(knowledgeFileInputSchema).min(1).max(500),
}).strict().refine((value) => new Set(value.documents.map((document) => document.relativePath)).size === value.documents.length, "The same file is listed twice.")
  .refine((value) => new TextEncoder().encode(JSON.stringify(value)).length <= 4 * 1024 * 1024, "Import documents in batches of up to 4 MiB.");
export const fileKnowledgeEntrySchema = z.object({
  kind: z.literal("file"), id: idSchema, title: z.string(), body: knowledgeFileBodySchema,
  tags: z.array(z.string()), createdAt: z.string(), updatedAt: z.string(),
  source: knowledgeSourceSchema.extend({ relativePath: z.string(), path: z.string().max(4096), sha256: z.string().regex(/^[a-f0-9]{64}$/), modifiedAt: z.string().nullable() }),
});
export const knowledgeEntrySchema = z.union([conversationKnowledgeEntrySchema, fileKnowledgeEntrySchema]);
export const sessionStatusSchema = z.enum(["starting", "working", "collecting", "review_starting", "reviewing", "repair_starting", "awaiting_approval", "applied", "rejected", "blocked", "cancelled", "completed"]);
export const sessionSchema = z.object({
  id: idSchema, taskId: idSchema, baseRevision: revisionSchema, status: sessionStatusSchema, objective: z.string(), criteria: z.array(z.string()),
  mode: z.enum(["result", "conversation"]).default("result"), finishedAt: z.string().nullable().default(null),
  continuedFrom: idSchema.nullable().default(null),
  discussionProposalId: idSchema.nullable().default(null),
  extraction: extractionSchema.nullable().default(null),
  extractionRepair: z.object({ attempt: z.number().int().min(1).max(2), feedback: z.string().max(4000) }).nullable().default(null),
  workerThreadId: z.string().nullable(), reviewerThreadId: z.string().nullable(), environmentId: z.string().nullable(), hostId: z.string().nullable(),
  workerProvider: z.string(), workerModel: z.string(), reviewerProvider: z.string(), reviewerModel: z.string(),
  reviewerReasoning: z.enum(["low", "medium", "high", "xhigh", "max", "none", "ultra", "ultracode"]).default("medium"),
  round: z.number(), maximumRepairs: z.number(), createdAt: z.string(), updatedAt: z.string(), deadlineAt: z.number(),
  error: z.string().nullable(), result: resultSchema.nullable(), artifacts: z.array(observedArtifactSchema), review: reviewSchema.nullable(), proposalId: z.string().nullable(),
});
export const eventSchema = z.object({ id: z.string(), kind: z.string(), createdAt: z.string(), detail: z.string() });
export const syncSourceSchema = z.enum(["gmail", "slack", "jira"]);
export const syncCitationSchema = z.object({
  callRef: idSchema, source: syncSourceSchema, url: z.url().max(4096),
  messageId: z.string().trim().min(1).max(256), occurredAt: z.iso.datetime({ offset: true }),
  quote: z.string().trim().min(1).max(4000),
}).strict();
export const syncFactSchema = z.object({
  kind: factKindSchema.exclude(["user_instruction"]), text: z.string().trim().min(1).max(6000),
  citations: z.array(syncCitationSchema).min(1).max(8),
}).strict();
export const syncDraftSchema = z.object({
  taskId: idSchema.nullable(), title: z.string().trim().min(1).max(200),
  rationale: text, confidence: z.number().min(0).max(1),
  facts: z.array(syncFactSchema).min(1).max(30), changes: changesSchema,
  mergeCandidateIds: z.array(idSchema).min(1).max(500).optional(),
}).strict();
export const syncReportSchema = z.object({
  source: syncSourceSchema, status: z.enum(["complete", "partial", "unavailable"]),
  detail: z.string().trim().min(1).max(4000), callRefs: z.array(idSchema).max(1000),
  paginationComplete: z.boolean(), linkedTasksChecked: z.boolean(),
  scanned: z.number().int().min(0), threadsRead: z.number().int().min(0),
}).strict();
export const syncSubmitSchema = z.object({
  reports: z.array(syncReportSchema).length(3), suggestions: z.array(syncDraftSchema).max(100),
}).strict().refine((v) => new Set(v.reports.map((r) => r.source)).size === 3, "A status is required for each of the three sources.")
  .refine((v) => new TextEncoder().encode(JSON.stringify(v)).length <= 1024 * 1024, "The check result exceeds 1 MiB.");
export const syncSubmitToolSchema = z.object({
  reports: z.array(syncReportSchema).length(3).optional(), suggestions: z.array(syncDraftSchema).max(100),
  finalize: z.boolean().optional(),
}).strict().refine((v) => new TextEncoder().encode(JSON.stringify(v)).length <= 1024 * 1024, "The check result exceeds 1 MiB.");
export const syncRunSchema = z.object({
  id: idSchema, status: z.enum(["starting", "working", "completed", "partial", "blocked", "cancelled"]),
  threadId: idSchema.nullable(), provider: z.string(), model: z.string(),
  startedAt: z.string(), finishedAt: z.string().nullable(), until: z.string(), manualSince: z.string().nullable(),
  ranges: z.record(syncSourceSchema, z.object({ since: z.string(), previous: z.string().nullable() })),
  reports: z.array(syncReportSchema), error: z.string().nullable(),
  suggestions: z.number(), duplicates: z.number(), fingerprint: z.string(),
  collection: z.object({ phase: z.enum(["collecting", "analyzing"]), calls: z.number().int().min(0), reads: z.number().int().min(0), elapsedMs: z.number().min(0) }).optional(),
});
export const syncCandidateSchema = syncDraftSchema.extend({
  facts: z.array(syncFactSchema).min(1).max(300),
  id: idSchema, runId: idSchema, baseRevision: revisionSchema.nullable(),
  status: z.enum(["pending", "applied", "rejected", "superseded"]), createdAt: z.string(), resolvedAt: z.string().nullable(),
  before: z.object({ title: z.string(), status: statusSchema, urgent: axisSchema, important: axisSchema,
    summary: z.string().nullable(), nextStep: z.string().nullable(), openQuestions: z.array(z.string()), blockers: z.array(z.string()), artifacts: z.array(artifactSchema) }).nullable(),
  proposalId: idSchema.nullable(), resultTaskId: idSchema.nullable(),
});
export const sessionUpdateSchema = z.object({ proposalId: idSchema, sessionId: idSchema, threadId: idSchema, extraction: extractionSchema, warnings: z.array(z.string()), speakers: z.record(z.string(), z.enum(["user", "assistant", "context"])).default({}), sources: z.record(z.string(), z.object({ threadId: idSchema, messageRef: idSchema })).default({}) });
export const dossierSchema = z.object({ task: taskSchema, projection: projectionSchema, facts: z.array(factSchema), planning: planningSchema, proposals: z.array(proposalViewSchema), sessions: z.array(sessionSchema), events: z.array(eventSchema), brief: z.string(), sessionUpdates: z.array(sessionUpdateSchema).default([]), syncUpdates: z.array(syncCandidateSchema).default([]) });
export const reviewDossierSchema = dossierSchema.pick({ task: true, projection: true, planning: true, facts: true, sessionUpdates: true }).extend({
  sessions: z.array(sessionSchema.pick({ id: true, status: true, discussionProposalId: true })),
});
export const reviewItemSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("source"), candidate: syncCandidateSchema, currentTask: taskCardSchema.pick({ revision: true, status: true, activeSession: true }).nullable(), blockedReason: z.string().nullable() }),
  z.object({ kind: z.literal("proposal"), proposal: proposalViewSchema, dossier: reviewDossierSchema, blockedReason: z.string().nullable() }),
]);
export const reviewSelectionSchema = z.object({ kind: z.enum(["source", "proposal"]), id: idSchema, revision: revisionSchema.nullable() }).strict();

// BB validates the complete forwarded native-composer request again in spawn.
// Here we bound its size, discriminate its routing, and reject extra top-level authority.
const environmentSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("reuse"), environmentId: idSchema }).strict(),
  z.object({ type: z.literal("project-default") }).strict(),
  z.object({
    type: z.literal("provider"),
    environmentProviderId: idSchema,
    machine: z.object({ type: z.literal("existing"), hostId: idSchema }).strict(),
    inputs: z.json().nullable().default(null),
  }).strict(),
  z.object({ type: z.literal("host"), hostId: idSchema.optional(), workspace: z.discriminatedUnion("type", [
    z.object({ type: z.literal("personal") }).strict(),
    z.object({ type: z.literal("managed-worktree"), baseBranch: z.union([z.object({ kind: z.literal("default") }).strict(), z.object({ kind: z.literal("named"), name: z.string().min(1).max(500) }).strict()]) }).strict(),
    z.object({ type: z.literal("unmanaged"), path: z.string().max(4096).nullable(), branch: z.union([z.object({ kind: z.literal("existing"), name: z.string().min(1).max(500) }).strict(), z.object({ kind: z.literal("new"), baseBranch: z.string().min(1).max(500) }).strict()]).optional() }).strict(),
  ]) }).strict(),
]);
const inputSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string().max(50000), mentions: z.array(z.json()).max(100).optional(), visibility: z.literal("agent-only").optional() }).strict(),
  z.object({ type: z.literal("image"), url: z.string().max(50000), visibility: z.literal("agent-only").optional() }).strict(),
  z.object({ type: z.literal("localImage"), path: z.string().max(4096), visibility: z.literal("agent-only").optional() }).strict(),
  z.object({ type: z.literal("localFile"), path: z.string().max(4096), name: z.string().optional(), mimeType: z.string().optional(), sizeBytes: z.number().optional(), visibility: z.literal("agent-only").optional() }).strict(),
]);
export const requestSchema = z.object({
  projectId: idSchema, providerId: z.enum(["codex", "claude-code", "claude-work"]), model: z.string().min(1).max(200),
  reasoningLevel: z.enum(["low", "medium", "high", "xhigh", "max", "none", "ultra", "ultracode"]),
  permissionMode: z.enum(["accept-edits", "auto", "full"]), serviceTier: z.enum(["default", "fast"]).optional(),
  executionInputSources: z.object({ providerId: z.enum(["explicit", "client-preference"]).optional(), model: z.enum(["explicit", "client-preference"]).optional(), reasoningLevel: z.enum(["explicit", "client-preference"]).optional(), permissionMode: z.enum(["explicit", "client-preference"]).optional(), serviceTier: z.enum(["explicit", "client-preference"]).optional() }).strict(), environment: environmentSchema, input: z.array(inputSchema).min(1).max(40),
}).strict().refine((v) => JSON.stringify(v).length <= 64000, "The task input is too large. Keep only the necessary context.");
export function nativeRequest(value: z.infer<typeof requestSchema>): NewThreadRequest {
  return value as unknown as NewThreadRequest;
}
export const sessionStartSchema = z.object({ taskId: idSchema, revision: revisionSchema, requestId: z.uuid(), continueSessionId: idSchema.optional(), criteria: z.array(z.string().trim().min(1).max(1500)).max(20).default([]), request: requestSchema }).strict();
export const settingsViewSchema = z.object({ codexReviewer: z.string(), claudeReviewer: z.string(), maximumRepairs: z.number(), sessionMinutes: z.number() });
export const syncStartSchema = z.object({ requestId: z.uuid(), since: z.iso.datetime({ offset: true }).nullable().default(null), request: requestSchema }).strict();
export const syncStateSchema = z.object({ runs: z.array(syncRunSchema), candidates: z.array(syncCandidateSchema), pending: z.number(), checkpoints: z.record(syncSourceSchema, z.string().nullable()), nextSince: z.record(syncSourceSchema, z.string()) });
export const rpcContract = defineRpcContract({
  threadProject: { input: z.object({}).strict(), output: z.object({ projectId: idSchema.nullable() }) },
  ...dayRpcContract,
  proposalInbox: { input: z.object({ offset: z.number().int().min(0).default(0) }).strict(), output: z.object({ items: z.array(reviewItemSchema), total: z.number(), nextOffset: z.number().nullable() }) },
  acceptInbox: { input: z.object({ items: z.array(reviewSelectionSchema).min(1).max(50) }).strict(), output: z.object({ applied: z.array(z.object({ kind: z.enum(["source", "proposal"]), id: idSchema, taskId: idSchema })), failed: z.array(z.object({ kind: z.enum(["source", "proposal"]), id: idSchema, message: z.string() })) }) },
  syncState: { input: z.object({}).strict(), output: syncStateSchema },
  syncStart: { input: syncStartSchema, output: syncRunSchema },
  syncCancel: { input: z.object({ runId: idSchema }).strict(), output: syncRunSchema },
  syncAccept: { input: z.object({ candidateId: idSchema }).strict(), output: dossierSchema },
  syncReject: { input: z.object({ candidateId: idSchema }).strict(), output: syncCandidateSchema },
  list: { input: z.object({ history: z.boolean().default(false) }).strict(), output: z.object({ tasks: z.array(taskCardSchema), total: z.number(), pendingTotal: z.number(), settings: settingsViewSchema }) },
  detail: { input: z.object({ id: idSchema }).strict(), output: dossierSchema },
  threadSession: { input: z.object({ threadId: idSchema }).strict(), output: z.object({ session: sessionSchema.pick({ id: true, taskId: true, workerThreadId: true, mode: true, status: true }).nullable() }) },
  create: { input: z.object({ title: z.string().trim().min(1).max(200), description: z.string().trim().max(12000).default(""), requestId: z.uuid() }).strict(), output: taskSchema },
  note: { input: z.object({ taskId: idSchema, revision: revisionSchema, kind: factKindSchema, text, requestId: z.uuid() }).strict(), output: factSchema },
  classify: { input: z.object({ taskId: idSchema, revision: revisionSchema, urgent: axisSchema, important: axisSchema }).strict(), output: planningSchema },
  status: { input: z.object({ taskId: idSchema, revision: revisionSchema, status: statusSchema }).strict(), output: taskSchema },
  propose: { input: z.object({ taskId: idSchema, revision: revisionSchema, draft: draftSchema, requestId: z.uuid() }).strict(), output: proposalSchema },
  accept: { input: z.object({ proposalId: idSchema, revision: revisionSchema }).strict(), output: dossierSchema },
  reject: { input: z.object({ proposalId: idSchema }).strict(), output: proposalSchema },
  revert: { input: z.object({ proposalId: idSchema }).strict(), output: proposalSchema },
  start: { input: sessionStartSchema, output: sessionSchema },
  finish: { input: z.object({ sessionId: idSchema, recorder: z.enum(["auto", "same", "personal-claude"]).default("auto") }).strict(), output: sessionSchema },
  retry: { input: z.object({ sessionId: idSchema, recorder: z.enum(["auto", "same", "personal-claude"]).default("auto") }).strict(), output: sessionSchema },
  cancel: { input: z.object({ sessionId: idSchema }).strict(), output: sessionSchema },
  knowledge: { input: z.object({ query: z.string().max(300).default(""), offset: z.number().int().min(0).default(0) }).strict(), output: z.object({ entries: z.array(knowledgeEntrySchema), total: z.number(), nextOffset: z.number().int().nonnegative().nullable() }) },
  importKnowledge: { input: knowledgeImportSchema, output: z.object({ imported: z.number(), updated: z.number(), unchanged: z.number(), documents: z.number() }) },
});
export type TaskCard = z.infer<typeof taskCardSchema>;
export type Dossier = z.infer<typeof dossierSchema>;
export type ReviewDossier = z.infer<typeof reviewDossierSchema>;
export type ReviewItem = z.infer<typeof reviewItemSchema>;
export type ReviewSelection = z.infer<typeof reviewSelectionSchema>;
export type Session = z.infer<typeof sessionSchema>;
export type WorkerResult = z.infer<typeof resultSchema>;
export type Review = z.infer<typeof reviewSchema>;
export type ObservedArtifact = z.infer<typeof observedArtifactSchema>;
export type SettingsView = z.infer<typeof settingsViewSchema>;
export type StartInput = z.infer<typeof sessionStartSchema>;
export type Extraction = z.infer<typeof extractionSchema>;
export type Transcript = z.infer<typeof transcriptSchema>;
export type KnowledgeEntry = z.infer<typeof knowledgeEntrySchema>;
export type KnowledgeImport = z.infer<typeof knowledgeImportSchema>;
export type SyncSource = z.infer<typeof syncSourceSchema>;
export type SyncRun = z.infer<typeof syncRunSchema>;
export type SyncCandidate = z.infer<typeof syncCandidateSchema>;
export type SyncDraft = z.infer<typeof syncDraftSchema>;
export type SyncSubmit = z.infer<typeof syncSubmitSchema>;
export type SyncStart = z.infer<typeof syncStartSchema>;
