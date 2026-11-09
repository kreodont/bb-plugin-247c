import type { Session, SyncCandidate } from "./contracts.js";

export function canFinishForSource(session: Session, candidate: SyncCandidate) {
  return candidate.changes.status?.value === "done"
    && session.mode === "conversation" && session.status === "working" && !!session.workerThreadId && !session.finishedAt
    && !session.continuedFrom && !session.discussionProposalId && !session.closedTaskConversation;
}

export class SourceSessionBusy extends Error {
  constructor() { super("The work chat is busy or waiting for input. Its session and this update are unchanged. Try again when the chat is idle."); }
}
