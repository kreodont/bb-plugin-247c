import { createHash } from "node:crypto";
import type { Repository } from "./repository.js";
import type { ReviewFailure, ReviewFailures } from "./review-failures-contracts.js";

// Derive incidents from durable sessions, including failures before a recorder
// thread exists. No write, agent call or migration is needed to recover alerts
// after a disconnect or restart. Closed tasks retain failures in their history;
// an explicit discussion on a closed task still needs a live review alert.
export function reviewFailures(repo: Repository): ReviewFailures {
  const rows = repo.db.prepare(`
    WITH RECURSIVE descendants(ancestor, id) AS (
      SELECT json_extract(value_json,'$.continuedFrom'), id FROM sessions
      WHERE json_extract(value_json,'$.continuedFrom') IS NOT NULL
      UNION
      SELECT d.ancestor, s.id FROM descendants d JOIN sessions s ON json_extract(s.value_json,'$.continuedFrom')=d.id
    )
    SELECT s.id AS sessionId, s.task_id AS taskId, t.title AS taskTitle,
      json_extract(s.value_json,'$.updatedAt') AS failedAt,
      json_extract(s.value_json,'$.round') AS round,
      COALESCE(json_extract(s.value_json,'$.error'), 'The conversation review did not finish.') AS error
    FROM sessions s JOIN tasks t ON t.id=s.task_id
    WHERE s.status='blocked' AND json_extract(s.value_json,'$.mode')='conversation'
      AND json_extract(s.value_json,'$.finishedAt') IS NOT NULL
      AND (t.status IN ('open','waiting') OR json_extract(s.value_json,'$.continuedFrom') IS NOT NULL)
      AND NOT EXISTS (
        SELECT 1 FROM descendants d JOIN sessions newer ON newer.id=d.id
        WHERE d.ancestor=s.id AND newer.task_id=s.task_id AND newer.status!='cancelled'
          AND (newer.status IN ('starting','working','collecting','review_starting','reviewing','repair_starting','completed')
            OR json_extract(newer.value_json,'$.proposalId') IS NOT NULL
            OR (newer.status='blocked' AND json_extract(newer.value_json,'$.finishedAt') IS NOT NULL))
      )
    ORDER BY failedAt DESC, s.id
  `).all() as Array<Omit<ReviewFailure, "incidentId"> & { round: number }>;
  return { total: rows.length, failures: rows.slice(0, 200).map(({ round, ...row }) => ({ ...row,
    error: row.error.slice(0, 4000),
    incidentId: createHash("sha256").update(JSON.stringify([row.sessionId, round, row.failedAt, row.error])).digest("hex"),
  })) };
}
