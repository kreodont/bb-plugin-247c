import { z } from "zod";

export const updaterHealthSchema = z.object({
  configured: z.boolean(), status: z.enum(["disabled", "healthy", "running", "paused", "failed", "attention", "overdue", "unavailable"]),
  alert: z.boolean(), title: z.string(), detail: z.string(), incidentId: z.string().nullable(),
  checkedAt: z.number(), lastSuccessAt: z.number().nullable(), lastStartedAt: z.number().nullable(), nextRunAt: z.number().nullable(),
  running: z.boolean(), pendingRecords: z.number().int().nonnegative(), attentionBatches: z.number().int().nonnegative(),
  timeZone: z.string(),
});
export type UpdaterHealthState = z.infer<typeof updaterHealthSchema>;
