import { z } from "zod";
import { dayDateSchema, dayMinutesSchema } from "./day-contracts.js";
const id = z.string().min(1).max(300);
export const timeEvidenceSchema = z.object({ id, taskId: id.nullable(), at: z.iso.datetime({ offset: true }), source: z.string().min(1).max(300), url: z.string().max(4096).nullable(), text: z.string().min(1).max(16000) }).strict();
export type TimeEvidence = z.infer<typeof timeEvidenceSchema>;
const candidate = z.object({ taskId: id, title: z.string(), itemId: id.nullable(), revision: z.number().nullable(), summary: z.string().nullable(), sources: z.array(z.unknown()) });
export const timeContextSchema = z.object({ id, date: dayDateSchema, tasks: z.array(candidate), evidence: z.array(timeEvidenceSchema), warnings: z.array(z.string()), nextOffset: z.number().nullable() });
export type TimeContext = z.infer<typeof timeContextSchema>;
export const timeSuggestionSchema = z.object({ taskId: id, minutes: dayMinutesSchema, reason: z.string().trim().min(1).max(2000), question: z.string().trim().max(1000).nullable(), evidenceRefs: z.array(id).min(1).max(100) }).strict();
export const timeProposalSchema = timeSuggestionSchema.extend({ id, date: dayDateSchema, title: z.string(), itemId: id.nullable(), revision: z.number().nullable(), fingerprint: z.string(), evidence: z.array(timeEvidenceSchema), status: z.enum(["pending", "accepted", "rejected", "superseded"]), createdAt: z.string(), resolvedAt: z.string().nullable(), blockedReason: z.string().nullable().default(null) });
export type TimeProposal = z.infer<typeof timeProposalSchema>;
export const weekOverridesSchema = z.record(dayDateSchema, z.number().int().min(0).max(10080));
export const timeReviewRpcContract = {
  timeReviewPrepare: { input: z.object({ date: dayDateSchema, offset: z.number().int().min(0).default(0), external: z.array(timeEvidenceSchema).max(500).default([]) }).strict(), output: timeContextSchema },
  timeReviewSubmit: { input: z.object({ requestId: z.uuid(), contextId: id, suggestions: z.array(timeSuggestionSchema).max(10) }).strict(), output: z.object({ proposals: z.array(timeProposalSchema) }) },
  timeReview: { input: z.object({ date: dayDateSchema.optional(), week: z.boolean().default(false) }).strict(), output: z.object({ date: dayDateSchema, proposals: z.array(timeProposalSchema), weekly: z.object({ from: dayDateSchema, through: dayDateSchema, targetMinutes: z.number(), reportedMinutes: z.number(), remainingMinutes: z.number() }), due: z.boolean(), reviewedAt: z.string().nullable(), revision: z.string(), missingReported: z.number(), reviewHour: z.number() }) },
  timeReviewDecide: { input: z.object({ requestId: z.uuid(), id, decision: z.enum(["accept", "reject"]), minutes: dayMinutesSchema.optional() }).strict(), output: timeProposalSchema },
  timeReviewComplete: { input: z.object({ requestId: z.uuid(), date: dayDateSchema, revision: z.string() }).strict(), output: z.object({ reviewedAt: z.string() }) },
} as const;
