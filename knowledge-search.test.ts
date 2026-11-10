import { afterEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fixture } from "./test-support.js";
import { KnowledgeSearch, knowledgeDocuments } from "./knowledge-search.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function setup() {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "247c-knowledge-"));
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const f = await fixture();
  cleanups.push(() => f.harness.lifecycle.dispose());
  const settings = { knowledgeDirectory: path.join(root, "export"), openKnowledgeExecutable: path.join(root, "search") };
  const warnings: string[] = [];
  const search = new KnowledgeSearch(f.repo, () => settings, message => warnings.push(message));
  cleanups.push(() => search.dispose());
  async function imported(body = "# ExampleERP\n\nInvoice state.", count = 1) {
    await f.harness.behavior.callRpc("importKnowledge", { requestId: randomUUID(), source: { label: "ExampleCo", hostId: "host_example", rootPath: "/knowledge" },
      documents: Array.from({ length: count }, (_, index) => ({ relativePath: `doc-${index}.md`, title: `ExampleERP ${index}`, body, tags: ["reference"] })) });
  }
  async function executable(script: string) {
    await fs.writeFile(settings.openKnowledgeExecutable, `#!${process.execPath}\n${script}`, { mode: 0o700 });
  }
  return { f, settings, warnings, search, imported, executable, root };
}

it("exports original bodies and provenance atomically and supports complete reads by ID", async () => {
  const { f, search, imported, settings } = await setup();
  const body = "---\r\noriginal: header\r\n---\r\n# Пример\r\nExact quotation — do not translate.\r\n";
  await imported(body);
  const entry = f.repo.allKnowledge()[0], doc = knowledgeDocuments([entry])[0];
  const first = (await search.refresh())!;
  expect(await fs.readFile(path.join(first.directory, doc.filename), "utf8")).toBe(doc.content);
  expect(doc.content.endsWith(body)).toBe(true);
  expect(doc.content).toContain(JSON.stringify(entry.kind === "file" && entry.source));
  expect(await fs.realpath(path.join(settings.knowledgeDirectory, "current"))).toBe(first.directory);
  expect(await search.search("", 0, entry.id)).toEqual({ entries: [entry], total: 1, nextOffset: null });
  await imported("Replacement");
  const second = (await search.refresh())!;
  expect(second.revision).not.toBe(first.revision);
  expect(await fs.readFile(path.join(first.directory, doc.filename), "utf8")).toBe(doc.content);
  expect(f.repo.allKnowledge()).toHaveLength(1);
  expect(await f.harness.behavior.callRpc("knowledge", { id: entry.id })).toMatchObject({ total: 1, entries: [{ body: "Replacement" }] });
  const cli = await f.harness.behavior.runCli(["knowledge", "--id", entry.id, "--json"]);
  expect(cli.exitCode).toBe(0);
  expect(JSON.parse(cli.stdout!).entries[0].body).toBe("Replacement");
});

it("keeps proposed knowledge out until human acceptance", async () => {
  const { f, search, imported } = await setup();
  await imported();
  const task = await f.create();
  await f.harness.behavior.callRpc("start", { ...f.startInput(task.id, task.revision), criteria: [] });
  const session = f.repo.sessions(task.id)[0];
  const fact = "ExampleERP booked means the invoice is posted.";
  f.message(session.workerThreadId!, "user", fact);
  await f.idle(session.workerThreadId!, "Recorded.");
  await f.harness.behavior.callRpc("pauseSession", { sessionId: session.id });
  const ref = f.repo.transcript(session.id)!.messages.find(message => message.text === fact)!.ref;
  await f.idle(f.repo.session(session.id).reviewerThreadId!, { rationale: "Keep the definition.", facts: [{ kind: "description", text: fact, citations: [{ messageRef: ref, quote: fact }] }], changes: null,
    knowledge: [{ title: "Booked definition", body: fact, tags: ["ExampleERP"], evidenceRefs: ["fact:0"] }] });
  const pending = f.repo.session(session.id);
  expect((await search.refresh())!.documents.map(doc => doc.entry.kind)).toEqual(["file"]);
  await f.harness.behavior.callRpc("accept", { proposalId: pending.proposalId, revision: task.revision });
  const exported = (await search.refresh())!.documents;
  expect(exported).toHaveLength(2);
  expect(exported.find(doc => doc.entry.kind === "conversation")!.content).toContain(pending.proposalId!);
});

it("returns bounded ranked excerpts, preserves provenance and pages without treating index text as knowledge", async () => {
  const { f, search, imported, executable } = await setup();
  await imported("# ExampleERP\n\nFull original body with a tail.", 12);
  const docs = knowledgeDocuments(f.repo.allKnowledge());
  const source = (filename: string) => ({ path: filename, lineStart: 1, lineEnd: 2, markdown: "Relevant excerpt", score: 2, relation: "direct" });
  await executable(`if (process.env.OPENKNOWLEDGE_TELEMETRY_SUPPRESS !== '1' || !process.argv.includes('--budget')) process.exit(1);\nconsole.log(${JSON.stringify(JSON.stringify({ schemaVersion: "1", estimatedTokens: 100, sources: [source("index.md"), ...docs.map(doc => source(doc.filename))] }))});`);
  const first = await search.search("invoice");
  expect(first).toMatchObject({ total: 12, nextOffset: 10, search: { engine: "openknowledge", tokenBudget: 2400, limited: true } });
  expect(first.entries).toHaveLength(10);
  expect(first.entries[0]).toMatchObject({ id: docs[0].entry.id, body: "Relevant excerpt", retrieval: { excerpt: true, bodySha256: docs[0].bodySha256 } });
  expect((await search.search("invoice", 10)).entries).toHaveLength(2);
  expect((await search.search("", 0, docs[0].entry.id)).entries[0].body).toContain("Full original body");
});

it.each(["missing", "invalid", "option", "tampered", "extra", "symlink"])("falls back to accepted database content on %s retrieval", async mode => {
  const { search, imported, executable, settings, root } = await setup();
  await imported("Invoice known fact");
  const generation = (await search.refresh())!;
  if (mode === "invalid") await executable("console.log('invalid json');");
  if (mode === "option") await executable("throw new Error('Must never execute');");
  if (mode === "tampered") await fs.writeFile(path.join(generation.directory, "index.md"), "Manual unapproved fact");
  if (mode === "extra") await fs.writeFile(path.join(generation.directory, "unapproved.md"), "Manual unapproved fact");
  if (mode === "symlink") {
    await fs.rename(settings.knowledgeDirectory, path.join(root, "other"));
    await fs.symlink(path.join(root, "other"), settings.knowledgeDirectory);
  }
  const result = await search.search(mode === "option" ? "--version" : "Invoice");
  expect(result).toMatchObject({ search: { engine: "sqlite", fallbackReason: expect.any(String) } });
  if (mode !== "option") expect(result.entries[0].body).toBe("Invoice known fact");
});

it("refuses an occupied export folder without changing its content", async () => {
  const { search, settings } = await setup();
  await fs.mkdir(settings.knowledgeDirectory);
  const existing = path.join(settings.knowledgeDirectory, "personal.md");
  await fs.writeFile(existing, "Keep this");
  await expect(search.refresh()).rejects.toThrow("empty dedicated");
  expect(await fs.readFile(existing, "utf8")).toBe("Keep this");
});

it("discards a search snapshot when accepted knowledge changes during retrieval", async () => {
  const { f, search, imported, executable, root } = await setup();
  await imported();
  const started = path.join(root, "started"), release = path.join(root, "release");
  const doc = knowledgeDocuments(f.repo.allKnowledge())[0];
  await executable(`const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(started)}, '1'); const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(release)})) { clearInterval(timer); console.log(${JSON.stringify(JSON.stringify({ schemaVersion: "1", estimatedTokens: 1, sources: [{ path: doc.filename, lineStart: 1, lineEnd: 2, markdown: "Old content", score: 1, relation: "direct" }] }))}); } }, 10);`);
  const pending = search.search("Invoice");
  await expect.poll(() => fs.access(started).then(() => true, () => false)).toBe(true);
  await imported("Invoice corrected fact");
  await fs.writeFile(release, "1");
  expect(await pending).toMatchObject({ entries: [{ body: "Invoice corrected fact" }], search: { engine: "sqlite", fallbackReason: expect.stringContaining("changed") } });
});

it("prioritizes literal matches omitted by fuzzy search and enforces an excerpt size ceiling", async () => {
  const { f, search, imported, executable } = await setup();
  await imported("# ExampleERP\n\ninvoice rarecode\n" + "Long context ".repeat(5000));
  const doc = knowledgeDocuments(f.repo.allKnowledge())[0];
  await executable(`console.log(${JSON.stringify(JSON.stringify({ schemaVersion: "1", estimatedTokens: 9999, sources: [{ path: doc.filename, lineStart: 1, lineEnd: 20, markdown: "x".repeat(50000), score: 1, relation: "direct" }] }))});`);
  const result = await search.search("invoice rarecode");
  expect(result).toMatchObject({ search: { literalDocuments: 1 } });
  expect(result.entries[0].body).toContain("invoice rarecode");
  expect(result.entries.reduce((sum, entry) => sum + entry.body.length, 0)).toBeLessThanOrEqual(9600);
});

it("automatically refreshes the configured export after imports and exposes a usable generation path", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "247c-auto-export-"));
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const f = await fixture({ settings: { knowledgeDirectory: path.join(root, "knowledge") } });
  cleanups.push(() => f.harness.lifecycle.dispose());
  await f.harness.behavior.callRpc("importKnowledge", { requestId: randomUUID(), source: { label: "ExampleCo", hostId: "host_example", rootPath: "/knowledge" }, documents: [{ relativePath: "note.md", title: "Note", body: "Approved note" }] });
  await expect.poll(async () => (await f.harness.behavior.callRpc("knowledgeExportStatus", {}) as { documents: number }).documents).toBe(1);
  const status = await f.harness.behavior.callRpc("knowledgeExportStatus", {}) as { directory: string };
  expect((await fs.lstat(status.directory)).isSymbolicLink()).toBe(false);
  expect(JSON.parse(await fs.readFile(path.join(status.directory, "manifest.json"), "utf8")).entries).toHaveLength(1);
});

it("cancels a running search when the plugin is disposed", async () => {
  const { search, imported, executable, root } = await setup();
  await imported();
  const started = path.join(root, "started");
  await executable(`require('node:fs').writeFileSync(${JSON.stringify(started)}, '1'); setInterval(() => {}, 1000);`);
  const pending = search.search("Invoice");
  await expect.poll(() => fs.access(started).then(() => true, () => false)).toBe(true);
  await search.dispose();
  expect(await pending).toMatchObject({ search: { engine: "sqlite" } });
});
