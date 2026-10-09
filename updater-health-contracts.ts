import { z } from "zod";

export const sourceCoverageSchema = z.object({
  source: z.enum(["gmail", "slack", "jira", "teams", "outlook", "clickup"]),
  collectedAt: z.string().datetime(), since: z.string().datetime(),
  fullyCheckedThrough: z.string().datetime().nullable(),
  status: z.enum(["complete", "partial", "unavailable"]),
  savedRecords: z.number().int().nonnegative(),
  gaps: z.array(z.string().max(1000)).max(10),
  limitations: z.array(z.string().max(1000)).max(10).optional(),
  budgetPause: z.object({
    usedThisRun: z.number().int().nonnegative(), perRun: z.number().int().positive(),
    usedLast24Hours: z.number().int().nonnegative(), per24Hours: z.number().int().positive(),
    resumesAt: z.string().datetime().nullable(),
    deferredTasks: z.number().int().nonnegative().optional(), deferredDocuments: z.number().int().nonnegative().optional(),
  }).refine(value => value.usedThisRun >= value.perRun || value.usedLast24Hours >= value.per24Hours, "Request budget is not exhausted.").optional(),
  chatScan: z.object({
    checked: z.number().int().nonnegative(), available: z.number().int().nonnegative(),
    excluded: z.number().int().nonnegative(), pendingMessages: z.number().int().nonnegative(),
  }).refine(value => value.checked <= value.available, "Invalid chat scan counts.").optional(),
  scannedChats: z.number().int().nonnegative().optional(), discoveredChats: z.number().int().nonnegative().optional(),
}).refine(value => Date.parse(value.since) <= Date.parse(value.collectedAt)
  && (!value.fullyCheckedThrough || Date.parse(value.fullyCheckedThrough) <= Date.parse(value.collectedAt)), "Invalid coverage interval.");
export type SourceCoverage = z.infer<typeof sourceCoverageSchema>;

export const updaterHealthSchema = z.object({
  mode: z.enum(["native", "external"]).optional(),
  configured: z.boolean(), status: z.enum(["disabled", "healthy", "running", "paused", "failed", "attention", "overdue", "unavailable"]),
  alert: z.boolean(), title: z.string(), detail: z.string(), incidentId: z.string().nullable(),
  checkedAt: z.number(), lastSuccessAt: z.number().nullable(), lastStartedAt: z.number().nullable(), nextRunAt: z.number().nullable(),
  running: z.boolean(), pendingRecords: z.number().int().nonnegative(), attentionBatches: z.number().int().nonnegative(),
  timeZone: z.string(), sourceCoverage: z.array(sourceCoverageSchema).max(6).optional(),
});
export type UpdaterHealthState = z.infer<typeof updaterHealthSchema>;

export const updaterStartResultSchema = z.object({
  runId: z.string(), status: z.string(), alreadyRunning: z.boolean(),
});
