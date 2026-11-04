import type { Session } from "./contracts.js";
import type { ProposalEvidence } from "./core/types.js";

export const FINISH_PENDING_REF = "session:finish:pending";
export function sessionFinishMode(session: Pick<Session, "finishMode" | "automation">) {
  return session.finishMode ?? (session.automation?.outcome === "paused" ? "pause" : undefined);
}
export function finishDecisionEvidence(session: Session): ProposalEvidence[] {
  if (sessionFinishMode(session) !== "resolve") return [];
  return [{ ref: FINISH_PENDING_REF, kind: "decision", source: `session-finish:${session.id}`, sourceRef: null,
    text: "This session was ended with task resolution required: completed work is closed; otherwise the task remains pending. This action does not prove completion or that an external reply was requested." }];
}
export function finishModeInstructions(session: Session): string {
  const mode = sessionFinishMode(session);
  if (mode === "pause") return "PAUSE SESSION: Close and record this work session WITHOUT deciding whether the task is done or waiting. Omit changes.status entirely; the task stays OPEN. Save useful results and estimate only work performed in this session, with reported time still awaiting human confirmation. Do not ask the user to choose a status. The already scheduled tomorrow plan is separate from this session's reported date.";
  if (mode === "resolve") return `FINISH SESSION: You, the recorder, MUST choose exactly one outcome in changes.status: done if the whole request is completed, otherwise waiting (pending). Explain your choice in rationale. Do not ask the user to make this choice, return open/archived, or omit status. Preserve actual remaining work and uncertainty: pending need not imply someone was contacted, so never invent an external request or a reply. Cite real conversation results for done. For waiting, cite the remaining work, or use the host decision ref ${FINISH_PENDING_REF} when the dialogue provides no sufficient result evidence. This ref supports ONLY status=waiting, never completion, other fields or time. These finish-mode rules override ordinary instructions to preserve or omit status; clicking Finish itself is not proof of task completion. Reported time is independent of this outcome and still awaits the user.`;
  return "";
}
