import { z } from "zod";

export const AUTOMATION_SCHEMA = `CREATE TABLE automation_state (key TEXT PRIMARY KEY, value_json TEXT NOT NULL)`;
export const automationSessionSchema = z.object({
  state: z.enum(["working", "needs_input", "ready", "reviewing", "applied", "blocked"]),
  outcome: z.enum(["done", "waiting", "paused"]).optional(),
  note: z.string().max(4000).optional(), requestedAt: z.string().optional(), lastUserSeq: z.number().optional(),
  pauseUntil: z.string().optional(), appliedAt: z.string().optional(),
});
export const automationCheckpointSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("needs_input"), reason: z.enum(["question", "external_write"]), note: z.string().trim().min(1).max(4000) }).strict(),
  z.object({ state: z.literal("ready"), outcome: z.enum(["done", "waiting"]), note: z.string().trim().min(1).max(4000) }).strict(),
]);
export const automationStateSchema = z.object({
  enabled: z.boolean(), since: z.string().nullable(), maximumWorkers: z.number(),
  paused: z.array(z.object({ taskId: z.string(), title: z.string(), until: z.string() })),
  sessions: z.array(z.object({ taskId: z.string(), title: z.string(), threadId: z.string().nullable(), sessionId: z.string(), state: z.string(), note: z.string().nullable() })),
  queued: z.number(), errors: z.array(z.object({ id: z.string(), message: z.string(), retryable: z.boolean(), threadId: z.string().nullable() })),
});
export type AutomationCheckpoint = z.infer<typeof automationCheckpointSchema>;
