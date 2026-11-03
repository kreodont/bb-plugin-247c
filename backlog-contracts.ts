import { z } from "zod";

export const backlogOutcomeSchema = z.enum(["ready", "waiting", "close", "decision", "duplicate", "unverified"]);
export const backlogFindingSchema = z.object({
  outcome: backlogOutcomeSchema, summary: z.string().trim().min(1).max(2000),
  action: z.string().trim().max(1000), duplicateTaskId: z.string().nullable().default(null),
  sourceStatus: z.enum(["checked", "unavailable", "missing"]),
  sourceDetail: z.string().trim().min(1).max(1000),
});
export const backlogItemSchema = z.object({
  taskId: z.string(), title: z.string(), revision: z.number().int(),
  result: backlogFindingSchema.nullable(), checkedAt: z.string().nullable(),
  proposalId: z.string().nullable(), proposalStatus: z.string().nullable(), proposalNote: z.string().nullable(), stale: z.boolean(),
  sources: z.array(z.object({ url: z.string(), label: z.string() })),
});
export const backlogRunSchema = z.object({
  id: z.string(), requestId: z.string(), status: z.enum(["starting", "running", "completed", "partial", "stopped"]),
  threadId: z.string().nullable(), providerId: z.string(), model: z.string(), projectId: z.string(),
  title: z.string(), startedAt: z.number(), error: z.string().nullable(),
  total: z.number(), checked: z.number(), unverified: z.number(),
});
export const backlogRpcContract = {
  backlogState: { input: z.object({ runId: z.string().optional() }).strict(), output: z.object({
    configured: z.boolean(), providerId: z.string(), model: z.string(),
    run: backlogRunSchema.nullable(), history: z.array(backlogRunSchema), items: z.array(backlogItemSchema),
  }) },
  backlogStart: { input: z.object({ taskIds: z.array(z.string().min(1)).min(1).max(500), requestId: z.uuid() }).strict(), output: backlogRunSchema },
  backlogStop: { input: z.object({ runId: z.string() }).strict(), output: backlogRunSchema },
} as const;
export const BACKLOG_SCHEMA = `
CREATE TABLE backlog_runs (id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, thread_id TEXT UNIQUE, status TEXT NOT NULL, value_json TEXT NOT NULL);
CREATE UNIQUE INDEX one_active_backlog ON backlog_runs((1)) WHERE status IN ('starting','running');
CREATE TABLE backlog_items (run_id TEXT NOT NULL REFERENCES backlog_runs(id), task_id TEXT NOT NULL REFERENCES tasks(id), revision INTEGER NOT NULL, title TEXT NOT NULL, dossier_read INTEGER NOT NULL DEFAULT 0, chats_json TEXT NOT NULL DEFAULT '{}', result_json TEXT, checked_at TEXT, proposal_id TEXT, proposal_note TEXT, PRIMARY KEY(run_id,task_id));`;
export type BacklogFinding = z.infer<typeof backlogFindingSchema>;
export type BacklogRun = z.infer<typeof backlogRunSchema>;
