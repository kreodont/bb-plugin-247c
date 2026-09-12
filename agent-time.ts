import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { agentTimeStateSchema, localDay, shiftDay } from "./day-contracts.js";
import { DayPlanning } from "./day-planning.js";
import { PolicyError } from "./core/errors.js";

type Event = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["events"]["list"]>>[number];
const receiptSchema = z.object({ seq: z.number().int(), at: z.number(), turnId: z.string(),
  kind: z.enum(["start", "end", "block", "workflow"]), parent: z.string().optional(),
  interaction: z.string().optional(), blocked: z.boolean().optional(),
  agents: z.array(z.object({ key: z.string(), start: z.number(), end: z.number() })).optional(),
});
export type TimeReceipt = z.infer<typeof receiptSchema>;
const TYPES = ["turn/started", "turn/completed", "system/interaction/lifecycle", "system/permissionGrant/lifecycle", "system/userQuestion/lifecycle", "item/backgroundTask/completed"] as const;

// Retain timestamps and IDs only. Source messages, commands and credentials do
// not belong in the time journal. Native async plugin questions do not stop a provider.
export function timeReceipt(event: Event): TimeReceipt | null {
  const base = { seq: event.seq, at: event.createdAt, turnId: event.scope.kind === "turn" ? event.scope.turnId : "*" };
  if (event.type === "turn/started" && base.turnId !== "*") return { ...base, kind: "start", ...(event.data.parentToolCallId ? { parent: event.data.parentToolCallId } : {}) };
  if (event.type === "turn/completed" && base.turnId !== "*") return { ...base, kind: "end" };
  if (event.type === "system/interaction/lifecycle") {
    const i = event.data.interaction;
    if (i.origin.kind !== "provider") return null;
    return { ...base, kind: "block", interaction: i.id, blocked: i.status === "pending" || i.status === "resolving" };
  }
  if (event.type === "system/permissionGrant/lifecycle" || event.type === "system/userQuestion/lifecycle")
    return { ...base, kind: "block", interaction: event.data.interactionId, blocked: event.data.status === "pending" || event.data.status === "resolving" };
  if (event.type === "item/backgroundTask/completed") {
    const item = event.data.item;
    const agents = item.workflow?.agents.filter(a => !a.cached && ["done", "failed"].includes(a.state) && a.startedAt !== undefined && a.durationMs !== undefined && a.durationMs > 0)
      .map(a => ({ key: `${item.id}:${a.index}:${a.attempt}`, start: a.startedAt!, end: a.startedAt! + a.durationMs! }))
      .filter(a => a.end <= event.createdAt + 1000) ?? [];
    if (agents.length) return { ...base, kind: "workflow", parent: item.id, agents };
  }
  return null;
}

type Interval = { key: string; start: number; end: number };
export function measuredIntervals(raw: TimeReceipt[]): Interval[] {
  const rows = [...new Map(raw.map(r => [r.seq, receiptSchema.parse(r)])).values()].sort((a, b) => a.seq - b.seq);
  const open = new Map<string, TimeReceipt>(), intervals: Interval[] = [];
  const nestedParents = new Set(rows.filter(r => r.kind === "start" && r.parent).map(r => r.parent));
  const workflows = new Map<string, Interval>();
  for (const row of rows) {
    if (row.kind === "start") { if (!open.has(row.turnId)) open.set(row.turnId, row); }
    else if (row.kind === "end") {
      const start = open.get(row.turnId); open.delete(row.turnId);
      if (!start || row.at <= start.at) continue;
      let cursor = start.at;
      const blocked = new Set<string>();
      for (const wait of rows.filter(r => r.kind === "block" && (r.turnId === row.turnId || r.turnId === "*") && r.seq > start.seq && r.seq < row.seq)) {
        const at = Math.max(cursor, Math.min(row.at, wait.at));
        if (!blocked.size && at > cursor) intervals.push({ key: `${row.turnId}:${start.seq}`, start: cursor, end: at });
        if (wait.blocked) blocked.add(wait.interaction!); else blocked.delete(wait.interaction!);
        cursor = at;
      }
      if (!blocked.size && row.at > cursor) intervals.push({ key: `${row.turnId}:${start.seq}`, start: cursor, end: row.at });
    } else if (row.kind === "workflow" && !nestedParents.has(row.parent)) {
      for (const agent of row.agents ?? []) workflows.set(agent.key, agent);
    }
  }
  // Provider workflow receipts and embedded subagent turns can describe the
  // same agents. Prefer explicit turns when their parent call identifies them.
  return [...intervals, ...workflows.values()];
}

export function dayStart(date: string): number {
  let lo = Date.parse(`${date}T00:00:00Z`) - 18 * 3600000, hi = lo + 36 * 3600000;
  while (hi - lo > 1) { const mid = Math.floor((hi + lo) / 2); if (localDay(new Date(mid)) < date) lo = mid; else hi = mid; }
  return hi;
}
export function intervalDays(intervals: Interval[], from: string, now: number): Map<string, number> {
  const totals = new Map<string, number>(), boundaries = new Map<string, number>();
  const boundary = (date: string) => { if (!boundaries.has(date)) boundaries.set(date, dayStart(date)); return boundaries.get(date)!; };
  for (const interval of intervals) {
    let start = Math.max(interval.start, boundary(from));
    const end = Math.min(interval.end, now);
    while (start < end) {
      const date = localDay(new Date(start)), next = Math.min(end, boundary(shiftDay(date, 1)));
      if (next <= start) throw new PolicyError("Cannot split measured work across dates.");
      totals.set(date, (totals.get(date) ?? 0) + next - start); start = next;
    }
  }
  return totals;
}

export class AgentTimeRuntime {
  private flight: Promise<z.infer<typeof agentTimeStateSchema>> | null = null;
  private controller = new AbortController();
  constructor(readonly bb: BbPluginApi, readonly days: DayPlanning) {}
  get repo() { return this.days.repo; }
  state() {
    const row = this.repo.db.prepare("SELECT value_json FROM agent_time_state WHERE id=1").get() as { value_json: string } | undefined;
    return { ...(row ? agentTimeStateSchema.parse(JSON.parse(row.value_json)) : { from: null, checkedAt: null, errors: [], running: false }), running: this.flight !== null };
  }
  refresh() {
    if (this.controller.signal.aborted) return Promise.reject(new PolicyError("The plugin is reloading."));
    if (!this.flight) this.flight = this.run().catch(error => {
      if (!this.controller.signal.aborted) this.saveState({ ...this.state(), running: false, errors: [String(error)] });
      throw error;
    }).finally(() => { this.flight = null; this.repo.changed(); });
    return this.flight;
  }
  private saveState(state: z.infer<typeof agentTimeStateSchema>) {
    this.repo.db.prepare("INSERT INTO agent_time_state VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value_json=excluded.value_json").run(JSON.stringify(state));
  }
  private async discover(errors: string[]) {
    const bindings = this.repo.db.prepare("SELECT st.thread_id AS threadId,s.task_id AS taskId FROM session_threads st JOIN sessions s ON s.id=st.session_id").all() as { threadId: string; taskId: string }[];
    const direct = new Map(bindings.map(b => [b.threadId, b.taskId])), seen = new Set<string>();
    const bind = this.repo.db.prepare("INSERT OR IGNORE INTO agent_time_threads(thread_id,task_id) VALUES(?,?)");
    for (const binding of bindings) bind.run(binding.threadId, binding.taskId);
    for (let i = 0; i < bindings.length; i++) {
      const binding = bindings[i];
      if (seen.has(binding.threadId)) continue;
      if (seen.size >= 5000) throw new PolicyError("Too many task agent threads for one check.");
      seen.add(binding.threadId); bind.run(binding.threadId, binding.taskId);
      try { for (const archived of [false, true]) {
        for (let offset = 0; offset < 10000; offset += 100) {
          this.controller.signal.throwIfAborted();
          const children = await this.bb.sdk.threads.list({ parentThreadId: binding.threadId, archived, includeHidden: true, limit: 100, offset, signal: this.controller.signal });
          for (const child of children) {
            if (child.parentThreadId !== binding.threadId) continue;
            bindings.push({ threadId: child.id, taskId: direct.get(child.id) ?? binding.taskId });
          }
          if (children.length < 100) break;
          if (offset === 9900) throw new PolicyError("Could not read every child-thread page.");
        }
      } } catch (error) { if (this.controller.signal.aborted) throw error; errors.push(`${binding.threadId} children: ${String(error)}`); }
    }
  }
  private async scan(threadId: string, after: number) {
    const receipts: TimeReceipt[] = [];
    let cursor = after;
    for (let page = 0; page < 1000; page++) {
      this.controller.signal.throwIfAborted();
      const rows = await this.bb.sdk.threads.events.list({ threadId, afterSeq: String(cursor), limit: "100", order: "asc", types: [...TYPES], signal: this.controller.signal });
      if (!rows.length) {
        if (this.controller.signal.aborted) throw new PolicyError("The plugin is reloading.");
        this.repo.store.transaction(() => {
          const insert = this.repo.db.prepare("INSERT OR IGNORE INTO agent_time_events VALUES(?,?,?)");
          for (const receipt of receipts) insert.run(threadId, receipt.seq, JSON.stringify(receipt));
          this.repo.db.prepare("UPDATE agent_time_threads SET after_seq=? WHERE thread_id=?").run(cursor, threadId);
        });
        return;
      }
      const next = Math.max(...rows.map(r => r.seq));
      if (next <= cursor) throw new PolicyError("Agent event pagination did not advance.");
      for (const row of rows) if (row.threadId === threadId && row.seq > cursor) { const receipt = timeReceipt(row); if (receipt) receipts.push(receipt); }
      cursor = next;
    }
    throw new PolicyError("Too many agent event pages; saved time was preserved.");
  }
  private async run() {
    const from = this.state().from ?? this.days.today(), errors: string[] = [];
    this.saveState({ from, checkedAt: this.state().checkedAt, errors: [], running: true });
    try { await this.discover(errors); } catch (error) { if (this.controller.signal.aborted) throw error; errors.push(`Thread discovery: ${String(error)}`); }
    const threads = this.repo.db.prepare("SELECT thread_id,task_id,after_seq FROM agent_time_threads").all() as { thread_id: string; task_id: string; after_seq: number }[];
    const totals = new Map<string, { taskId: string; date: string; minutes: number }>();
    for (const thread of threads) {
      try { await this.scan(thread.thread_id, thread.after_seq); }
      catch (error) { if (this.controller.signal.aborted) throw error; errors.push(`${thread.thread_id}: ${String(error)}`); }
      const rows = this.repo.db.prepare("SELECT value_json FROM agent_time_events WHERE thread_id=? ORDER BY seq").all(thread.thread_id) as { value_json: string }[];
      const measured = intervalDays(measuredIntervals(rows.map(r => receiptSchema.parse(JSON.parse(r.value_json)))), from, this.days.clock().getTime());
      for (const [date, ms] of measured) {
        const key = `${thread.task_id}:${date}`, total = totals.get(key) ?? { taskId: thread.task_id, date, minutes: 0 };
        total.minutes += ms / 60000; totals.set(key, total);
      }
    }
    if (this.controller.signal.aborted) throw new PolicyError("The plugin is reloading.");
    this.days.reconcileActual([...totals.values()]);
    const state = { from, checkedAt: this.days.now(), errors: errors.slice(0, 100), running: false };
    this.saveState(state); return state;
  }
  async dispose() { this.controller.abort(); await this.flight?.catch(() => {}); }
}

export const DAY_REVIEW_INSTRUCTIONS = `Before finalizing source analysis, also review the saved day plan through c247_day_review, paging through all entries. Measured work has already been reconciled deterministically; do not create tasks or edit manual time. For eligible entries, use c247_day_estimate to choose a reasonable reported-time allowance for the type of work, with a short explanation of the estimate and its assumptions. The factor must be greater than 1 and at most 3. These are visibly marked estimates for the user's work report, not measured human hours or approved timesheets. Preserve manual corrections; skip unchanged estimates. Never claim the user actually spent the allowance. The plugin computes minutes and enforces the cap. Finish source analysis normally even if no entries need an estimate.`;
