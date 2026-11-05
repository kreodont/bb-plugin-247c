import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Repository } from "./repository.js";

type Candidate = { threadId: string; runId: string; finishedAt: string };
const PREFIX = "source-thread-archive:";

/** Archive saved, successful checks without changing their results or proposals. */
export class SourceThreadArchives {
  private busy = new Set<string>();
  private retryAt = new Map<string, number>();
  private disposed = false;
  constructor(readonly bb: BbPluginApi, readonly repo: Repository,
    readonly importedThreads: () => { threadId: string; runId: string }[]) {}
  private candidates(threadId?: string): Candidate[] {
    const runs = this.repo.db.prepare(`SELECT id,thread_id AS threadId,json_extract(value_json,'$.finishedAt') AS finishedAt
      FROM source_sync_runs WHERE status='completed' AND json_extract(value_json,'$.finishedAt') IS NOT NULL ORDER BY rowid DESC`).all() as { id: string; threadId: string | null; finishedAt: string }[];
    const completed = new Map(runs.map(run => [run.id, run]));
    const candidates = new Map<string, Candidate>();
    for (const run of runs) if (run.threadId) candidates.set(run.threadId, { threadId: run.threadId, runId: run.id, finishedAt: run.finishedAt });
    for (const item of this.importedThreads()) {
      const run = completed.get(item.runId);
      if (run) candidates.set(item.threadId, { ...item, finishedAt: run.finishedAt });
    }
    const marked = new Set((this.repo.db.prepare("SELECT key FROM automation_state WHERE key LIKE 'source-thread-archive:%'").all() as { key: string }[]).map(row => row.key.slice(PREFIX.length)));
    return [...candidates.values()].filter(item => (!threadId || item.threadId === threadId) && Number.isFinite(Date.parse(item.finishedAt)) && !marked.has(item.threadId)
      && !this.busy.has(item.threadId) && (this.retryAt.get(item.threadId) ?? 0) <= Date.now()).slice(0, 50);
  }
  private record(candidate: Candidate, outcome: "archived" | "deleted" | "kept") {
    this.repo.db.prepare("INSERT INTO automation_state VALUES (?,?) ON CONFLICT(key) DO NOTHING")
      .run(PREFIX + candidate.threadId, JSON.stringify({ ...candidate, outcome, at: new Date().toISOString() }));
    this.retryAt.delete(candidate.threadId);
  }
  private stillCompleted(candidate: Candidate) {
    const row = this.repo.db.prepare("SELECT status FROM source_sync_runs WHERE id=?").get(candidate.runId) as { status: string } | undefined;
    return !this.disposed && row?.status === "completed";
  }
  private async ready(candidate: Candidate) {
    const { threadId } = candidate;
    const thread = await this.bb.sdk.threads.get({ threadId });
    if (this.disposed) return false;
    if (thread.originPluginId !== this.bb.pluginId) { this.record(candidate, "kept"); return false; }
    if (thread.archivedAt || thread.deletedAt) { this.record(candidate, thread.deletedAt ? "deleted" : "archived"); return false; }
    if (thread.status !== "idle" || thread.activeBackgroundAgentCount) return false;
    if ((await this.bb.sdk.threads.queuedMessages.list({ threadId })).length || (await this.bb.sdk.threads.interactions.list({ threadId })).length) return false;
    const timeline = await this.bb.sdk.threads.timeline({ threadId, segmentLimit: "1", includeNestedRows: "false", summaryOnly: "false", deferContent: "false" });
    if (this.disposed) return false;
    if (timeline.rows.some(row => row.kind === "conversation" && row.role === "user" && row.createdAt > Date.parse(candidate.finishedAt))) {
      // The user continued this chat after the saved check. Leave it under their control.
      this.record(candidate, "kept"); return false;
    }
    return this.stillCompleted(candidate);
  }
  async tick(threadId?: string) {
    if (this.disposed) return;
    for (const candidate of this.candidates(threadId)) {
      if (this.disposed) return;
      if (this.busy.has(candidate.threadId) || this.repo.db.prepare("SELECT 1 FROM automation_state WHERE key=?").get(PREFIX + candidate.threadId)) continue;
      this.busy.add(candidate.threadId);
      try {
        // Recheck after async inspection so a new turn is not archived by an old idle event.
        if (!await this.ready(candidate) || !await this.ready(candidate)) continue;
        await this.bb.sdk.threads.archive({ threadId: candidate.threadId });
        this.record(candidate, "archived");
      } catch (error) {
        this.retryAt.set(candidate.threadId, Date.now() + 60_000);
        this.bb.log.warn(`Could not archive completed source check ${candidate.threadId}; will retry: ${String(error)}`);
      } finally { this.busy.delete(candidate.threadId); }
    }
  }
  dispose() { this.disposed = true; }
}
