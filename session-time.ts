import { sessionUpdateSchema, type Extraction, type Session, type SessionUpdate } from "./contracts.js";
import type { Repository } from "./repository.js";
import { digest } from "./repository.js";
import { DayPlanning } from "./day-planning.js";
import { localDay } from "./day-contracts.js";
import { ConflictError, PolicyError } from "./core/errors.js";
import { proposalParts } from "./proposal-parts.js";

export class SessionTime {
  constructor(readonly repo: Repository, readonly days: DayPlanning) {}
  private actor(sourceSessionId: string) { return `human:session-time:${sourceSessionId}`; }
  private applied(sourceSessionId: string) {
    return Boolean(this.repo.db.prepare("SELECT 1 FROM day_item_events WHERE actor=? AND action='session_reported' LIMIT 1").get(this.actor(sourceSessionId)));
  }
  private baseline(taskId: string, date: string) {
    const item = this.days.taskItem(taskId, date);
    const event = item ? this.repo.db.prepare(`SELECT COALESCE(MAX(sequence),0) AS sequence FROM day_item_events WHERE item_id=? AND (
      json_extract(before_json,'$.reportedMinutes') IS NOT json_extract(after_json,'$.reportedMinutes') OR
      COALESCE(json_extract(before_json,'$.reportedLocked'),0) != COALESCE(json_extract(after_json,'$.reportedLocked'),0) OR
      COALESCE(json_extract(before_json,'$.reportedDate'),?) != json_extract(after_json,'$.reportedDate') OR
      COALESCE(json_extract(before_json,'$.removed'),0) != COALESCE(json_extract(after_json,'$.removed'),0))`)
      .get(item.id, date) as { sequence: number } : undefined;
    // Measured runtime and unrelated planned-time edits do not invalidate review.
    return { item, sequence: event?.sequence ?? 0, fingerprint: digest([item?.reportedDate ?? date, item?.reportedMinutes ?? null, item?.reportedLocked ?? false, item?.removed ?? false]) };
  }
  // The source session and every discussion that continues it share one time context.
  private chain(sourceSessionId: string): string[] {
    const ids = [sourceSessionId];
    for (let i = 0; i < ids.length && ids.length < 100; i++) {
      for (const row of this.repo.db.prepare("SELECT id FROM sessions WHERE json_extract(value_json,'$.continuedFrom')=?").all(ids[i]) as { id: string }[]) {
        if (!ids.includes(row.id)) ids.push(row.id);
      }
    }
    return ids;
  }
  // Reported time entered on the user's instruction from the session's own conversation
  // already covers that session. Estimating the same work again would count it twice:
  // the user asked for 3 hours in the chat, and the review then proposed those 3 hours again.
  private recordedInConversation(sourceSessionId: string, taskId: string, date: string) {
    const item = this.days.taskItem(taskId, date);
    if (!item) return false;
    const ids = this.chain(sourceSessionId);
    const threads = this.repo.db.prepare(`SELECT thread_id FROM session_threads WHERE session_id IN (${ids.map(() => "?").join(",")})`).all(...ids) as { thread_id: string }[];
    if (!threads.length) return false;
    const actors = threads.map(t => `bb-thread:${t.thread_id}`);
    return Boolean(this.repo.db.prepare(`SELECT 1 FROM day_item_events WHERE item_id=? AND actor IN (${actors.map(() => "?").join(",")})
      AND json_extract(after_json,'$.reportedMinutes') IS NOT NULL
      AND (before_json IS NULL OR json_extract(before_json,'$.reportedMinutes') IS NOT json_extract(after_json,'$.reportedMinutes')) LIMIT 1`)
      .get(item.id, ...actors));
  }
  capture(session: Session): NonNullable<Session["reportedTimeContext"]> {
    let root = session;
    const seen = new Set<string>();
    while (root.continuedFrom) {
      if (seen.has(root.id)) throw new PolicyError("Invalid session discussion ancestry.");
      seen.add(root.id); root = this.repo.session(root.continuedFrom);
    }
    const sourceSessionId = root.reportedTimeContext?.sourceSessionId ?? root.id;
    const date = root.reportedTimeContext?.date ?? localDay(new Date(root.finishedAt ?? session.finishedAt ?? this.days.now()), this.days.timeZone);
    const { item, fingerprint, sequence } = this.baseline(session.taskId, date);
    return { sourceSessionId, date, beforeMinutes: item?.reportedMinutes ?? null, fingerprint,
      reportedEventSequence: sequence, alreadyReported: this.applied(sourceSessionId) };
  }
  private omissionReason(context: NonNullable<Session["reportedTimeContext"]>, taskId: string): NonNullable<SessionUpdate["omittedReportedTime"]>["reason"] | null {
    if (context.alreadyReported || this.applied(context.sourceSessionId)) return "already_reported";
    if (this.recordedInConversation(context.sourceSessionId, taskId, context.date)) return "recorded_in_conversation";
    const { item, fingerprint, sequence } = this.baseline(taskId, context.date);
    return fingerprint !== context.fingerprint || item?.removed || (item && item.reportedDate !== context.date) ||
      (context.reportedEventSequence !== undefined && context.reportedEventSequence !== sequence) ? "reported_changed" : null;
  }
  // Retire only stale time additions. Task changes still need human acceptance;
  // the original estimate and context remain available in review history.
  reconcile(taskId?: string) {
    const count = this.repo.store.transaction(() => {
      const rows = this.repo.db.prepare(`SELECT u.value_json,p.task_id FROM session_updates u JOIN proposals p ON p.id=u.proposal_id
        WHERE p.status IN ('pending','approved') AND json_extract(u.value_json,'$.extraction.reportedTime') IS NOT NULL
        ${taskId ? "AND p.task_id=?" : ""}`).all(...(taskId ? [taskId] : [])) as { value_json: string; task_id: string }[];
      let changed = 0;
      for (const row of rows) {
        const update = sessionUpdateSchema.parse(JSON.parse(row.value_json));
        if (!update.extraction.reportedTime || !update.reportedTimeContext) continue;
        const reason = this.omissionReason(update.reportedTimeContext, row.task_id);
        if (!reason) continue;
        update.omittedReportedTime = { estimate: update.extraction.reportedTime, reason, omittedAt: this.days.now() };
        update.extraction = { ...update.extraction, reportedTime: null };
        this.repo.db.prepare("UPDATE session_updates SET value_json=? WHERE proposal_id=?").run(JSON.stringify(update), update.proposalId);
        this.repo.sessionEvent(update.sessionId, "reported-time-omitted", "Outdated reported-time estimate automatically excluded; the current day total is preserved.",
          { proposalId: update.proposalId, reason, date: update.reportedTimeContext.date, estimate: update.omittedReportedTime.estimate });
        if (!proposalParts({}, update.extraction).length) {
          this.repo.kernel.rejectProposal(update.proposalId);
          const session = this.repo.session(update.sessionId);
          if (session.proposalId === update.proposalId && session.status === "awaiting_approval") this.repo.saveSession({ ...session,
            status: session.acceptedPartProposalIds?.length ? "applied" : "completed" });
        }
        changed++;
      }
      return changed;
    });
    if (count) this.repo.changed();
    return count;
  }
  isOmittedOnly(proposalId: string) {
    const row = this.repo.db.prepare("SELECT value_json FROM session_updates WHERE proposal_id=?").get(proposalId) as { value_json: string } | undefined;
    if (!row) return false;
    const update = sessionUpdateSchema.parse(JSON.parse(row.value_json));
    return !!update.omittedReportedTime && !proposalParts({}, update.extraction).length;
  }
  check(extraction: Extraction, context: Session["reportedTimeContext"], taskId: string) {
    if (!extraction.reportedTime) return;
    if (!context) throw new PolicyError("This time estimate has no saved day context. Discuss the review to refresh it.");
    const reason = this.omissionReason(context, taskId);
    if (reason === "already_reported") throw new ConflictError("Time for this session was already accepted. Leave reported time unchecked.");
    if (reason === "recorded_in_conversation") throw new ConflictError("Reported time for this work was already entered from the session's conversation. Leave reported time unchecked.");
    if (reason) {
      throw new ConflictError("Reported time changed after this estimate. Leave reported time unchecked or discuss the review to prepare a fresh estimate.");
    }
  }
  apply(update: SessionUpdate, taskId: string, proposalId: string) {
    const estimate = update.extraction.reportedTime;
    if (!estimate) return;
    this.check(update.extraction, update.reportedTimeContext, taskId);
    this.days.applySessionReport(taskId, update.reportedTimeContext!.date, estimate.minutes,
      this.actor(update.reportedTimeContext!.sourceSessionId), proposalId);
  }
}
