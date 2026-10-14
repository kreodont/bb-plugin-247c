import { createHash } from "node:crypto";
import { z } from "zod";
import { factKindSchema, idSchema, type Dossier } from "./contracts.js";
import { PolicyError } from "./core/errors.js";
import { acceptedDossier, workingDossier } from "./dossier-context.js";

export const DOSSIER_PAGE_BYTES = 64 * 1024;
const sections = ["context", "accepted", "facts", "proposals", "sessions", "events", "sessionUpdates", "syncUpdates"] as const;
const sectionSchema = z.enum(sections);
const filtersSchema = z.object({
  query: z.string().trim().min(1).max(300).optional(),
  factIds: z.array(idSchema).min(1).max(20).optional(),
  kinds: z.array(factKindSchema).min(1).max(9).optional(),
}).strict();
export const dossierReadSchema = z.object({
  taskId: idSchema,
  section: sectionSchema.optional(),
  // Includes bounded filters, even when their text needs JSON escaping.
  cursor: z.string().min(1).max(32768).optional(),
  ...filtersSchema.shape,
}).strict();
const cursorSchema = z.object({
  version: z.literal(1), taskId: idSchema, section: sectionSchema,
  snapshot: z.string().regex(/^[a-f0-9]{64}$/), offset: z.number().int().positive(),
  filters: filtersSchema.optional(),
}).strict();

export const DOSSIER_READ_GUIDE = "c247_read defaults to context: current accepted fields, sources and evidence, automatically compacted for large dossiers. compaction reports any deferred history. Current projection fields take precedence over historical steps, questions or status; old instructions/decisions are context, not new authorization. When compacted, search section=facts with query (all keywords), factIds or kinds before relying on an old result, proposing a change based on history, or claiming something never happened. Absence from compact context is not absence from the dossier. Request section=accepted for the full accepted dossier; do not fetch all history routinely. No evidence is deleted or rewritten. Review/session history is separate and is not current accepted truth. If nextCursor is not null, call c247_read again with the same taskId and that cursor until null; filters are preserved by the cursor. For format=json-fragment, concatenate all content strings in order to reconstruct one JSON document. Do not treat a partial page as complete or ask the user to open the panel because it is large. If a section changes while paging, restart it without a cursor, repeating any filters.";

type Filters = z.infer<typeof filtersSchema>;
function normalizedFilters(filters: Filters): Filters {
  return { ...(filters.query ? { query: filters.query.trim() } : {}),
    ...(filters.factIds ? { factIds: [...new Set(filters.factIds)].sort() } : {}),
    ...(filters.kinds ? { kinds: [...new Set(filters.kinds)].sort() } : {}) };
}
function sectionData(dossier: Dossier, section: typeof sections[number], filters: Filters) {
  if (section === "context") return workingDossier(dossier);
  if (section === "accepted") return acceptedDossier(dossier);
  if (section !== "facts") return dossier[section];
  const fold = (value: string) => value.normalize("NFKC").toLowerCase();
  const terms = filters.query ? fold(filters.query).split(/\s+/) : [];
  const facts = dossier.facts.filter(fact => {
    if ((filters.factIds && !filters.factIds.includes(fact.id)) || (filters.kinds && !filters.kinds.includes(fact.kind))) return false;
    const text = fold([fact.text, fact.source, fact.sourceRef ?? "", fact.kind].join("\n"));
    return terms.every(term => text.includes(term));
  });
  return { facts, totalFacts: dossier.facts.length, matchedFacts: facts.length, filters,
    missingFactIds: (filters.factIds ?? []).filter(id => !dossier.facts.some(fact => fact.id === id)) };
}

export function readDossierPage(dossier: Dossier, input: z.infer<typeof dossierReadSchema>): string {
  if (input.taskId !== dossier.task.id) throw new PolicyError("The dossier belongs to a different task.");
  let cursor: z.infer<typeof cursorSchema> | undefined;
  if (input.cursor) {
    try { cursor = cursorSchema.parse(JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8"))); }
    catch { throw new PolicyError("Invalid dossier cursor. Read the section again without a cursor."); }
    if (cursor.taskId !== input.taskId || input.section && cursor.section !== input.section) {
      throw new PolicyError("The dossier cursor belongs to a different task or section.");
    }
  }
  const section = input.section ?? cursor?.section ?? "context";
  const suppliedFilters = normalizedFilters(input);
  const filters = normalizedFilters(cursor?.filters ?? suppliedFilters);
  if (cursor && Object.keys(suppliedFilters).length && JSON.stringify(suppliedFilters) !== JSON.stringify(filters)) {
    throw new PolicyError("The dossier cursor uses different fact filters. Start a new read without a cursor.");
  }
  if (section !== "facts" && Object.keys(filters).length) throw new PolicyError("Fact filters require section=facts.");
  const data = sectionData(dossier, section, filters), text = JSON.stringify(data, null, 2);
  const snapshot = createHash("sha256").update(text).digest("hex");
  if (cursor && cursor.snapshot !== snapshot) throw new PolicyError(`The ${section} section changed while reading. Call c247_read with taskId=${input.taskId} and section=${section}, without a cursor and repeating any fact filters, to read the current version.`);
  const offset = cursor?.offset ?? 0;
  if (offset >= text.length || offset > 0 && /[\uDC00-\uDFFF]/.test(text[offset]) && /[\uD800-\uDBFF]/.test(text[offset - 1])) {
    throw new PolicyError("Invalid dossier page position. Read the section again without a cursor.");
  }
  const metadata = { taskId: input.taskId, revision: dossier.task.revision, section, snapshot,
    availableSections: sections, instructions: DOSSIER_READ_GUIDE,
    historyWindow: { proposals: 200, sessions: 100, events: 100, sessionUpdates: 200, syncUpdates: 200 },
  };
  const whole = JSON.stringify({ ...metadata, format: "json", data, nextCursor: null });
  if (!cursor && Buffer.byteLength(whole) <= DOSSIER_PAGE_BYTES) return whole;

  const encode = (end: number) => JSON.stringify({ ...metadata, format: "json-fragment",
    content: text.slice(offset, end), offset, totalCharacters: text.length,
    nextCursor: end === text.length ? null : Buffer.from(JSON.stringify({ version: 1, taskId: input.taskId, section, snapshot, offset: end,
      ...(Object.keys(filters).length ? { filters } : {}) })).toString("base64url"),
  });
  // Bound the actual serialized response, including JSON escaping, multibyte
  // text and cursor overhead. One large record also remains fully readable.
  let low = offset + 1, high = text.length, end = offset;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (Buffer.byteLength(encode(middle)) <= DOSSIER_PAGE_BYTES) { end = middle; low = middle + 1; }
    else high = middle - 1;
  }
  if (/[\uD800-\uDBFF]/.test(text[end - 1]) && /[\uDC00-\uDFFF]/.test(text[end])) end--;
  if (end <= offset) throw new PolicyError("The dossier page metadata exceeds its response budget.");
  return encode(end);
}
