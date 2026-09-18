import { randomUUID } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { DayPlanning } from "./day-planning.js";
import { digest } from "./repository.js";
import { ConflictError, PolicyError } from "./core/errors.js";
import { localDay, shiftDay, weekStart } from "./day-contracts.js";
import type { LocalSettings } from "./settings.js";
import { timeReviewRpcContract, type TimeContext, type TimeEvidence, type TimeProposal } from "./time-review-contracts.js";

type JsonRow = { value_json: string };
export class TimeReview {
  constructor(readonly bb: BbPluginApi, readonly days: DayPlanning, readonly settings: () => Pick<LocalSettings, "weeklyReportedTargetMinutes" | "weeklyReportedOverrides" | "dailyTimeReviewHour">) {}
  get repo() { return this.days.repo; }
  private eligible(taskId: string, date: string) {
    const item = this.days.taskItem(taskId, date);
    return !item || !item.removed && !item.reportedLocked && item.reportedMinutes === null && item.reportedDate === date;
  }
  async prepare(input: z.infer<typeof timeReviewRpcContract.timeReviewPrepare.input>): Promise<TimeContext> {
    if (input.date > this.days.today()) throw new PolicyError("Future work cannot be reported.");
    const all = this.repo.list(true).tasks.filter(task => this.eligible(task.id, input.date)).sort((a, b) => a.id.localeCompare(b.id));
    const selected = all.slice(input.offset, input.offset + 10), warnings: string[] = [];
    const evidence: TimeEvidence[] = input.external.map(row => {
      if (!row.id.startsWith("external:") || localDay(new Date(row.at), this.days.timeZone) !== input.date) throw new PolicyError("Collector evidence must have an external ID and belong to the requested date.");
      return row;
    });
    const tasks: TimeContext["tasks"] = [];
    for (const task of selected) {
      const item = this.days.taskItem(task.id, input.date), dossier = this.repo.detail(task.id);
      tasks.push({ taskId: task.id, title: task.title, itemId: item?.id ?? null, revision: item?.revision ?? null, summary: dossier.projection.summary, sources: dossier.sourceLinks });
      for (const fact of dossier.facts) if (localDay(new Date(fact.occurredAt), this.days.timeZone) === input.date) evidence.push({ id: `fact:${fact.id}`, taskId: task.id, at: fact.occurredAt, source: "Accepted dossier fact (record date alone is not proof of work)", url: null, text: fact.text.slice(0, 16000) });
      const threads = this.repo.db.prepare("SELECT t.thread_id FROM session_threads t JOIN sessions s ON s.id=t.session_id WHERE s.task_id=? AND t.role='worker'").all(task.id) as { thread_id: string }[];
      for (const { thread_id: threadId } of threads) {
        try {
          let cursor: { anchorId: string; anchorSeq: number } | null = null;
          const seen = new Set<string>();
          for (;;) {
            const page = await this.bb.sdk.threads.timeline({ threadId, segmentLimit: "100", summaryOnly: "false", includeNestedRows: "false", ...(cursor ? { beforeAnchorId: cursor.anchorId, beforeAnchorSeq: String(cursor.anchorSeq) } : {}) });
            for (const row of page.rows) {
              if (row.kind !== "conversation" || !row.text || !["user", "assistant"].includes(row.role) || localDay(new Date(row.createdAt), this.days.timeZone) !== input.date) continue;
              evidence.push({ id: `thread:${threadId}:${row.id}`, taskId: task.id, at: new Date(row.createdAt).toISOString(), source: `BB ${row.role} message`, url: null, text: row.text.slice(0, 16000) });
            }
            if (!page.timelinePage.hasOlderRows || page.rows.length && page.rows.every(row => localDay(new Date(row.createdAt), this.days.timeZone) < input.date)) break;
            const next = page.timelinePage.olderCursor;
            if (!next || seen.has(next.anchorId)) { warnings.push(`Incomplete thread history: ${threadId}`); break; }
            seen.add(next.anchorId); cursor = next;
          }
        } catch { warnings.push(`Thread history unavailable: ${threadId}`); }
      }
    }
    const unique = [...new Map(evidence.map(row => [row.id, row])).values()].sort((a, b) => a.id.localeCompare(b.id));
    const value = { date: input.date, tasks, evidence: unique, warnings, nextOffset: input.offset + selected.length < all.length ? input.offset + selected.length : null };
    if (Buffer.byteLength(JSON.stringify(value)) > 4 * 1024 * 1024) throw new PolicyError("Time context exceeds 4 MiB. Reduce the collector evidence batch.");
    const context = { id: digest(value), ...value };
    this.repo.db.prepare("INSERT OR IGNORE INTO time_review_contexts VALUES (?,?)").run(context.id, JSON.stringify(context));
    return context;
  }
  private read(id: string): TimeProposal {
    const row = this.repo.db.prepare("SELECT value_json FROM time_proposals WHERE id=?").get(id) as JsonRow | undefined;
    if (!row) throw new PolicyError("Time proposal not found.");
    return JSON.parse(row.value_json);
  }
  private write(value: TimeProposal) {
    this.repo.db.prepare("INSERT INTO time_proposals VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,value_json=excluded.value_json")
      .run(value.id, value.taskId, value.date, value.status, value.fingerprint, JSON.stringify(value));
    return value;
  }
  private blocked(value: TimeProposal) {
    const item = this.days.taskItem(value.taskId, value.date);
    return !this.eligible(value.taskId, value.date) || (item?.id ?? null) !== value.itemId || (item?.revision ?? null) !== value.revision ? "The day entry changed. Keep the manual entry, reject this proposal, or run a fresh review." : null;
  }
  submit(input: z.infer<typeof timeReviewRpcContract.timeReviewSubmit.input>) {
    const result = this.repo.request(input.requestId, { kind: "time.submit", input }, () => {
      const row = this.repo.db.prepare("SELECT value_json FROM time_review_contexts WHERE id=?").get(input.contextId) as JsonRow | undefined;
      if (!row) throw new PolicyError("Prepare the evidence context before submitting time proposals.");
      const context: TimeContext = JSON.parse(row.value_json), used = new Set<string>();
      return { proposals: input.suggestions.map(suggestion => {
        const task = context.tasks.find(task => task.taskId === suggestion.taskId);
        if (!task || used.has(task.taskId)) throw new PolicyError("Unknown or repeated task in time review.");
        used.add(task.taskId);
        const evidence = [...new Set(suggestion.evidenceRefs)].map(ref => {
          const row = context.evidence.find(row => row.id === ref && (!row.taskId || row.taskId === task.taskId));
          if (!row) throw new PolicyError("A time proposal cites evidence outside its task and date.");
          return row;
        });
        const allocations = (this.repo.db.prepare("SELECT value_json FROM time_proposals WHERE date=? AND task_id<>? AND status IN ('pending','accepted')").all(context.date, task.taskId) as JsonRow[]).map(row => JSON.parse(row.value_json) as TimeProposal);
        if (allocations.some(other => other.evidence.some(row => evidence.some(current => current.id === row.id)))) throw new PolicyError("This evidence is already allocated to another task on this date. Review that allocation before counting the work again.");
        if (suggestion.minutes === null && !suggestion.question) throw new PolicyError("Ask for the duration when an estimate is unavailable.");
        // The same work cannot reappear after acceptance/rejection just because a model changed its estimate.
        const fingerprint = digest({ taskId: task.taskId, date: context.date, evidence: evidence.slice().sort((a,b) => a.id.localeCompare(b.id)) });
        const prior = this.repo.db.prepare("SELECT value_json FROM time_proposals WHERE fingerprint=?").get(fingerprint) as JsonRow | undefined;
        if (prior) return JSON.parse(prior.value_json) as TimeProposal;
        const proposal: TimeProposal = { ...suggestion, id: randomUUID(), title: task.title, date: context.date, itemId: task.itemId, revision: task.revision, fingerprint, evidence, status: "pending", createdAt: this.days.now(), resolvedAt: null, blockedReason: null };
        if (this.blocked(proposal)) throw new ConflictError("The day entry changed after evidence collection. Refresh the time review.");
        const pending = this.repo.db.prepare("SELECT value_json FROM time_proposals WHERE task_id=? AND date=? AND status='pending'").get(task.taskId, context.date) as JsonRow | undefined;
        if (pending) this.write({ ...JSON.parse(pending.value_json), status: "superseded", resolvedAt: this.days.now() });
        return this.write(proposal);
      }) };
    });
    this.repo.changed(); return result;
  }
  decide(input: z.infer<typeof timeReviewRpcContract.timeReviewDecide.input>) {
    const result = this.repo.request(input.requestId, { kind: "time.decide", input }, () => {
      const value = this.read(input.id);
      if (value.status !== "pending") throw new ConflictError("This time proposal has already been reviewed or replaced.");
      if (input.decision === "accept") {
        const blocked = this.blocked(value); if (blocked) throw new ConflictError(blocked);
        const minutes = input.minutes === undefined ? value.minutes : input.minutes;
        if (minutes === null) throw new PolicyError("Enter the time before confirming.");
        if (value.itemId) this.days.edit({ requestId: randomUUID(), id: value.itemId, revision: value.revision!, reportedMinutes: minutes }, "human:time-review");
        else this.days.add({ requestId: randomUUID(), taskId: value.taskId, date: value.date, reportedMinutes: minutes }, "human:time-review");
        value.minutes = minutes;
      }
      return this.write({ ...value, status: input.decision === "accept" ? "accepted" : "rejected", resolvedAt: this.days.now() });
    });
    this.repo.changed(); return result;
  }
  view(date = this.days.today(), week = false) {
    const from = weekStart(date), through = shiftDay(from, 6), settings = this.settings();
    const proposals = (this.repo.db.prepare("SELECT value_json FROM time_proposals WHERE status='pending' AND date>=? AND date<=? ORDER BY date,task_id").all(week ? from : date, week ? through : date) as JsonRow[]).map(row => { const value: TimeProposal = JSON.parse(row.value_json); return { ...value, blockedReason: this.blocked(value) }; });
    const report = this.days.report({ date, period: "week" });
    const target = (JSON.parse(settings.weeklyReportedOverrides) as Record<string, number>)[from] ?? settings.weeklyReportedTargetMinutes;
    const day = this.days.day(date);
    const revision = digest({ entries: day.items.map(item => [item.id, item.revision]), pending: (this.repo.db.prepare("SELECT id FROM time_proposals WHERE date=? AND status='pending' ORDER BY id").all(date)) });
    const review = this.repo.db.prepare("SELECT reviewed_at,revision FROM time_daily_reviews WHERE date=?").get(date) as { reviewed_at: string; revision: string } | undefined;
    const reviewedAt = review?.revision === revision ? review.reviewed_at : null;
    const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: this.days.timeZone, hour: "numeric", hourCycle: "h23" }).format(this.days.clock()));
    return { date, proposals, weekly: { from, through, targetMinutes: target, reportedMinutes: report.totals.reportedMinutes, remainingMinutes: Math.max(0, target - report.totals.reportedMinutes) }, due: !reviewedAt && (date < this.days.today() || date === this.days.today() && hour >= settings.dailyTimeReviewHour), reviewedAt, revision, missingReported: day.totals.missingReported, reviewHour: settings.dailyTimeReviewHour };
  }
  complete(input: z.infer<typeof timeReviewRpcContract.timeReviewComplete.input>) {
    const result = this.repo.request(input.requestId, { kind: "time.complete", input }, () => {
      const view = this.view(input.date);
      if (view.revision !== input.revision) throw new ConflictError("The day changed. Review the updated entries first.");
      if (view.proposals.length) throw new PolicyError("Confirm or reject the pending time proposals first.");
      const reviewedAt = this.days.now();
      this.repo.db.prepare("INSERT INTO time_daily_reviews VALUES (?,?,?) ON CONFLICT(date) DO UPDATE SET reviewed_at=excluded.reviewed_at,revision=excluded.revision").run(input.date, reviewedAt, view.revision);
      return { reviewedAt };
    });
    this.repo.changed(); return result;
  }
}
