import { z } from "zod";

export const reviewFailureSchema = z.object({
  incidentId: z.string(), sessionId: z.string(), taskId: z.string(), taskTitle: z.string(),
  failedAt: z.string(), error: z.string().max(4000),
});
export const reviewFailuresSchema = z.object({ failures: z.array(reviewFailureSchema).max(200), total: z.number().int().nonnegative() });
export type ReviewFailure = z.infer<typeof reviewFailureSchema>;
export type ReviewFailures = z.infer<typeof reviewFailuresSchema>;
