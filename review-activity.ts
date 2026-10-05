import type { Repository } from "./repository.js";

export function reviewActivity(repo: Repository) {
  return { threads: repo.active().flatMap(session => {
    const status = session.status;
    return session.workerThreadId && (status === "collecting" || status === "review_starting" || status === "reviewing")
      ? [{ threadId: session.workerThreadId, status }] : [];
  }) };
}
