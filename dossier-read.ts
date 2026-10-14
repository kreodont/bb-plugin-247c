import { createHash } from "node:crypto";
import { z } from "zod";
import { idSchema, type Dossier } from "./contracts.js";
import { PolicyError } from "./core/errors.js";

export const DOSSIER_PAGE_BYTES = 64 * 1024;
const sections = ["accepted", "proposals", "sessions", "events", "sessionUpdates", "syncUpdates"] as const;
const sectionSchema = z.enum(sections);
export const dossierReadSchema = z.object({
  taskId: idSchema,
  section: sectionSchema.optional(),
  cursor: z.string().min(1).max(2048).optional(),
}).strict();
const cursorSchema = z.object({
  version: z.literal(1), taskId: idSchema, section: sectionSchema,
  snapshot: z.string().regex(/^[a-f0-9]{64}$/), offset: z.number().int().positive(),
}).strict();

export const DOSSIER_READ_GUIDE = "c247_read defaults to the accepted task, projection, planning, all accepted evidence and sources. Review/session history is separate and is not current accepted truth. If nextCursor is not null, call c247_read again with the same taskId and that cursor until nextCursor is null. For format=json-fragment, content is a lossless slice of one JSON document: concatenate content from all pages in order to reconstruct it. Do not treat a partial page as the complete dossier or ask the user to open the panel because it is large. If a section changes while paging, restart that section without a cursor. Read history sections only when needed.";

function sectionData(dossier: Dossier, section: typeof sections[number]) {
  if (section !== "accepted") return dossier[section];
  const { task, projection, planning, facts, sourceLinks, primarySource, sourceRevision } = dossier;
  // Exclude duplicate briefs, unaccepted drafts and review payloads from the
  // worker's normal read. Accepted evidence is preserved in full.
  return { task, projection, planning, facts, sourceLinks, primarySource, sourceRevision };
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
  const section = input.section ?? cursor?.section ?? "accepted";
  const data = sectionData(dossier, section), text = JSON.stringify(data, null, 2);
  const snapshot = createHash("sha256").update(text).digest("hex");
  if (cursor && cursor.snapshot !== snapshot) throw new PolicyError(`The ${section} section changed while reading. Call c247_read with taskId=${input.taskId} and section=${section}, without a cursor, to read the current version.`);
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
    nextCursor: end === text.length ? null : Buffer.from(JSON.stringify({ version: 1, taskId: input.taskId, section, snapshot, offset: end })).toString("base64url"),
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
