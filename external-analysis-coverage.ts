import { z } from "zod";
import type { scriptAnalysisResultSchema } from "./contracts.js";
import { PolicyError } from "./core/errors.js";

export const selectedEventsSchema = z.array(z.object({
  eventId: z.string().min(1), callRef: z.string().min(1), messageId: z.string().min(1),
}).strict());
type SelectedEvent = z.infer<typeof selectedEventsSchema>[number];

/** Persist identities only, separately from the model's result and source bodies. */
export function selectedEvents(context: string): SelectedEvent[] {
  const dataset = z.object({ sourceDocuments: z.array(z.object({
    newOrChanged: z.boolean().optional(), eventId: z.string().optional(),
    callRef: z.string().optional(), id: z.string().optional(),
  })).default([]) }).parse(JSON.parse(context));
  const events = new Map<string, SelectedEvent>();
  for (const doc of dataset.sourceDocuments) {
    if (!doc.newOrChanged || !doc.eventId) continue; // Older collectors may not supply coverage identities.
    if (!doc.callRef || !doc.id) throw new PolicyError("Selected source event is missing its callRef or id: " + doc.eventId);
    const event = { eventId: doc.eventId, callRef: doc.callRef, messageId: doc.id };
    const previous = events.get(event.eventId);
    if (previous && (previous.callRef !== event.callRef || previous.messageId !== event.messageId))
      throw new PolicyError("Selected event ID belongs to multiple source records: " + event.eventId);
    events.set(event.eventId, event);
  }
  return [...events.values()];
}

/** Reject before freezing so the same running analysis can correct its submission. */
export function validateAnalysisCoverage(events: SelectedEvent[], result: z.infer<typeof scriptAnalysisResultSchema>) {
  if (!events.length) return; // Preserve compatibility with collectors without an event ledger.
  const selected = new Set(events.map(e => e.eventId));
  const seen = new Set<string>();
  const unknown = new Set<string>();
  const duplicate = new Set<string>();
  for (const row of result.skipped) {
    if (!selected.has(row.eventId)) unknown.add(row.eventId);
    if (seen.has(row.eventId)) duplicate.add(row.eventId);
    seen.add(row.eventId);
  }
  const pair = (callRef: string, messageId: string) => JSON.stringify([callRef, messageId]);
  const cited = new Set(result.suggestions.flatMap(s => s.facts.flatMap(f =>
    f.citations.map(c => pair(c.callRef, c.messageId)))));
  const missing = events.filter(e => !seen.has(e.eventId) && !cited.has(pair(e.callRef, e.messageId)));
  const issues: string[] = [];
  const sample = (ids: string[]) => ids.slice(0, 20).map(id => id.slice(0, 160)).join(", ") + (ids.length > 20 ? ` (${ids.length} total)` : "");
  if (unknown.size) issues.push("Unknown skipped event IDs: " + sample([...unknown]));
  if (duplicate.size) issues.push("Duplicate skipped event IDs: " + sample([...duplicate]));
  if (missing.length) issues.push("Omitted selected event IDs: " + sample(missing.map(e => e.eventId)));
  if (issues.length) throw new PolicyError(issues.join(". ") +
    ". Result not saved. Correct and resubmit the complete result in this thread. Use each selected eventId, not callRef or messageId, for skipped records. Cover every selected event with an exact source citation (callRef and messageId) or an explicit skip reason. Do not skip real work just to pass validation.");
}
