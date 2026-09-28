import type { Repository } from "./repository.js";
import { dayItemSchema, type DayItem, type ReportedChange } from "./day-contracts.js";

type EventRow = { at: string; actor: string; action: string; before_json: string | null; after_json: string };
const LIMIT = 10;
type Origin = Pick<ReportedChange, "source" | "label" | "threadId" | "sessionId" | "proposalId" | "reason">;

/**
 * Explain where each reported value came from.
 *
 * The event journal always recorded the actor, but the panel showed an accepted
 * session estimate as "manual", exactly like a number the user typed. A 5-minute
 * entry then looked like an unexplained quick note, although its reason and
 * conversation were stored. This joins the journal with the accepted session
 * estimate so every reported change names its source, reason and conversation.
 */
export function reportedChanges(repo: Repository, itemId: string): ReportedChange[] {
  const rows = repo.db.prepare(`SELECT at,actor,action,before_json,after_json FROM day_item_events WHERE item_id=?
    AND (before_json IS NULL OR json_extract(before_json,'$.reportedMinutes') IS NOT json_extract(after_json,'$.reportedMinutes'))
    ORDER BY sequence DESC LIMIT ?`).all(itemId, LIMIT) as EventRow[];
  return rows.reverse().flatMap(row => {
    const before = row.before_json ? dayItemSchema.parse(JSON.parse(row.before_json)) : null;
    const after = dayItemSchema.parse(JSON.parse(row.after_json));
    const from = before?.reportedMinutes ?? null, to = after.reportedMinutes;
    if (!before && to === null) return [];
    return [{ at: row.at, from, to, ...describe(repo, row.actor, row.action, itemId, after) }];
  });
}

/**
 * The changes that make up the current value: the latest absolute change plus the
 * accepted session estimates added after it. Session review is the only source that
 * adds to an existing value; every other source replaces it.
 */
export function reportedComposition(changes: ReportedChange[]): ReportedChange[] {
  const result: ReportedChange[] = [];
  for (const change of [...changes].reverse()) {
    result.unshift(change);
    if (change.source !== "session_review" || change.from === null) break;
  }
  return result;
}

function describe(repo: Repository, actor: string, action: string, itemId: string, after: DayItem): Origin {
  const none = { threadId: null, sessionId: null, proposalId: null, reason: null };
  if (actor === "human:panel") return { ...none, source: "panel", label: "Entered in the 247C panel" };
  if (actor.startsWith("bb-thread:")) return { ...none, source: "conversation", label: "Entered by an agent on request in a conversation", threadId: actor.slice("bb-thread:".length) };
  if (actor.startsWith("calendar:")) return { ...none, source: "calendar", label: action === "meeting_reported" ? "Meeting length after the meeting ended" : "Calendar meeting length" };
  if (actor.startsWith("agent-time:")) return { ...none, source: "ai_estimate", label: "AI estimate awaiting confirmation", reason: after.reportedEstimate?.reason ?? null };
  if (actor.startsWith("human:session-time:")) return sessionReview(repo, actor.slice("human:session-time:".length), itemId);
  return { ...none, source: "other", label: actor };
}

function sessionReview(repo: Repository, sessionId: string, itemId: string): Origin {
  const base = { source: "session_review" as const, label: "Session time estimate accepted in review", sessionId, threadId: null, proposalId: null, reason: null };
  const event = repo.db.prepare(`SELECT payload_json FROM session_events WHERE session_id=? AND kind='reported-time-applied'
    AND json_extract(payload_json,'$.itemId')=? ORDER BY created_at DESC LIMIT 1`).get(sessionId, itemId) as { payload_json: string } | undefined;
  const proposalId = event ? (JSON.parse(event.payload_json) as { proposalId?: string }).proposalId ?? null : null;
  const update = proposalId ? repo.db.prepare("SELECT value_json FROM session_updates WHERE proposal_id=?").get(proposalId) as { value_json: string } | undefined : undefined;
  const reason = update ? (JSON.parse(update.value_json) as { extraction?: { reportedTime?: { reason?: string } | null } }).extraction?.reportedTime?.reason ?? null : null;
  let threadId: string | null = null;
  try { threadId = repo.session(sessionId).workerThreadId; } catch { /* a deleted session keeps its journal entry */ }
  return { ...base, proposalId, reason, threadId };
}
