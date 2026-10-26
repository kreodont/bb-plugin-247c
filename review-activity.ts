import type { Repository } from "./repository.js";

export function reviewActivity(repo: Repository) {
  const threads = new Map<string, { threadId: string; status: "collecting" | "review_starting" | "reviewing" | "awaiting_approval" }>();
  // A read/unread flag cannot represent an outstanding decision. Derive this
  // from the saved proposal so opening a chat, reconnects and partial decisions
  // do not acknowledge it. Accepted/rejected proposals never leave stale badges.
  const pending = repo.db.prepare(`
    SELECT json_extract(s.value_json,'$.workerThreadId') AS threadId
    FROM sessions s JOIN proposals p ON p.id=json_extract(s.value_json,'$.proposalId')
    WHERE s.status='awaiting_approval' AND p.status IN ('pending','approved')
      AND json_extract(s.value_json,'$.workerThreadId') IS NOT NULL
  `).all() as { threadId: string }[];
  for (const { threadId } of pending) threads.set(threadId, { threadId, status: "awaiting_approval" });
  for (const session of repo.active()) {
    const status = session.status;
    if (session.workerThreadId && (status === "collecting" || status === "review_starting" || status === "reviewing")) {
      threads.set(session.workerThreadId, { threadId: session.workerThreadId, status });
    }
  }
  return { threads: [...threads.values()] };
}
