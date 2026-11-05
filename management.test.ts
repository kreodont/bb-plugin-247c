import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { fixture } from "./test-support.js";
import { sessionSchema, type Extraction, type Session, type Transcript } from "./contracts.js";
import { continueTranscript, validateExtraction } from "./conversation.js";
import { SessionRuntime } from "./runtime.js";

const hosts: Awaited<ReturnType<typeof fixture>>[] = [];
type Fixture = Awaited<ReturnType<typeof fixture>>;
afterEach(async () => { for (const f of hosts.splice(0)) await f.harness.lifecycle.dispose(); });
const decision = "Ок, ответил Мэри. Пока можно убавить срочность и важность задачи, но закрывать ее не стоит, возможно будут еще вопросы";
const rename = "Назови задачу «Вопросы Мэри по ERP».";

async function setup() {
  const f = await fixture(); hosts.push(f);
  await f.harness.behavior.setSettings({ maximumRepairs: 0 });
  const created = await f.create();
  f.repo.classify({ taskId: created.id, revision: 0, urgent: true, important: true });
  const task = f.repo.kernel.getTask(created.id);
  const session = sessionSchema.parse(await f.harness.behavior.callRpc("start", { ...f.startInput(task.id, task.revision), criteria: [] }));
  f.message(session.workerThreadId!, "user", decision);
  return { f, task, session };
}
function fact(transcript: Transcript, text: string): Extraction["facts"][number] {
  const message = transcript.messages.find((m) => m.text === text)!;
  return { kind: "user_instruction", text, citations: [{ messageRef: message.ref, quote: text }] };
}
async function review(f: Fixture, session: Session, draft?: (transcript: Transcript) => Extraction, legacy = false) {
  if (legacy) {
    // Historical reviews can include archive decisions without a Finish outcome.
    const runtime = new SessionRuntime(f.bb, f.repo, async () => ({ codexReviewer: "", claudeReviewer: "", maximumRepairs: 0, sessionMinutes: 20 }));
    await runtime.finish(session.id);
  } else await f.harness.behavior.callRpc(["done", "archived"].includes(f.repo.kernel.getTask(session.taskId).status) ? "finish" : "pauseSession", { sessionId: session.id });
  const transcript = f.repo.transcript(session.id)!;
  const extraction: Extraction = draft?.(transcript) ?? { rationale: "По просьбе пользователя снизить оба приоритета, сохранив задачу открытой.", facts: [fact(transcript, decision)], changes: { urgent: { value: false, evidenceRefs: ["fact:0"] }, important: { value: false, evidenceRefs: ["fact:0"] } }, knowledge: [] };
  await f.idle(f.repo.session(session.id).reviewerThreadId!, extraction);
  return f.repo.session(session.id);
}
const canonical = (f: Fixture, taskId: string) => f.repo.kernel.getDossier(taskId);

describe("Task management proposals", () => {
  it("carries the real priority decision into an atomic, reversible patch and keeps the task open", async () => {
    const { f, task, session } = await setup();
    f.message(session.workerThreadId!, "user", rename);
    const before = canonical(f, task.id);
    const pending = await review(f, session, (transcript) => ({ rationale: "Снизить срочность и важность и обновить название.", facts: [fact(transcript, decision), fact(transcript, rename)], changes: { urgent: { value: false, evidenceRefs: ["fact:0"] }, important: { value: false, evidenceRefs: ["fact:0"] }, title: { value: "Вопросы Мэри по ERP", evidenceRefs: ["fact:1"] } }, knowledge: [] }));
    expect(pending.status).toBe("awaiting_approval");
    expect(canonical(f, task.id)).toEqual(before);
    const prompt = JSON.stringify(f.harness.inspection.sdk.callsTo("threads.spawn").at(-1));
    expect(prompt).toContain('\\"planning\\":{\\"urgent\\":true,\\"important\\":true');
    expect(prompt).toContain("mentioning a change in a summary does NOT change its field");
    await f.harness.behavior.callRpc("accept", { proposalId: pending.proposalId, revision: task.revision });
    const applied = canonical(f, task.id);
    expect(applied.task).toMatchObject({ title: "Вопросы Мэри по ERP", status: "open", revision: task.revision + 1 });
    expect(applied.planning).toEqual({ urgent: false, important: false, revision: 2 });
    expect(f.repo.kernel.getApplicationReceipt(pending.proposalId!).fields).toEqual(expect.arrayContaining(["title", "urgent", "important"]));
    await f.harness.behavior.callRpc("accept", { proposalId: pending.proposalId, revision: task.revision });
    expect(canonical(f, task.id)).toEqual(applied);
    const undo = f.repo.kernel.proposeRevert(pending.proposalId!);
    expect(canonical(f, task.id)).toEqual(applied);
    await f.harness.behavior.callRpc("accept", { proposalId: undo.id, revision: applied.task.revision });
    expect(canonical(f, task.id).task).toMatchObject({ title: task.title, status: "open" });
    expect(canonical(f, task.id).planning).toEqual({ urgent: true, important: true, revision: 3 });
  });

  it("rolls back every field, evidence, approval and receipt when the priority write fails", async () => {
    const { f, task, session } = await setup();
    const before = canonical(f, task.id);
    const pending = await review(f, session);
    f.repo.db.exec("CREATE TRIGGER priority_failure BEFORE UPDATE ON planning BEGIN SELECT RAISE(ABORT, 'priority unavailable'); END");
    await expect(f.harness.behavior.callRpc("accept", { proposalId: pending.proposalId, revision: task.revision })).rejects.toThrow(/priority unavailable/);
    expect(canonical(f, task.id)).toEqual(before);
    expect(f.repo.kernel.getProposal(pending.proposalId!).status).toBe("pending");
    expect(f.repo.db.prepare("SELECT count(*) n FROM application_receipts").get()).toEqual({ n: 0 });
    expect(f.repo.db.prepare("SELECT count(*) n FROM proposal_approvals").get()).toEqual({ n: 0 });
  });

  it("rejects stale approval and stale reversal after manual priority edits", async () => {
    const { f, task, session } = await setup();
    const pending = await review(f, session);
    f.repo.classify({ taskId: task.id, revision: 1, urgent: false, important: true });
    const manual = canonical(f, task.id);
    await expect(f.harness.behavior.callRpc("accept", { proposalId: pending.proposalId, revision: manual.task.revision })).rejects.toThrow(/old dossier revision/);
    expect(canonical(f, task.id)).toEqual(manual);
    const retry = sessionSchema.parse(await f.harness.behavior.callRpc("retry", { sessionId: session.id }));
    const transcript = f.repo.transcript(session.id)!;
    await f.idle(retry.reviewerThreadId!, { rationale: "Снизить важность", facts: [fact(transcript, decision)], changes: { important: { value: false, evidenceRefs: ["fact:0"] } }, knowledge: [] });
    const next = f.repo.session(session.id);
    await f.harness.behavior.callRpc("accept", { proposalId: next.proposalId, revision: manual.task.revision });
    f.repo.classify({ taskId: task.id, revision: f.repo.planning(task.id).revision, urgent: false, important: null });
    expect(() => f.repo.kernel.proposeRevert(next.proposalId!)).toThrow(/changed after/);
  });

  it("allows manual priority edits during chat, but rejects a changed snapshot during recording without model repair", async () => {
    const { f, task, session } = await setup();
    f.repo.classify({ taskId: task.id, revision: 1, urgent: true, important: null });
    const runtime = new SessionRuntime(f.bb, f.repo, async () => ({ codexReviewer: "", claudeReviewer: "", maximumRepairs: 0, sessionMinutes: 20 }));
    expect(runtime.dispatch(session.workerThreadId!).action).toBe("proceed");
    await f.harness.behavior.callRpc("finish", { sessionId: session.id });
    const reviewing = f.repo.session(session.id);
    expect(reviewing.baseRevision).toBe(task.revision + 1);
    f.repo.classify({ taskId: task.id, revision: 2, urgent: false, important: null });
    await f.idle(reviewing.reviewerThreadId!, {});
    expect(f.repo.session(session.id).status).toBe("blocked");
    expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(2);
    expect(f.repo.planning(task.id)).toMatchObject({ urgent: false, important: null });
  });

  it.each(["assistant", "context"] as const)("does not treat %s metadata suggestions as user decisions", (role) => {
    const transcript: Transcript = { threadId: "thread", capturedAt: "2026-09-10", warnings: [], messages: [{ ref: "message:1", role, sequence: 1, text: "Снизить срочность." }] };
    const draft: Extraction = { rationale: "Priority", facts: [{ kind: "decision", text: "Снизить срочность.", citations: [{ messageRef: "message:1", quote: "Снизить срочность." }] }], changes: { urgent: { value: false, evidenceRefs: ["fact:0"] } }, knowledge: [] };
    expect(() => validateExtraction(draft, transcript)).toThrow(/user decision/);
    draft.changes = { title: { value: "Новое имя", evidenceRefs: ["fact:0"] } };
    expect(() => validateExtraction(draft, transcript)).toThrow(/user decision/);
    draft.changes = { status: { value: "archived", evidenceRefs: ["fact:0"] } };
    expect(() => validateExtraction(draft, transcript)).toThrow();
  });
});

describe("Discussing a finished review", () => {
  it("preserves the old draft until the replacement is valid and cites each original thread correctly", async () => {
    const { f, task, session } = await setup();
    const old = await review(f, session);
    const frozen = f.repo.transcript(session.id)!;
    const before = canonical(f, task.id);
    const input = { ...f.startInput(task.id, task.revision), criteria: [], continueSessionId: session.id };
    input.request.input[0].text = "Хочу discuss the review. Срочность снизь, важность оставь высокой.";
    const discussion = sessionSchema.parse(await f.harness.behavior.callRpc("start", input));
    const spawnCount = f.harness.inspection.sdk.callsTo("threads.spawn").length;
    expect(await f.harness.behavior.callRpc("start", input)).toMatchObject({ id: discussion.id });
    expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(spawnCount);
    expect(discussion).toMatchObject({ continuedFrom: session.id, discussionProposalId: old.proposalId });
    const packet = JSON.stringify(f.harness.inspection.sdk.callsTo("threads.spawn").at(-1));
    expect(packet).toContain(decision);
    expect(packet).toContain(old.proposalId!);
    expect(f.repo.kernel.getProposal(old.proposalId!).status).toBe("pending");
    await expect(f.harness.behavior.callRpc("accept", { proposalId: old.proposalId, revision: task.revision })).rejects.toThrow(/discussing/);
    await f.reload();
    expect(f.repo.session(discussion.id).status).toBe("working");
    const replacement = await review(f, discussion, (transcript) => ({ rationale: "Срочность снять, важность оставить по уточнению пользователя.", facts: [fact(transcript, decision), fact(transcript, input.request.input[0].text)], changes: { urgent: { value: false, evidenceRefs: ["fact:0", "fact:1"] } }, knowledge: [] }));
    expect(replacement.status).toBe("awaiting_approval");
    expect(f.repo.kernel.getProposal(old.proposalId!).status).toBe("rejected");
    await expect(f.harness.behavior.callRpc("retry", { sessionId: session.id })).rejects.toThrow(/revised/);
    expect(canonical(f, task.id)).toEqual(before);
    expect(f.repo.transcript(session.id)).toEqual(frozen);
    const evidence = f.repo.kernel.proposalEvidence(replacement.proposalId!);
    expect(evidence.find((e) => e.ref === "fact:0")?.sourceRef).toBe(`bb-thread:${session.workerThreadId}#${frozen.messages.find((m) => m.text === decision)!.ref}`);
    expect(evidence.find((e) => e.ref === "fact:1")?.sourceRef).toContain(`bb-thread:${discussion.workerThreadId}#`);
    const transcript = f.repo.transcript(discussion.id)!;
    expect(transcript.messages.at(-1)?.text).toBe(input.request.input[0].text);
    expect(transcript.messages.some((m) => m.text.includes('"rationale"'))).toBe(false);
    await f.harness.behavior.callRpc("accept", { proposalId: replacement.proposalId, revision: task.revision });
    expect(f.repo.planning(task.id)).toMatchObject({ urgent: false, important: true });
    const accepted = canonical(f, task.id);
    expect(accepted.task.status).toBe("open");
    expect(accepted.facts.find((item) => item.text === decision)?.sourceRef).toContain(`bb-thread:${session.workerThreadId}#`);
    expect(f.threads.get(session.workerThreadId!)?.archivedAt).not.toBeNull();
    expect(f.threads.get(discussion.workerThreadId!)?.archivedAt).not.toBeNull();
  });

  it.each(["cancel", "invalid extraction"])("leaves the old pending proposal usable after %s", async (mode) => {
    const { f, task, session } = await setup();
    const pending = await review(f, session);
    const discussion = sessionSchema.parse(await f.harness.behavior.callRpc("start", { ...f.startInput(task.id, task.revision), criteria: [], continueSessionId: session.id }));
    if (mode === "cancel") await f.harness.behavior.callRpc("cancel", { sessionId: discussion.id });
    else {
      await f.harness.behavior.callRpc("finish", { sessionId: discussion.id });
      await f.idle(f.repo.session(discussion.id).reviewerThreadId!, {});
    }
    expect(f.repo.kernel.getProposal(pending.proposalId!).status).toBe("pending");
    await f.harness.behavior.callRpc("accept", { proposalId: pending.proposalId, revision: task.revision });
    expect(f.repo.planning(task.id)).toMatchObject({ urgent: false, important: false });
  });

  it("rejects cross-task and unfinished discussion sources before any spawn", async () => {
    const { f, task, session } = await setup();
    const request = { ...f.startInput(task.id, task.revision), criteria: [], continueSessionId: session.id };
    await expect(f.harness.behavior.callRpc("start", request)).rejects.toThrow(/finished conversation/);
    await review(f, session);
    const other = await f.create();
    const count = f.harness.inspection.sdk.callsTo("threads.spawn").length;
    await expect(f.harness.behavior.callRpc("start", { ...request, taskId: other.id, revision: other.revision })).rejects.toThrow(/belonging to this task/);
    expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(count);
  });

  it("discusses an archived task without reopening or archiving the live discussion, then proposes reopening", async () => {
    const { f, task, session } = await setup();
    const archivedText = "Архивируй задачу, пока к ней не возвращаемся.";
    f.message(session.workerThreadId!, "user", archivedText);
    const pending = await review(f, session, (transcript) => ({ rationale: "В архив по просьбе пользователя", facts: [fact(transcript, archivedText)], changes: { status: { value: "archived", evidenceRefs: ["fact:0"] } }, knowledge: [] }), true);
    await f.harness.behavior.callRpc("accept", { proposalId: pending.proposalId, revision: task.revision });
    const archived = canonical(f, task.id);
    const input = { ...f.startInput(task.id, archived.task.revision), criteria: [], continueSessionId: session.id };
    const reopenText = "Верни задачу в работу, пришёл новый вопрос Мэри.";
    input.request.input[0].text = reopenText;
    const discussion = sessionSchema.parse(await f.harness.behavior.callRpc("start", input));
    const runtime = new SessionRuntime(f.bb, f.repo, async () => ({ codexReviewer: "", claudeReviewer: "", maximumRepairs: 0, sessionMinutes: 20 }));
    await runtime.archiveFinishedThreads();
    expect(f.threads.get(discussion.workerThreadId!)?.archivedAt).toBeNull();
    expect(runtime.dispatch(discussion.workerThreadId!).action).toBe("proceed");
    expect(canonical(f, task.id)).toEqual(archived);
    const reopened = await review(f, discussion, (transcript) => ({ rationale: "Вернуть в работу по новому обращению", facts: [fact(transcript, reopenText)], changes: { status: { value: "open", evidenceRefs: ["fact:0"] } }, knowledge: [] }));
    expect(reopened.status).toBe("awaiting_approval");
    expect(f.repo.kernel.getProposal(pending.proposalId!).status).toBe("applied");
    await f.harness.behavior.callRpc("accept", { proposalId: reopened.proposalId, revision: archived.task.revision });
    expect(canonical(f, task.id).task.status).toBe("open");
  });

  it("keeps chronological, distinct citations across several discussions and enforces the transcript bound", () => {
    const transcript = (id: string, text: string): Transcript => ({ threadId: id, capturedAt: "2026-09-10", warnings: [], messages: [{ ref: "message:1", role: "user", text, sequence: 1 }] });
    const first = transcript("first", "A"), second = transcript("second", "B"), third = transcript("third", "C");
    const combined = continueTranscript(continueTranscript(first, second), third);
    expect(combined.messages.map((m) => m.text)).toEqual(["A", "B", "C"]);
    expect(new Set(combined.messages.map((m) => m.ref)).size).toBe(3);
    expect(combined.messages.map((m) => m.source?.threadId)).toEqual(["first", "second", "third"]);
    expect(() => continueTranscript(transcript("large", "x".repeat(512 * 1024)), second)).toThrow(/512 KiB/);
  });
});
