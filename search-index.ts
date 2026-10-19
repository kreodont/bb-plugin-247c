import { createHash } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Repository } from "./repository.js";
import type { SearchHit, SearchInput, SearchResult } from "./search-contracts.js";
import { searchInputSchema } from "./search-contracts.js";

type TimelineRow = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["timeline"]>>["rows"][number];
type IndexedThread = { thread_id: string; task_id: string; session_id: string; role: string; max_seq: number; cursor_json: string | null; target_seq: number; complete: number };
type Document = { key: string; task: string; kind: SearchHit["kind"]; label: string; title?: string; body: string; at?: string | null; thread?: string | null; sequence?: number | null; session?: string | null };
const clean = (value: string) => value.replace(/[\u0000-\u0002]/g, " ");
const PAGE_SIZE = 30;

function threadNotFound(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { code?: unknown; message?: unknown };
  // Some SDK transports expose the code, others only the HTTP error message.
  // A generic 404, permission error or network failure is not proof of deletion.
  return value.code === "thread_not_found" || typeof value.message === "string"
    && /^(?:BbHttpError: )?HTTP 404: Thread not found$/.test(value.message);
}

// FTS operators are never accepted from free text. Quotes mean a phrase;
// identifiers stay exact, while ordinary unquoted words support a prefix.
export function searchExpression(query: string): string {
  const terms: string[] = [];
  for (const part of query.matchAll(/"([^"]*)"|([^\s"]+)/gu)) {
    const value = part[1] ?? part[2], words = value.match(/[\p{L}\p{N}\p{M}]+/gu);
    if (!words?.length) continue;
    const prefix = part[1] === undefined && words.length === 1 && /^[\p{L}\p{M}]+$/u.test(value);
    terms.push(`"${words.join(" ")}"${prefix ? "*" : ""}`);
  }
  if (terms.length > 32) throw new Error("Use at most 32 search terms.");
  return terms.join(" AND ");
}

export class TaskSearch {
  private running: Promise<void> | null = null;
  private disposed = false;
  constructor(private readonly repo: Repository, private readonly bb: BbPluginApi, private readonly changed: () => void) {}
  private get db() { return this.repo.db; }
  dispose() { this.disposed = true; }

  private put(doc: Document) {
    if (!doc.body.trim() && !doc.title?.trim()) return;
    this.db.prepare(`INSERT INTO search_documents(key,task_id,kind,label,title,body,at,thread_id,sequence,session_id)
      VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET
      task_id=excluded.task_id,kind=excluded.kind,label=excluded.label,title=excluded.title,body=excluded.body,
      at=COALESCE(excluded.at,search_documents.at),thread_id=excluded.thread_id,sequence=CASE WHEN excluded.at IS NOT NULL OR search_documents.at IS NULL THEN excluded.sequence ELSE search_documents.sequence END,session_id=excluded.session_id
      WHERE search_documents.body<>excluded.body OR search_documents.title<>excluded.title OR search_documents.label<>excluded.label OR (search_documents.at IS NULL AND excluded.at IS NOT NULL) OR (excluded.at IS NOT NULL AND search_documents.sequence IS NOT excluded.sequence)`)
      .run(doc.key, doc.task, doc.kind, doc.label, clean(doc.title ?? ""), clean(doc.body), doc.at ?? null, doc.thread ?? null, doc.sequence ?? null, doc.session ?? null);
  }

  syncLocal() {
    const pending = this.db.prepare("SELECT kind,id FROM search_dirty ORDER BY kind,id LIMIT 100").all() as { kind: string; id: string }[];
    this.repo.store.transaction(() => {
      for (const item of pending) {
        if (item.kind === "task") {
          this.db.prepare("DELETE FROM search_documents WHERE task_id=? AND kind IN ('task','fact')").run(item.id);
          if (this.db.prepare("SELECT 1 FROM tasks WHERE id=?").get(item.id)) {
            const dossier = this.repo.kernel.getDossier(item.id), p = dossier.projection;
            this.put({ key: `task:${item.id}`, task: item.id, kind: "task", label: "Current task", title: dossier.task.title, at: dossier.task.updatedAt,
              body: [item.id, p.customer, p.summary, p.nextStep, ...p.openQuestions, ...p.blockers, ...p.artifacts.map(a => `${a.label} ${a.uri}`)].filter(Boolean).join("\n") });
            for (const f of dossier.facts) this.put({ key: `fact:${f.id}`, task: item.id, kind: "fact", label: `Dossier history · ${f.kind.replaceAll("_", " ")}`, body: [f.text, f.sourceRef].filter(Boolean).join("\n"), at: f.occurredAt });
          } else {
            this.db.prepare("DELETE FROM search_documents WHERE task_id=?").run(item.id);
            this.db.prepare("DELETE FROM search_threads WHERE task_id=?").run(item.id);
          }
        } else {
          const transcript = this.repo.transcript(item.id);
          const session = this.db.prepare("SELECT task_id FROM sessions WHERE id=?").get(item.id) as { task_id: string } | undefined;
          if (transcript && session) for (const m of transcript.messages) {
            if (m.role === "context") continue;
            const thread = m.source?.threadId ?? transcript.threadId, ref = m.source?.messageRef ?? m.ref;
            // Older snapshots contain timeline range starts, not native message IDs.
            // Offer a message jump only after reading its live timeline metadata.
            const sequence = null;
            const original = this.repo.forThread(thread);
            this.put({ key: `message:${thread}:${ref}`, task: original?.taskId ?? session.task_id, kind: "message", label: m.role === "user" ? "You · conversation" : "Assistant · conversation",
              body: m.text, thread, sequence, session: original?.id ?? item.id });
          }
        }
        this.db.prepare("DELETE FROM search_dirty WHERE kind=? AND id=?").run(item.kind, item.id);
      }
    });
    return pending.length;
  }

  private discover() {
    this.db.exec(`INSERT OR IGNORE INTO search_threads(thread_id,task_id,session_id,role)
      SELECT st.thread_id,s.task_id,s.id,st.role FROM session_threads st JOIN sessions s ON s.id=st.session_id;
      INSERT OR IGNORE INTO search_threads(thread_id,task_id,session_id,role)
      SELECT json_extract(value_json,'$.workerThreadId'),task_id,id,'worker' FROM sessions WHERE json_extract(value_json,'$.workerThreadId') IS NOT NULL;
      INSERT OR IGNORE INTO search_threads(thread_id,task_id,session_id,role)
      SELECT json_extract(value_json,'$.reviewerThreadId'),task_id,id,'reviewer' FROM sessions WHERE json_extract(value_json,'$.reviewerThreadId') IS NOT NULL;`);
  }
  dirtyThread(threadId: string) {
    this.discover();
    this.db.prepare("UPDATE search_threads SET missing=0,due_at=0 WHERE thread_id=?").run(threadId);
  }
  retry() {
    this.discover();
    this.db.exec("UPDATE search_threads SET due_at=0 WHERE missing=0 AND (error IS NOT NULL OR complete=0)");
    return this.state();
  }
  state(): SearchResult["state"] {
    const count = (sql: string) => (this.db.prepare(sql).get() as { n: number }).n;
    return {
      documents: count("SELECT count(*) AS n FROM search_documents"),
      pending: count("SELECT count(*) AS n FROM search_dirty") + count("SELECT count(*) AS n FROM search_threads WHERE missing=0 AND complete=0 AND error IS NULL"),
      threads: count("SELECT count(*) AS n FROM search_threads WHERE missing=0"),
      indexedThreads: count("SELECT count(*) AS n FROM search_threads WHERE missing=0 AND complete=1"),
      unavailableThreads: count("SELECT count(*) AS n FROM search_threads WHERE missing=0 AND error IS NOT NULL"),
      lastIndexedAt: (this.db.prepare("SELECT max(indexed_at) AS at FROM search_threads").get() as { at: string | null }).at,
    };
  }
  search(input: SearchInput): SearchResult {
    input = searchInputSchema.parse(input);
    this.syncLocal(); this.discover();
    const expression = searchExpression(input.query), state = this.state();
    if (!expression) return { hits: [], total: 0, nextOffset: null, state };
    const conditions = ["search_fts MATCH ?"], params: (string | number)[] = [expression];
    if (input.scope !== "all") conditions.push(input.scope === "tasks" ? "d.kind='task'" : input.scope === "history" ? "d.kind='fact'" : "d.kind IN ('message','review')");
    if (input.status !== "all") conditions.push(input.status === "unfinished" ? "t.status IN ('open','waiting')" : "t.status IN ('done','archived')");
    const from = `FROM search_fts JOIN search_documents d ON d.id=search_fts.rowid JOIN tasks t ON t.id=d.task_id WHERE ${conditions.join(" AND ")}`;
    const total = (this.db.prepare(`SELECT count(*) AS n ${from}`).get(...params) as { n: number }).n;
    const rows = this.db.prepare(`SELECT d.key AS id,d.task_id AS taskId,t.title AS taskTitle,t.status AS taskStatus,
      d.kind,d.label,d.at,d.thread_id AS threadId,d.sequence,d.session_id AS sessionId,
      substr(snippet(search_fts,1,char(1),char(2),' … ',36),1,1400) AS snippet,
      substr(highlight(search_fts,0,char(1),char(2)),1,600) AS titleMatch
      ${from} ORDER BY bm25(search_fts,8.0,1.0),d.id LIMIT ? OFFSET ?`).all(...params, PAGE_SIZE, input.offset) as SearchHit[];
    return { hits: rows, total, nextOffset: input.offset + rows.length < total ? input.offset + rows.length : null, state };
  }

  refresh(signal: AbortSignal) {
    if (!this.running) this.running = this.refreshBatch(signal).finally(() => { this.running = null; });
    return this.running;
  }
  private async refreshBatch(signal: AbortSignal) {
    if (signal.aborted || this.disposed) return;
    const local = this.syncLocal();
    this.discover();
    const threads = this.db.prepare("SELECT * FROM search_threads WHERE missing=0 AND due_at<=? ORDER BY complete,due_at,thread_id LIMIT 8").all(Date.now()) as IndexedThread[];
    for (const thread of threads) {
      if (signal.aborted || this.disposed) break;
      try { await this.readPage(thread, signal); }
      catch (error) {
        if (signal.aborted || this.disposed) break;
        if (threadNotFound(error)) {
          this.db.prepare("UPDATE search_threads SET missing=1,error=NULL WHERE thread_id=?").run(thread.thread_id);
          continue;
        }
        // Never log message text, RPC payloads, or provider error bodies.
        this.db.prepare("UPDATE search_threads SET error='Could not read this chat.',due_at=? WHERE thread_id=?")
          .run(Date.now() + 5 * 60_000, thread.thread_id);
      }
    }
    if (!signal.aborted && !this.disposed && (local || threads.length)) this.changed();
  }

  private async readPage(thread: IndexedThread, signal: AbortSignal) {
    const cursor = thread.cursor_json ? JSON.parse(thread.cursor_json) as { anchorId: string; anchorSeq: number } : null;
    const page = await this.bb.sdk.threads.timeline({ threadId: thread.thread_id, segmentLimit: "100", includeNestedRows: "true", summaryOnly: "false", deferContent: "false", signal,
      ...(cursor ? { beforeAnchorId: cursor.anchorId, beforeAnchorSeq: String(cursor.anchorSeq) } : {}) });
    if (signal.aborted || this.disposed) return;
    const docs: Document[] = [];
    let oldest = Infinity;
    const add = (row: TimelineRow, role: "user" | "assistant", text: string, suffix = "") => {
      if (!text.trim()) return;
      const ref = `message:${row.sourceSeqStart}:${createHash("sha256").update(JSON.stringify(row.id)).digest("hex").slice(0, 12)}${suffix}`;
      docs.push({ key: `message:${thread.thread_id}:${ref}`, task: thread.task_id, kind: thread.role === "reviewer" ? "review" : "message",
        label: thread.role === "reviewer" ? "Review output · not accepted task data" : role === "user" ? "You · conversation" : "Assistant · conversation",
        body: text, at: new Date(row.createdAt).toISOString(), thread: thread.thread_id, sequence: row.kind === "conversation" ? row.messageSeq ?? row.sourceSeqStart : null, session: thread.session_id });
    };
    const visit = (row: TimelineRow) => {
      oldest = Math.min(oldest, row.sourceSeqStart);
      if (row.kind === "turn") {
        if (row.children === null && row.summaryCount > 0) throw new Error("Incomplete timeline page");
        row.children?.forEach(visit);
      } else if (row.kind === "conversation") {
        if (row.role === "user" && (row.turnRequest.status !== "accepted" || row.initiator !== "user" || thread.role === "reviewer")) return;
        add(row, row.role, row.text);
      } else if (row.kind === "work" && row.workKind === "question" && thread.role !== "reviewer") {
        row.questions.forEach((question, i) => {
          add(row, "assistant", question.prompt, `:q${i}`);
          const answer = row.answers?.[question.id];
          if (answer) add(row, "user", [...answer.selected.map(v => question.options?.find(o => o.value === v)?.label ?? v), answer.freeText ?? ""].filter(Boolean).join("\n"), `:a${i}`);
        });
      }
    };
    page.rows.forEach(visit);
    const target = cursor ? thread.target_seq : page.maxSeq;
    const complete = !page.timelinePage.hasOlderRows || thread.complete === 1 && oldest <= thread.max_seq;
    const next = page.timelinePage.olderCursor;
    if (!complete && (!next || JSON.stringify(next) === thread.cursor_json)) throw new Error("Invalid timeline cursor");
    this.repo.store.transaction(() => {
      for (const doc of docs) this.put(doc);
      const session = this.db.prepare("SELECT status FROM sessions WHERE id=?").get(thread.session_id) as { status: string } | undefined;
      const active = session && ["starting", "working", "collecting", "review_starting", "reviewing", "repair_starting"].includes(session.status);
      this.db.prepare(`UPDATE search_threads SET max_seq=?,cursor_json=?,target_seq=?,complete=?,due_at=?,indexed_at=?,error=NULL WHERE thread_id=?`)
        .run(complete ? Math.max(thread.max_seq, target) : thread.max_seq, complete ? null : JSON.stringify(next), target, complete ? 1 : thread.complete,
          complete ? Date.now() + (active ? 15_000 : 24 * 60 * 60_000) : 0, complete ? new Date().toISOString() : null, thread.thread_id);
    });
  }
}
