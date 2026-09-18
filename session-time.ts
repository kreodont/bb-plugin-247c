import type { Extraction, Session, SessionUpdate } from "./contracts.js";
import type { Repository } from "./repository.js";
import { digest } from "./repository.js";
import { DayPlanning } from "./day-planning.js";
import { localDay } from "./day-contracts.js";
import { ConflictError, PolicyError } from "./core/errors.js";

export class SessionTime {
  constructor(readonly repo: Repository, readonly days: DayPlanning) {}
  private actor(sourceSessionId: string) { return `human:session-time:${sourceSessionId}`; }
  private applied(sourceSessionId: string) {
    return Boolean(this.repo.db.prepare("SELECT 1 FROM day_item_events WHERE actor=? AND action='session_reported' LIMIT 1").get(this.actor(sourceSessionId)));
  }
  private baseline(taskId: string, date: string) {
    const item = this.days.taskItem(taskId, date);
    // Measured runtime and unrelated planned-time edits do not invalidate review.
    return { item, fingerprint: digest([item?.reportedDate ?? date, item?.reportedMinutes ?? null, item?.reportedLocked ?? false, item?.removed ?? false]) };
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
    const { item, fingerprint } = this.baseline(session.taskId, date);
    return { sourceSessionId, date, beforeMinutes: item?.reportedMinutes ?? null, fingerprint,
      alreadyReported: this.applied(sourceSessionId) };
  }
  check(extraction: Extraction, context: Session["reportedTimeContext"], taskId: string) {
    if (!extraction.reportedTime) return;
    if (!context) throw new PolicyError("This time estimate has no saved day context. Discuss the review to refresh it.");
    if (context.alreadyReported || this.applied(context.sourceSessionId)) throw new ConflictError("Time for this session was already accepted. Leave reported time unchecked.");
    const { item, fingerprint } = this.baseline(taskId, context.date);
    if (fingerprint !== context.fingerprint || item?.removed || (item && item.reportedDate !== context.date)) {
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
