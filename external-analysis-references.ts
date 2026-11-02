import { z } from "zod";
import { scriptAnalysisSelectionSchema, scriptAnalysisResultSchema, syncCitationSchema } from "./contracts.js";
import { PolicyError } from "./core/errors.js";

export const referenceCatalogSchema = z.object({ version: z.literal(1), records: z.array(z.object({
  ref: z.string(), eventId: z.string().nullable(), selected: z.boolean(),
  passages: z.array(z.object({ ref: z.string(), path: z.string(), citation: syncCitationSchema })),
})) });
type Catalog = z.infer<typeof referenceCatalogSchema>;

/** Split at source boundaries without normalizing whitespace or speech. */
export function literalChunks(text: string): string[] {
  const chunks: string[] = [];
  let offset = 0;
  while (offset < text.length) {
    let end = Math.min(offset + 1800, text.length);
    if (end < text.length) {
      const line = text.lastIndexOf("\n", end);
      const space = text.lastIndexOf(" ", end);
      if (line > offset + 600) end = line + 1;
      else if (space > offset + 600) end = space + 1;
      if (/[\uD800-\uDBFF]/.test(text[end - 1])) end--;
    }
    const chunk = text.slice(offset, end);
    if (chunk.trim()) chunks.push(chunk);
    offset = end;
  }
  return chunks;
}

function fragments(value: unknown, path = "response", depth = 0): { path: string; text: string }[] {
  if (depth > 32) throw new PolicyError("Saved source nesting exceeds the reference catalog limit.");
  if (typeof value === "string") return literalChunks(value).map(text => ({ path, text }));
  if (!value || typeof value !== "object") return [{ path, text: JSON.stringify(value) ?? "null" }];
  if (Array.isArray(value)) return value.flatMap((child, i) => fragments(child, `${path}[${i}]`, depth + 1));
  return Object.entries(value).flatMap(([key, child]) => {
    const childPath = `${path}.${key}`;
    // Small metadata retains its property name, so a number/name is not detached
    // from its meaning. Larger bodies keep exact unescaped source passages.
    const entry = JSON.stringify({ [key]: child }).slice(1, -1);
    if ((typeof child !== "object" || child === null) && entry.length <= 300)
      return [{ path: childPath, text: entry }];
    return fragments(child, childPath, depth + 1);
  });
}

export function prepareReferences(context: string): { catalog: Catalog; context: string } {
  const data = z.object({ sourceDocuments: z.array(z.record(z.string(), z.unknown())) }).passthrough().parse(JSON.parse(context));
  const catalog: Catalog = { version: 1, records: [] };
  const documents = data.sourceDocuments.map((doc, index) => {
    const ref = `r${index + 1}`;
    const identity = syncCitationSchema.omit({ quote: true }).parse({
      callRef: doc.callRef, messageId: doc.id, source: doc.source, url: doc.url, occurredAt: doc.eventAt,
    });
    const passages = fragments(doc.response).map((part, i) => ({ ref: `${ref}.p${i + 1}`, path: part.path,
      citation: { ...identity, quote: part.text } }));
    catalog.records.push({ ref, eventId: typeof doc.eventId === "string" ? doc.eventId : null,
      selected: doc.newOrChanged === true, passages });
    const { response: _response, citation: _citation, callRef: _callRef, id: _id, eventId: _eventId, ...metadata } = doc;
    return { ...metadata, recordRef: ref, passages: passages.map(p => ({ ref: p.ref, path: p.path, text: p.citation.quote })) };
  });
  const transformed = JSON.stringify({ ...data, sourceDocuments: documents });
  if (transformed.length > 2_097_152) throw new PolicyError("Reference analysis input exceeds 2 MiB; split the batch before starting a model.");
  return { catalog: referenceCatalogSchema.parse(catalog), context: transformed };
}

export function resolveReferences(catalog: Catalog, raw: unknown) {
  const selection = scriptAnalysisSelectionSchema.parse(raw);
  const passages = new Map(catalog.records.flatMap(r => r.passages.map(p => [p.ref, p.citation] as const)));
  const records = new Map(catalog.records.map(r => [r.ref, r]));
  const suggestions = selection.suggestions.map(s => ({ ...s, facts: s.facts.map(f => ({ ...f,
    citations: f.citations.map(c => {
      const citation = passages.get(c.ref);
      if (!citation) throw new PolicyError(`Unknown passage reference ${c.ref}. Select a passage from this batch's saved catalog.`);
      return { ...citation };
    }),
  })) }));
  const skipped = selection.skipped.map(s => {
    const record = records.get(s.record);
    if (!record?.selected || !record.eventId) throw new PolicyError(`Record ${s.record} is not a selected event in this batch.`);
    return { eventId: record.eventId, reason: s.reason };
  });
  return scriptAnalysisResultSchema.parse({ suggestions, skipped });
}

export const REFERENCE_INSTRUCTIONS = "Use c247_script_analysis_select. Use c247_script_analysis_sources to reread the saved catalog after compaction; it does not access external services. For citations supply only {ref: 'r1.p2'} from a record's passages. For skipped events supply {record: 'r1', reason: '...'} using recordRef. Never compose or copy source IDs, callRefs, dates, URLs or quotation text into citations. The host supplies those values from the frozen catalog. Every selected record needs a cited passage or an explicit skip. Background passages may support findings but background records cannot be skipped as new events. Choose all passages needed for the claim; each reference becomes a separate exact citation. Older instructions about copying citation objects or eventId values are replaced by this format. saved:true means validated data is saved for import, NOT that Proposals have been imported. Only the Updates import status confirms that." + "\nSelection schema:\n" + JSON.stringify(z.toJSONSchema(scriptAnalysisSelectionSchema));
