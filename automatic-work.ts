import { statusNeedsStoppedSession } from "./task-status.js";
import { canFinishForSource, SourceSessionBusy } from "./source-session.js";
import { sessionFinishMode } from "./finish-mode.js";
import { randomUUID } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { sessionSchema, sessionUpdateSchema, type Session, type SyncCandidate, type PartDecision } from "./contracts.js";
import { DayPlanning } from "./day-planning.js";
import { proposalParts } from "./proposal-parts.js";
import { Repository } from "./repository.js";
import { SessionRuntime } from "./runtime.js";
import { SourceSyncStore } from "./source-sync.js";

type Control = { enabled: boolean; since: string | null };


export class AutomaticWork {
  private running: Promise<void> | undefined;
  constructor(readonly bb: BbPluginApi, readonly repo: Repository, readonly runtime: SessionRuntime,
    readonly sources: SourceSyncStore, readonly days: DayPlanning,
    readonly settings: () => { automaticProcessing: boolean; automaticMaximumWorkers: number }, readonly clock = () => new Date()) {}
  private read<T>(key: string): T | undefined {
    const row = this.repo.db.prepare("SELECT value_json FROM automation_state WHERE key=?").get(key) as { value_json: string } | undefined;
    return row ? JSON.parse(row.value_json) : undefined;
  }
  private save(key: string, value: unknown) {
    this.repo.db.prepare("INSERT INTO automation_state VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json").run(key, JSON.stringify(value));
    this.repo.changed();
  }
  private remove(key: string) { this.repo.db.prepare("DELETE FROM automation_state WHERE key=?").run(key); this.repo.changed(); }
  control() {
    const previous = this.read<Control>("control"), enabled = this.settings().automaticProcessing;
    if (!previous || previous.enabled !== enabled) {
      const next = { enabled, since: enabled ? this.clock().toISOString() : previous?.since ?? null };
      this.save("control", next); return next;
    }
    return previous;
  }
  private sessions(): Session[] {
    return (this.repo.db.prepare("SELECT value_json FROM sessions WHERE json_extract(value_json,'$.automation') IS NOT NULL AND json_extract(value_json,'$.automation.appliedAt') IS NULL").all() as { value_json: string }[])
      .map(row => sessionSchema.parse(JSON.parse(row.value_json)));
  }
  state() {
    const control = this.control();
    const paused = (this.repo.db.prepare("SELECT key,value_json FROM automation_state WHERE key LIKE 'pause:%'").all() as { key: string; value_json: string }[])
      .map(row => ({ taskId: row.key.slice(6), title: this.repo.kernel.getTask(row.key.slice(6)).title, until: JSON.parse(row.value_json).until as string }));
    const errors: { id: string; message: string; retryable: boolean; threadId: string | null }[] = (this.repo.db.prepare("SELECT key,value_json FROM automation_state WHERE key LIKE 'error:%'").all() as { key: string; value_json: string }[])
      .map(row => ({ id: row.key.slice(6), message: String(JSON.parse(row.value_json).message), retryable: true, threadId: null }));
    for (const row of this.repo.db.prepare("SELECT value_json FROM source_sync_candidates WHERE status='applied' AND json_extract(value_json,'$.chatDelivery.automatic')=1 AND json_extract(value_json,'$.chatDelivery.state') IN ('failed','uncertain')").all() as { value_json: string }[]) {
      const candidate = JSON.parse(row.value_json) as SyncCandidate, delivery = candidate.chatDelivery!;
      errors.push({ id: `delivery:${candidate.id}`, message: delivery.error ?? "The automatic update could not be delivered.", retryable: delivery.state === "failed", threadId: delivery.threadId });
    }
    const queued = (this.repo.db.prepare("SELECT count(*) AS n FROM source_sync_candidates WHERE status='applied' AND json_extract(value_json,'$.chatDelivery.automatic')=1 AND json_extract(value_json,'$.chatDelivery.state')='pending'").get() as { n: number }).n;
    return { ...control, maximumWorkers: this.settings().automaticMaximumWorkers, paused, errors, queued,
      sessions: this.sessions().filter(s => !["cancelled", "rejected"].includes(s.status)).map(s => ({ taskId: s.taskId, title: this.repo.kernel.getTask(s.taskId).title,
        sessionId: s.id, threadId: s.workerThreadId, state: s.status === "blocked" ? "blocked" : ["collecting", "review_starting", "reviewing"].includes(s.status) ? "reviewing" : s.automation!.state, note: s.automation!.note ?? s.error ?? null })) };
  }
  async retry(id: string) {
    if (id.startsWith("delivery:")) {
      const candidate = this.sources.candidate(id.slice(9)), delivery = candidate.chatDelivery;
      if (!delivery || delivery.state !== "failed") throw new Error("Check the chat before retrying an uncertain delivery. It will not be sent twice automatically.");
      this.repo.db.prepare("UPDATE source_sync_candidates SET value_json=? WHERE id=?").run(JSON.stringify({ ...candidate, chatDelivery: { ...delivery, state: "pending", error: null } }), candidate.id);
    } else {
      const session = this.sessions().find(s => s.id === id);
      if (session?.status === "blocked" && session.finishedAt) await this.runtime.retry(id);
      this.remove(`error:${id}`);
    }
    return this.state();
  }
  manualOpen(taskId: string) {
    this.remove(`pause:${taskId}`);
    const session = this.repo.active().find(s => s.taskId === taskId && s.status === "working" && s.automation?.outcome === "paused");
    if (session) this.repo.saveSession({ ...session, automation: { state: "working" } });
  }
  allow(candidate: SyncCandidate) {
    if (!this.control().enabled || !candidate.resultTaskId || this.read(`pause:${candidate.resultTaskId}`)) return false;
    if (this.repo.kernel.getTask(candidate.resultTaskId).status !== "open") return false;
    const active = this.repo.active().find(s => s.taskId === candidate.resultTaskId);
    if (active) return true;
    const workers = this.sessions().filter(s => ["starting", "working", "collecting", "review_starting", "reviewing"].includes(s.status) && s.automation?.state !== "needs_input" && !(s.status === "working" && s.automation?.state === "ready"));
    return workers.length < this.settings().automaticMaximumWorkers;
  }
  opened(_candidate: SyncCandidate, session: Session) {
    const current = this.repo.session(session.id);
    this.repo.saveSession({ ...current, automation: { state: "working" } });
  }
  async acceptSource(id: string, priority?: { urgent: boolean; important: boolean }, automatic = false) {
    const candidate = this.sources.candidate(id);
    if (candidate.status !== "pending") return this.sources.accept(id, priority, automatic);
    return this.withSourceSession(candidate, sessionId => this.sources.accept(id, priority, automatic, sessionId), automatic);
  }
  async reviewSourceParts(input: PartDecision) {
    if (input.decision !== "accept" || !input.parts.includes("field:status")) return this.sources.reviewParts(input);
    const candidate = this.sources.candidate(input.id);
    if (candidate.status !== "pending") return this.sources.reviewParts(input);
    return this.withSourceSession(candidate, sessionId => this.sources.reviewParts(input, sessionId), false);
  }
  private async withSourceSession<T>(candidate: SyncCandidate, apply: (sessionId?: string) => T, automatic: boolean): Promise<T> {
    const session = candidate.taskId ? this.repo.active().find(s => s.taskId === candidate.taskId) : undefined;
    if (!session || candidate.changes.status?.value !== "done") return apply();
    if (!canFinishForSource(session, candidate) || !session.workerThreadId) throw new SourceSessionBusy();
    this.repo.assertCurrent(session.taskId, candidate.baseRevision!, false);
    const threadId = session.workerThreadId, lastUserSeq = await this.lastUserSeq(threadId);
    const ready = async () => {
      const current = this.repo.session(session.id);
      if (!canFinishForSource(current, candidate)
        || automatic && (current.automation?.state === "needs_input" && current.automation.requestedAt
          || !this.control().enabled || this.read(`pause:${session.taskId}`))) return false;
      const thread = await this.bb.sdk.threads.get({ threadId });
      return thread.status === "idle" && !thread.activeBackgroundAgentCount
        && !(await this.bb.sdk.threads.queuedMessages.list({ threadId })).length
        && !(await this.bb.sdk.threads.interactions.list({ threadId })).length
        && await this.lastUserSeq(threadId) === lastUserSeq;
    };
    if (!await ready()) throw new SourceSessionBusy();
    let result: { value: T } | undefined;
    // Runtime rechecks readiness after model selection and freezes the dialogue,
    // captures time and applies the source in one transaction.
    await this.runtime.finish(session.id, "auto", ready, { automatic: this.control().enabled, apply: () => {
      result = { value: apply(session.id) };
      this.repo.sessionEvent(session.id, "source-resolution",
        "An accepted source update completed the task and ended its idle work session. Session work and reported time are reviewed separately.",
        { candidateId: candidate.id });
    } });
    if (!result) throw new SourceSessionBusy();
    return result.value;
  }
  private async lastUserSeq(threadId: string) {
    const page = await this.bb.sdk.threads.timeline({ threadId, segmentLimit: "100", includeNestedRows: "false", summaryOnly: "false", deferContent: "false" });
    return Math.max(0, ...page.rows.filter(r => r.kind === "conversation" && r.role === "user").map(r => r.sourceSeqEnd));
  }
  async finish(id: string, recorder: "auto" | "same" | "personal-claude" = "auto") {
    const session = this.repo.session(id);
    const enabled = this.control().enabled;
    if (session.mode === "conversation" && session.status === "working") {
      const task = this.repo.kernel.getTask(session.taskId);
      const finishMode = session.continuedFrom ? sessionFinishMode(session) : ["open", "waiting"].includes(task.status) ? "resolve" as const : undefined;
      if (session.automation?.outcome === "paused") this.manualOpen(session.taskId);
      const current = this.repo.session(id);
      this.repo.saveSession({ ...current, ...(finishMode ? { finishMode } : {}),
        ...(enabled ? { automation: { state: "reviewing" as const } } : {}) });
    }
    return this.runtime.finish(id, recorder);
  }

  async pause(id: string) {
    const session = this.repo.session(id);
    if (session.mode !== "conversation" || session.status !== "working" || session.finishedAt) throw new Error("Pause an open work chat before its review begins.");
    const task = this.repo.kernel.getTask(session.taskId);
    if (!["open", "waiting"].includes(task.status)) throw new Error("Only an open task can be paused.");
    if (task.status === "waiting") this.repo.status(task.id, "open", task.revision);
    const until = this.days.pauseUntilTomorrow(session.taskId, session.id);
    this.save(`pause:${session.taskId}`, { until, sessionId: id });
    this.repo.saveSession({ ...this.repo.session(id), finishMode: "pause", automation: { state: "reviewing", outcome: "paused", pauseUntil: until, note: "Paused until manual continuation." } });
    this.repo.sessionEvent(id, "paused", "The user paused this task and moved it to tomorrow's plan. No automatic restart.", { until });
    return this.runtime.finish(id);
  }
  tick() {
    if (this.running) return this.running;
    const operation = this.drain(); this.running = operation;
    void operation.finally(() => { if (this.running === operation) this.running = undefined; }).catch(() => {});
    return operation;
  }
  private error(id: string, error: unknown) {
    const row = this.repo.db.prepare("SELECT value_json FROM sessions WHERE id=?").get(id) as { value_json: string } | undefined;
    const session = row ? sessionSchema.parse(JSON.parse(row.value_json)) : undefined;
    this.save(`error:${id}`, { ...(session ? { proposalId: session.proposalId, status: session.status } : {}), message: (error instanceof Error ? error.message : String(error)).slice(0, 2000) }); }
  private manuallyHeld(kind: string, id: string) {
    return Boolean(this.repo.db.prepare("SELECT 1 FROM part_reviews WHERE kind=? AND json_extract(value_json,'$.remainingId')=? AND coalesce(json_extract(value_json,'$.actor'),'human')!='automation:247c' LIMIT 1").get(kind, id));
  }
  private async drain() {
    const control = this.control();
    if (!control.enabled) return;
    // A manual review/rejection resolves the automatic error as well.
    for (const row of this.repo.db.prepare("SELECT key FROM automation_state WHERE key LIKE 'error:%'").all() as { key: string }[]) {
      const id = row.key.slice(6), source = this.repo.db.prepare("SELECT status FROM source_sync_candidates WHERE id=?").get(id) as { status: string } | undefined;
      const session = this.repo.db.prepare("SELECT status,json_extract(value_json,'$.proposalId') AS proposalId FROM sessions WHERE id=?").get(id) as { status: string; proposalId: string | null } | undefined;
      const error = this.read<{ status?: string; proposalId?: string | null }>(row.key);
      if (session && (error?.status === "blocked" && ["collecting", "review_starting", "reviewing"].includes(session.status) || error?.proposalId !== session.proposalId)) { this.remove(row.key); continue; }
      if (source && source.status !== "pending" || session && ["applied", "completed", "rejected", "cancelled"].includes(session.status)) this.remove(row.key);
    }
    for (const candidate of this.sources.pendingCandidates()) {
      if (candidate.createdAt < control.since! || this.read(`error:${candidate.id}`) || this.manuallyHeld("source", candidate.id)) continue;
      if (["starting", "working"].includes(this.sources.run(candidate.runId).status)) continue;
      const active = candidate.taskId ? this.repo.active().find(s => s.taskId === candidate.taskId) : undefined;
      if (active && (!canFinishForSource(active, candidate) && candidate.changes.status && statusNeedsStoppedSession(this.repo.kernel.getTask(active.taskId).status, candidate.changes.status.value) || !["starting", "working"].includes(active.status))) continue;
      try { await this.acceptSource(candidate.id, undefined, true); }
      catch (error) { if (!(error instanceof SourceSessionBusy)) this.error(candidate.id, error); }
    }
    for (const original of this.sessions()) {
      if (!this.control().enabled) break;
      if (this.read(`error:${original.id}`)) continue;
      try {
        let session = this.repo.session(original.id);
        if (session.status === "working" && session.automation?.state === "working" && session.workerThreadId && this.clock().getTime() - Date.parse(session.updatedAt) > 30000) {
          const threadId = session.workerThreadId;
          if ((await this.bb.sdk.threads.get({ threadId })).status === "idle" && !(await this.bb.sdk.threads.queuedMessages.list({ threadId })).length) {
            this.repo.saveSession({ ...session, automation: { state: "needs_input", note: "The worker has replied. Open the chat to continue or finish the session." } }); continue;
          }
        }
        if (session.status === "working" && session.automation?.state === "ready" && session.workerThreadId) {
          const threadId = session.workerThreadId, thread = await this.bb.sdk.threads.get({ threadId });
          if (thread.status !== "idle" || (await this.bb.sdk.threads.queuedMessages.list({ threadId })).length || (await this.bb.sdk.threads.interactions.list({ threadId })).length) continue;
          if (await this.lastUserSeq(threadId) !== session.automation.lastUserSeq) {
            this.repo.saveSession({ ...session, automation: { state: "working" } }); continue;
          }
          // A checkpoint is informational. Only an explicit Finish or Pause starts review.
          continue;
        }
        if (session.status === "blocked") { this.error(session.id, session.error ?? "The work or review needs attention. Open its chat."); continue; }
        if (session.status === "completed" || session.status === "applied") {
          this.repo.saveSession({ ...session, automation: { ...session.automation!, state: "applied", appliedAt: this.clock().toISOString() } }); continue;
        }
        if (session.status !== "awaiting_approval" || !session.proposalId) continue;
        if (this.manuallyHeld("proposal", session.proposalId)) continue;
        this.repo.sessionTime.reconcile(session.taskId);
        session = this.repo.session(session.id);
        const proposal = this.repo.kernel.getProposal(session.proposalId!);
        if (proposal.status !== "pending") continue;
        const row = this.repo.db.prepare("SELECT value_json FROM session_updates WHERE proposal_id=?").get(proposal.id) as { value_json: string } | undefined;
        if (!row) throw new Error("The session review has no validated extraction.");
        const update = sessionUpdateSchema.parse(JSON.parse(row.value_json));
        const parts = proposalParts(proposal.changes, update.extraction).filter(p => p !== "reportedTime" && !(sessionFinishMode(session) === "pause" && p === "field:status"));
        if (parts.length) await this.runtime.reviewParts({ kind: "proposal", id: proposal.id, revision: proposal.baseRevision, decision: "accept", parts, requestId: randomUUID() }, "automation:247c");
        session = this.repo.session(session.id);
        // The explicit Pause action wins even if the recorder proposed a status change.
        if (sessionFinishMode(session) === "pause" && session.proposalId) {
          const remaining = this.repo.kernel.getProposal(session.proposalId);
          if (remaining.status === "pending" && session.extraction?.changes?.status) await this.runtime.reviewParts({ kind: "proposal", id: remaining.id, revision: remaining.baseRevision, decision: "reject", parts: ["field:status"], requestId: randomUUID() }, "automation:247c");
        }
        session = this.repo.session(session.id);
        this.repo.saveSession({ ...session, automation: { ...session.automation!, state: "applied", appliedAt: this.clock().toISOString() } });
        await this.runtime.archiveFinishedThreads();
      } catch (error) { this.error(original.id, error); }
    }
  }
}
