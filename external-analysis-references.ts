import { z } from "zod";
import { scriptAnalysisSelectionSchema, scriptAnalysisResultSchema, syncCitationSchema } from "./contracts.js";
import { PolicyError } from "./core/errors.js";

export const referenceCatalogSchema = z.object({ version: z.literal(1), records: z.array(z.object({
  ref: z.string(), eventId: z.string().nullable(), selected: z.boolean(),
  passages: z.array(z.object({ ref: z.string(), path: z.string(), citation: syncCitationSchema })),
})), contextEntries: z.array(z.object({ ref: z.string(), section: z.string(), index: z.number().int(),
  taskId: z.string().nullable(), content: z.string() })).default([]),
  taskIndex: z.array(z.object({ id: z.string(), title: z.string(), status: z.string() })).default([]) });
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

export function prepareReferences(context: string, maxSerializedCharacters = 950_000): { catalog: Catalog; context: string } {
  const data = z.object({ sourceDocuments: z.array(z.record(z.string(), z.unknown())) }).passthrough().parse(JSON.parse(context));
  const taskIndex = Array.isArray(data.currentTasks) ? data.currentTasks.filter((t): t is Record<string, unknown> =>
    Boolean(t && typeof t === "object" && typeof t.id === "string" && typeof t.title === "string"))
    .map(t => ({ id: t.id as string, title: t.title as string, status: typeof t.status === "string" ? t.status : "unknown" })) : [];
  const catalog: Catalog = { version: 1, records: [], contextEntries: [], taskIndex };
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
    return { ...metadata, recordRef: ref, passageCount: passages.length, passagesDeferred: false,
      passages: passages.map(p => ({ ref: p.ref, path: p.path, text: p.citation.quote })) };
  });
  const encode = () => JSON.stringify({ ...data, sourceDocuments: documents });
  let transformed = encode();
  // Count the JSON-escaped message, not just the collector's original data.
  // Keep every record and all task context. Deferred passages remain in the
  // frozen catalog and can be read with the existing scoped paging tool.
  const largest = [...documents].sort((a, b) => JSON.stringify(b.passages).length - JSON.stringify(a.passages).length);
  for (const doc of largest) {
    if (JSON.stringify(transformed).length <= maxSerializedCharacters) break;
    if (!doc.passages.length) continue;
    doc.passages = [];
    doc.passagesDeferred = true;
    transformed = encode();
  }
  // Task history grows independently of the number of selected source events.
  // Freeze full rows, preserving every task in the index and every decision.
  const candidates = ["currentTasks", "pendingProposals"].flatMap(section => {
    const rows = data[section];
    if (!Array.isArray(rows)) return [];
    return rows.map((value, index) => ({ section, index, value, content: JSON.stringify(value) }));
  }).sort((a, b) => b.content.length - a.content.length);
  for (const entry of candidates) {
    if (JSON.stringify(transformed).length <= maxSerializedCharacters) break;
    if (!entry.value || typeof entry.value !== "object" || Array.isArray(entry.value)) continue;
    const ref = `c${catalog.contextEntries.length + 1}`;
    const identity = Object.fromEntries(["id", "taskId", "title", "status", "revision"].filter(k => k in entry.value)
      .map(k => [k, entry.value[k]]));
    const preview = { ...identity, contextRef: ref, contextDeferred: true, contextCharacters: entry.content.length };
    if (JSON.stringify(preview).length >= entry.content.length) continue;
    catalog.contextEntries.push({ ref, section: entry.section, index: entry.index,
      taskId: typeof (entry.section === "currentTasks" ? entry.value.id : entry.value.taskId) === "string"
        ? (entry.section === "currentTasks" ? entry.value.id : entry.value.taskId) : null, content: entry.content });
    (data[entry.section] as unknown[])[entry.index] = preview;
    transformed = encode();
  }
  if (JSON.stringify(transformed).length > maxSerializedCharacters)
    throw new PolicyError("Analysis task context and source index exceed the launch budget even with passages paged. Split the batch or reduce its context before retrying; no thread was created.");
  return { catalog: referenceCatalogSchema.parse(catalog), context: transformed };
}

export function resolveReferences(catalog: Catalog, raw: unknown) {
  const selection = scriptAnalysisSelectionSchema.parse(raw);
  const normalize = (title: string) => title.trim().replace(/\s+/g, " ").toLocaleLowerCase();
  for (const suggestion of selection.suggestions) {
    if (suggestion.taskId !== null) continue;
    const titles = [suggestion.title, suggestion.changes.title?.value].filter((v): v is string => typeof v === "string").map(normalize);
    const matches = catalog.taskIndex.filter(t => titles.includes(normalize(t.title)));
    if (matches.length) throw new PolicyError("A task with this title already exists: " + matches.map(t => `${t.id} (status=${t.status})`).join(", ")
      + ". Read its saved context. If this is the same work, use its taskId and preserve accepted scope and manual choices. A different source ticket ID does not prove new work. Do not infer reopening or merge distinct requests solely from their title. Correct and resubmit this result before import.");
  }
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

export const REFERENCE_INSTRUCTIONS = "Use c247_script_analysis_select. Task or pending-proposal rows with contextDeferred:true are indexes, not complete dossiers. Read their exact saved JSON with c247_script_analysis_context using contextRef and every nextOffset until null. Before updating an existing task, read its deferred context. Before proposing a new task, compare all indexed titles/statuses and read potentially matching tasks, including closed or archived ones, and relevant pending proposals to avoid duplicates or repeating rejected decisions. Absence of facts in an index is not absence from the dossier. These reads access only this frozen batch, not external services. Use c247_script_analysis_sources to read deferred passages and reread the saved catalog after compaction; it does not access external services. A source document with passagesDeferred:true has its complete content saved in the catalog, not an empty response. Before interpreting or skipping such a selected record, call c247_script_analysis_sources with its recordRef and read all pages using nextOffset until null. Read deferred background records when needed for context. These saved-data tools are required and override older instructions prohibiting tools. For citations supply only {ref: 'r1.p2'} from a record's passages. For skipped events supply {record: 'r1', reason: '...'} using recordRef. Never compose or copy source IDs, callRefs, dates, URLs or quotation text into citations. The host supplies those values from the frozen catalog. Every selected record needs a cited passage or an explicit skip. Background passages may support findings but background records cannot be skipped as new events. Choose all passages needed for the claim; each reference becomes a separate exact citation. Older instructions about copying citation objects or eventId values are replaced by this format. saved:true means validated data is saved for import, NOT that Proposals have been imported. Only the Updates import status confirms that." + "\nSelection schema:\n" + JSON.stringify(z.toJSONSchema(scriptAnalysisSelectionSchema));
