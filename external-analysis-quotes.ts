import { z } from "zod";
import type { scriptAnalysisResultSchema } from "./contracts.js";
import { PolicyError } from "./core/errors.js";

export const analysisSourcesSchema = z.array(z.object({
  callRef: z.string().min(1), id: z.string().min(1), response: z.unknown(),
}).strict());
type Sources = z.infer<typeof analysisSourcesSchema>;

export function analysisSources(context: string): Sources {
  const data = z.object({ sourceDocuments: z.array(z.object({
    callRef: z.string().optional(), id: z.string().optional(), response: z.unknown().optional(),
  })).default([]) }).parse(JSON.parse(context));
  return analysisSourcesSchema.parse(data.sourceDocuments.filter(d => d.response !== undefined));
}

function passages(value: unknown, depth = 0): string[] {
  if (depth > 32) return [];
  if (typeof value === "string") {
    // Some saved connector responses wrap their actual JSON in text content.
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed !== "string") return [value, ...passages(parsed, depth + 1)];
    } catch { /* Ordinary source text. */ }
    return [value];
  }
  if (!value || typeof value !== "object") return [];
  return [JSON.stringify(value), JSON.stringify(value, null, 2),
    ...Object.values(value).flatMap(v => passages(v, depth + 1))];
}

/** Validate against the supplied record, without rewriting speech or joining fields.
 * The importer still checks against full receipts, including compacted metadata.
 */
export function validateAnalysisQuotes(sources: Sources, result: z.infer<typeof scriptAnalysisResultSchema>) {
  if (!sources.length) return; // Older collectors did not supply response bodies.
  const key = (callRef: string, id: string) => JSON.stringify([callRef, id]);
  const records = new Map<string, string[]>();
  for (const source of sources) {
    const id = key(source.callRef, source.id);
    records.set(id, [...(records.get(id) ?? []), ...passages(source.response)]);
  }
  const issues: string[] = [];
  result.suggestions.forEach((suggestion, si) => suggestion.facts.forEach((fact, fi) => fact.citations.forEach((cite, ci) => {
    const text = records.get(key(cite.callRef, cite.messageId));
    const location = `suggestion ${si}, fact ${fi}, citation ${ci}, record ${cite.messageId.slice(0, 128)}`;
    if (!text) issues.push(`Unknown source record: ${location}`);
    else if (!text.some(passage => passage.includes(cite.quote))) issues.push(`Quote is absent from its supplied source record: ${location}`);
  })));
  if (issues.length) throw new PolicyError(issues.slice(0, 8).join(". ") +
    (issues.length > 8 ? ` (${issues.length} errors total).` : ".") +
    " Result not saved. Correct and resubmit the complete result in this thread. Copy a continuous literal passage from that record. Preserve repeated words, punctuation, speaker labels and line breaks; use separate citations for separate passages. Do not remove supported work just to pass validation.");
}
