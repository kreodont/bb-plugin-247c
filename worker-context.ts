import type { Session } from "./contracts.js";
import type { Repository } from "./repository.js";

export function acceptedWorkerContext(repo: Repository, taskId: string): NonNullable<Session["workerContext"]> {
  return { version: 1, taskRevision: repo.kernel.getTask(taskId).revision, sourceRevision: repo.sourceSelection(taskId, []).sourceRevision };
}

export function sameWorkerContext(left: Session["workerContext"], right: NonNullable<Session["workerContext"]>) {
  return left?.version === right.version && left.taskRevision === right.taskRevision && left.sourceRevision === right.sourceRevision;
}
