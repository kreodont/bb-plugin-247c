import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import { z } from "zod";
import { idSchema, revisionSchema, syncImportSchema, syncSubmitSchema } from "./contracts.js";
import { PolicyError } from "./core/errors.js";
import { decodedText, type SourceCall, SourceSyncStore } from "./source-sync.js";

const externalSource = z.enum(["teams", "outlook", "clickup"]);
const receiptSchema = z.object({
  callId: idSchema, at: z.iso.datetime({ offset: true }), source: z.enum(["m365", "clickup"]),
  tool: z.string().min(1).max(200), args: z.record(z.string(), z.unknown()), result: z.record(z.string(), z.unknown()),
}).strict();
export const sourceImportBundleSchema = z.object({
  version: z.literal(1), provider: z.string().trim().min(1).max(200), model: z.string().trim().min(1).max(200),
  startedAt: z.iso.datetime({ offset: true }), until: z.iso.datetime({ offset: true }),
  windows: z.record(externalSource, z.object({ since: z.iso.datetime({ offset: true }) }).strict()),
  taskRevisions: z.record(idSchema, revisionSchema),
  receipts: z.array(receiptSchema).max(2000), result: syncSubmitSchema,
}).strict();

const clickUpReads = new Set(["clickup_get_task", "clickup_get_task_comments", "clickup_get_threaded_comments", "clickup_get_document_pages"]);
const clickUpQueries = new Set(["clickup_find_member_by_name", "clickup_resolve_assignees", "clickup_filter_tasks", "clickup_search", "clickup_list_document_pages"]);
const teamsQueries = new Set(["chat_message_search", "teams_list_chats", "teams_list_teams", "teams_list_channels", "teams_list_channel_messages"]);

// Receipts are produced by the configured local collector, never by model output.
// Derive authority from the operation and saved response, not supplied read flags.
export function importedSourceCalls(receipts: z.infer<typeof receiptSchema>[]): SourceCall[] {
  const calls: SourceCall[] = [];
  const ids = new Set<string>();
  let bytes = 0;
  for (const row of receipts) {
    if (ids.has(row.callId)) throw new PolicyError("Duplicate collector receipt ID.");
    ids.add(row.callId);
    let source: "teams" | "outlook" | "clickup", read = false;
    if (row.source === "clickup" && (clickUpReads.has(row.tool) || clickUpQueries.has(row.tool))) {
      source = "clickup"; read = clickUpReads.has(row.tool);
    } else if (row.source === "m365" && row.tool === "get_me") continue;
    else if (row.source === "m365" && row.tool === "outlook_email_search") source = "outlook";
    else if (row.source === "m365" && teamsQueries.has(row.tool)) source = "teams";
    else if (row.source === "m365" && row.tool === "read_resource" && typeof row.args.uri === "string" && /^(teams|mail):\/\/\//.test(row.args.uri)) {
      source = row.args.uri.startsWith("mail:") ? "outlook" : "teams"; read = true;
    } else throw new PolicyError(`Unsupported collector operation: ${row.source}.${row.tool}`);
    const output = decodedText(JSON.stringify(row.result));
    bytes += Buffer.byteLength(output);
    if (bytes > 32 * 1024 * 1024) throw new PolicyError("Decoded collector receipts exceed 32 MiB.");
    calls.push({ ref: row.callId, source, tool: row.tool, args: row.args, output, read,
      completed: !row.result.isError && !/"(?:isError|is_error)"\s*:\s*true/.test(output),
      truncated: /"(?:truncated|isTruncated)"\s*:\s*true/.test(output),
    });
  }
  return calls;
}

export async function importSourceBundle(store: SourceSyncStore, root: string, raw: z.infer<typeof syncImportSchema>) {
  const input = syncImportSchema.parse(raw);
  if (!root || !isAbsolute(root) || !isAbsolute(input.path)) throw new PolicyError("Configure an absolute local source import folder first.");
  const directory = await realpath(root), path = await realpath(input.path);
  const child = relative(directory, path);
  if (!child || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) throw new PolicyError("The source bundle must be inside the configured import folder.");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let content: Buffer;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 32 * 1024 * 1024) throw new PolicyError("The source bundle must be a regular file of at most 32 MiB.");
    content = await file.readFile();
  } finally { await file.close(); }
  if (content.length > 32 * 1024 * 1024 || createHash("sha256").update(content).digest("hex") !== input.sha256) throw new PolicyError("The source bundle changed. Re-read it and supply its current SHA-256.");
  const bundle = sourceImportBundleSchema.parse(JSON.parse(content.toString("utf8")));
  if (Date.parse(bundle.until) > Date.now() || Date.parse(bundle.startedAt) > Date.parse(bundle.until)) throw new PolicyError("The collector interval is invalid or in the future.");
  if (bundle.result.reports.some(report => !externalSource.safeParse(report.source).success)) throw new PolicyError("Imported runs must report Teams, Outlook and ClickUp.");
  for (const range of Object.values(bundle.windows)) if (Date.parse(range.since) >= Date.parse(bundle.until)) throw new PolicyError("Every source interval must start before its end.");
  const calls = importedSourceCalls(bundle.receipts);
  return store.repo.request(input.requestId, input, () => store.importResult({
    id: input.requestId, provider: bundle.provider, model: bundle.model, startedAt: bundle.startedAt, until: bundle.until,
    windows: bundle.windows, taskRevisions: bundle.taskRevisions, input: bundle.result, provenance: { path, sha256: input.sha256 },
  }, calls));
}
