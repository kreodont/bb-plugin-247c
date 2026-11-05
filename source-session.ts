import type { Session, SyncCandidate } from "./contracts.js";

export function canFinishForSource(session: Session, candidate: SyncCandidate) {
  return session.mode === "conversation" && session.status === "working" && !session.finishedAt
    && !session.continuedFrom && !session.discussionProposalId && !session.closedTaskConversation
    && ["done", "waiting"].includes(candidate.changes.status?.value ?? "");
}

export class SourceSessionBusy extends Error {
  constructor() { super("The work chat is busy or waiting for input. Its session and this update are unchanged."); }
}
