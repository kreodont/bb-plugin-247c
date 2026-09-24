import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { KnowledgeEntry } from "./contracts.js";
import type { Repository } from "./repository.js";

export const knowledgePathSchema = z.string().trim().max(4096).refine(value => !value || path.isAbsolute(value) && !value.includes("\0"), "Use an absolute local path or leave blank.");
export type KnowledgeSettings = { knowledgeDirectory: string; openKnowledgeExecutable: string };
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const PAGE_SIZE = 10;
const TOKEN_BUDGET = 2400;
const SOURCE_LIMIT = 50;
const MAX_EXCERPT_CHARACTERS = 9600;
const packetSchema = z.object({ schemaVersion: z.literal("1"), estimatedTokens: z.number().nonnegative(), sources: z.array(z.object({
  path: z.string(), heading: z.string().optional(), lineStart: z.number().int().positive(), lineEnd: z.number().int().positive(),
  markdown: z.string(), score: z.number(), relation: z.string(),
})).max(SOURCE_LIMIT), issues: z.array(z.unknown()).optional() });

type Source = z.infer<typeof packetSchema>["sources"][number];
// Preserve exact all-word matches even when fuzzy ranking favors a generic term.
// The line range refers to the generated file; the body itself is never rewritten.
function literalSource(doc: Document, query: string): Source {
  const terms = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const lines = doc.entry.body.split("\n");
  let best = 0, score = 0;
  for (let i = 0; i < lines.length; i++) {
    const hits = terms.filter(term => lines[i].toLocaleLowerCase().includes(term)).length;
    if (hits > score) { score = hits; best = i; }
  }
  const start = Math.max(0, best - 2), end = Math.min(lines.length, best + 6);
  const prefixLines = doc.content.slice(0, doc.content.length - doc.entry.body.length).split("\n").length - 1;
  const text = lines.slice(start, end).join("\n");
  const match = Math.max(0, ...terms.map(term => text.toLocaleLowerCase().indexOf(term)).filter(index => index >= 0));
  const from = text.length > 2400 ? Math.max(0, match - 600) : 0;
  return { path: doc.filename, lineStart: prefixLines + start + 1, lineEnd: prefixLines + end,
    markdown: text.slice(from, from + 2400), score: 0, relation: "literal" };
}

type Document = { entry: KnowledgeEntry; filename: string; content: string; bodySha256: string };
type Generation = { directory: string; revision: string; documents: Document[] };
export type KnowledgeExportStatus = { enabled: boolean; directory: string | null; revision: string | null; documents: number; error: string | null };

export function knowledgeDocuments(entries: KnowledgeEntry[]): Document[] {
  return entries.map(entry => {
    const bodySha256 = sha(entry.body);
    const origin = entry.kind === "file"
      ? { id: entry.id, kind: entry.kind, source: entry.source, bodySha256 }
      : { id: entry.id, kind: entry.kind, taskId: entry.taskId, taskTitle: entry.taskTitle, threadId: entry.threadId,
        sessionId: entry.sessionId, proposalId: entry.proposalId, evidenceRefs: entry.evidenceRefs, bodySha256 };
    const fields = { type: entry.kind === "file" ? "ImportedDocument" : "AcceptedConversationNote", title: entry.title,
      tags: entry.tags, timestamp: entry.kind === "file" ? entry.source.modifiedAt ?? entry.updatedAt : entry.createdAt,
      c247_origin: origin };
    const content = "---\n" + Object.entries(fields).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join("\n") + "\n---\n\n" + entry.body;
    return { entry, filename: `entries/${sha(entry.id)}.md`, content, bodySha256 };
  });
}

// Knowledge changes remain in the database transaction. Export failures never
// roll back an acceptance or make a draft visible. One queue owns each export.
export class KnowledgeSearch {
  private tail: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private lifetime = new AbortController();
  private state: KnowledgeExportStatus = { enabled: false, directory: null, revision: null, documents: 0, error: null };
  constructor(private repo: Repository, private config: () => KnowledgeSettings, private warn: (message: string) => void) {}
  status() { return { ...this.state }; }
  schedule() {
    if (this.lifetime.signal.aborted || !this.config().knowledgeDirectory || this.timer) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.refresh().catch(() => {}); }, 250);
    this.timer.unref?.();
  }
  async dispose() { if (this.timer) clearTimeout(this.timer); this.lifetime.abort(); await this.tail.catch(() => {}); }
  refresh(): Promise<Generation | null> {
    const job = this.tail.catch(() => {}).then(() => this.exportSnapshot()).catch(error => {
      const message = error instanceof Error ? error.message : String(error);
      if (this.state.error !== message) this.warn(`Knowledge export: ${message}`);
      this.state = { ...this.state, error: message };
      throw error;
    });
    this.tail = job;
    return job;
  }
  private async directory(name: string) {
    await fs.mkdir(name, { recursive: true, mode: 0o700 });
    const info = await fs.lstat(name);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Knowledge export directories must be real local directories.");
  }
  private async exportSnapshot(): Promise<Generation | null> {
    this.lifetime.signal.throwIfAborted();
    const root = knowledgePathSchema.parse(this.config().knowledgeDirectory);
    if (!root) { this.state = { enabled: false, directory: null, revision: null, documents: 0, error: null }; return null; }
    this.state.enabled = true;
    await this.directory(root);
    const marker = path.join(root, ".247c-export.json");
    const owner = JSON.stringify({ version: 1, database: sha(path.resolve(this.repo.db.name)) });
    try { if ((await fs.lstat(marker)).isSymbolicLink() || await fs.readFile(marker, "utf8") !== owner) throw new Error("Knowledge folder belongs to another export."); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if ((await fs.readdir(root)).length) throw new Error("Choose an empty dedicated knowledge export folder.");
      await fs.writeFile(marker, owner, { flag: "wx", mode: 0o600 });
    }
    const documents = knowledgeDocuments(this.repo.allKnowledge());
    const revision = sha(JSON.stringify(documents.map(doc => [doc.filename, sha(doc.content)])));
    const generations = path.join(root, "generations"), directory = path.join(generations, revision);
    await this.directory(generations);
    const links = documents.map(doc => `[${doc.entry.title.replace(/[\[\]\\\r\n]/g, " ")}](${doc.filename})`).join("\n\n");
    const exportDate = documents.map(doc => doc.entry.kind === "file" ? doc.entry.updatedAt : doc.entry.createdAt).sort().at(-1)?.slice(0, 10) ?? "1970-01-01";
    const files = new Map(documents.map(doc => [doc.filename, doc.content]));
    files.set("index.md", `---\nokf_version: "0.2"\n---\n\n# 247C Knowledge\n\nAccepted conversation notes and explicitly imported documents. Propose corrections in 247C; this is a generated read-only copy.\n\n${links}\n`);
    files.set("log.md", `# Export history\n\n## ${exportDate}\n\nExported ${documents.length} accepted or imported records. Revision: ${revision}. Original bodies and provenance are retained.\n`);
    // Relative source links may not resolve in the export; retain their exact text.
    files.set(".openknowledge.toml", '[release]\noutputs = []\n\n[validation.rules]\nlink-target = "warn"\n');
    files.set("manifest.json", JSON.stringify({ version: 1, revision, entries: documents.map(doc => ({ id: doc.entry.id, path: doc.filename, bodySha256: doc.bodySha256, fileSha256: sha(doc.content) })) }, null, 2) + "\n");
    try { await fs.access(directory); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const staging = await fs.mkdtemp(path.join(generations, ".staging-"));
      try {
        await fs.mkdir(path.join(staging, "entries"), { mode: 0o700 });
        for (const [filename, content] of files) {
          this.lifetime.signal.throwIfAborted();
          await fs.writeFile(path.join(staging, filename), content, { flag: "wx", mode: 0o600 });
        }
        await fs.rename(staging, directory);
      } finally { await fs.rm(staging, { recursive: true, force: true }); }
    }
    if (!(await fs.lstat(directory)).isDirectory() || (await fs.lstat(directory)).isSymbolicLink()) throw new Error("Invalid knowledge generation.");
    // A direct MCP reader must also see only approved files, not manual additions.
    const entriesDirectory = path.join(directory, "entries");
    const entriesInfo = await fs.lstat(entriesDirectory);
    if (!entriesInfo.isDirectory() || entriesInfo.isSymbolicLink()) throw new Error("Invalid knowledge entries directory.");
    const actualFiles = [...(await fs.readdir(directory)).filter(name => name !== "entries"), ...(await fs.readdir(entriesDirectory)).map(name => `entries/${name}`)].sort();
    if (JSON.stringify(actualFiles) !== JSON.stringify([...files.keys()].sort())) throw new Error("Generated knowledge contains unexpected files.");
    for (const [filename, content] of files) {
      const file = path.join(directory, filename), info = await fs.lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || await fs.readFile(file, "utf8") !== content) throw new Error("Generated knowledge was modified. Restore the export before using OpenKnowledge.");
    }
    const current = path.join(root, "current");
    try { if (!(await fs.lstat(current)).isSymbolicLink()) throw new Error("The knowledge current pointer is not an export symlink."); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const pointer = path.join(root, `.current-${randomUUID()}`);
    try { await fs.symlink(path.join("generations", revision), pointer, "dir"); await fs.rename(pointer, current); }
    finally { await fs.rm(pointer, { force: true }); }
    this.state = { enabled: true, directory, revision, documents: documents.length, error: null };
    return { directory, revision, documents };
  }
  private run(executable: string, args: string[]): Promise<string> {
    this.lifetime.signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      execFile(executable, args, { shell: false, encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: 20_000,
        signal: this.lifetime.signal, env: { ...process.env, OPENKNOWLEDGE_TELEMETRY_SUPPRESS: "1" } }, (error, stdout) => {
        if (error) reject(new Error("OpenKnowledge search failed or timed out.")); else resolve(stdout);
      });
    });
  }
  async search(query = "", offset = 0, id?: string) {
    if (id) { const entry = this.repo.knowledgeEntry(id); return { entries: entry ? [entry] : [], total: entry ? 1 : 0, nextOffset: null }; }
    const settings = this.config();
    if (!query.trim() || !settings.knowledgeDirectory || !settings.openKnowledgeExecutable) return this.repo.knowledge(query, offset);
    try {
      // okn 0.13 has no '--' terminator. Never let a query become a CLI option.
      if (query.trimStart().startsWith("-")) throw new Error("Use words rather than a leading CLI option for OpenKnowledge search.");
      const executable = knowledgePathSchema.parse(settings.openKnowledgeExecutable);
      const generation = await this.refresh();
      if (!generation) return this.repo.knowledge(query, offset);
      const packet = packetSchema.parse(JSON.parse(await this.run(executable, ["search", generation.directory, query, "--format", "json", "--budget", String(TOKEN_BUDGET), "--limit", String(SOURCE_LIMIT), "--no-expand"])));
      const byPath = new Map(generation.documents.map(doc => [doc.filename, doc]));
      const grouped = new Map<string, { doc: Document; sources: typeof packet.sources }>();
      for (const source of packet.sources) {
        const doc = byPath.get(source.path);
        if (!doc) continue; // Index, log, metadata and unknown files are not facts.
        const group = grouped.get(doc.entry.id) ?? { doc, sources: [] };
        group.sources.push(source); grouped.set(doc.entry.id, group);
      }
      const current = knowledgeDocuments(this.repo.allKnowledge());
      if (sha(JSON.stringify(current.map(doc => [doc.filename, sha(doc.content)]))) !== generation.revision) throw new Error("Knowledge changed during retrieval; retry for fresh ranked excerpts.");
      const literal = this.repo.knowledge(query).entries;
      const byId = new Map(generation.documents.map(doc => [doc.entry.id, doc]));
      const exact = literal.flatMap(entry => {
        const doc = byId.get(entry.id);
        if (!doc) return [];
        const match = grouped.get(entry.id);
        grouped.delete(entry.id);
        return [{ doc, sources: [literalSource(doc, query), ...(match?.sources ?? [])] }];
      });
      const ranked = [...exact, ...grouped.values()];
      const firstTerm = query.trim().toLocaleLowerCase().split(/\s+/)[0];
      ranked.sort((a, b) => Number(b.doc.entry.title.toLocaleLowerCase().includes(firstTerm)) - Number(a.doc.entry.title.toLocaleLowerCase().includes(firstTerm)));
      const selected = ranked.slice(offset, offset + PAGE_SIZE);
      let remaining = MAX_EXCERPT_CHARACTERS;
      const entries = [];
      for (const { doc, sources } of selected) {
        if (!remaining) break;
        const perDocument = Math.min(remaining, Math.max(1200, Math.floor(MAX_EXCERPT_CHARACTERS / selected.length)));
        let available = perDocument;
        const sections: (Omit<Source, "markdown"> & { truncated: boolean })[] = [];
        const excerpts: string[] = [];
        for (const { markdown, ...source } of sources) {
          if (!available) break;
          const excerpt = markdown.slice(0, Math.max(0, available - 2));
          if (!excerpt) continue;
          excerpts.push(excerpt); available -= excerpt.length + 2;
          sections.push({ ...source, truncated: excerpt.length < markdown.length });
        }
        const body = excerpts.join("\n\n");
        remaining -= body.length;
        entries.push({ ...doc.entry, body, retrieval: { excerpt: true, bodySha256: doc.bodySha256,
          exportRevision: generation.revision, path: doc.filename, sections } });
      }
      return { entries, total: ranked.length, nextOffset: offset + entries.length < ranked.length ? offset + entries.length : null,
        search: { engine: "openknowledge", limited: true, tokenBudget: TOKEN_BUDGET, tokenBudgetApproximate: true,
          engineEstimatedTokens: packet.estimatedTokens, maxExcerptCharacters: MAX_EXCERPT_CHARACTERS, literalDocuments: exact.length,
          sourceLimit: SOURCE_LIMIT, validationIssues: packet.issues?.length ?? 0, fullDocument: "Pass id to read an original complete entry." } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.warn(`Knowledge search fallback: ${message}`);
      return { ...this.repo.knowledge(query, offset), search: { engine: "sqlite", fallbackReason: message } };
    }
  }
}
