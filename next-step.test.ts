import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { fixture } from "./test-support.js";
import { sessionSchema, type Extraction } from "./contracts.js";
import { validateExtraction, extractionProposal } from "./conversation.js";
import { managementGuide } from "./prompts.js";
import { automaticWorkGuide } from "./automation-prompts.js";
import { waitingContextGuide } from "./waiting-context.js";

const hosts: Awaited<ReturnType<typeof fixture>>[] = [];
afterEach(async () => { for (const f of hosts.splice(0)) await f.harness.lifecycle.dispose(); });

async function recordedStep(kind: Extraction["facts"][number]["kind"], report: string, role: "user" | "assistant" = "assistant") {
  const f = await fixture(); hosts.push(f);
  await f.harness.behavior.setSettings({ maximumRepairs: 0 });
  const task = await f.create();
  const step = f.repo.note({ taskId: task.id, revision: task.revision, kind: "explicit_next_step", text: "Убрать Alpha из автоскидки, Bravo сохранить.", requestId: randomUUID() });
  const initial = f.repo.propose({ taskId: task.id, revision: task.revision + 1, requestId: randomUUID(), draft: {
    rationale: "Принятый следующий шаг", confidence: 1, changes: { nextStep: { value: step.text, evidenceRefs: [step.id] } },
  } }, "test");
  f.repo.accept(initial.id, task.revision + 1);
  const before = await f.detail(task.id);
  const session = sessionSchema.parse(await f.harness.behavior.callRpc("start", { ...f.startInput(task.id, before.task.revision), criteria: [] }));
  if (role === "user") {
    f.message(session.workerThreadId!, "user", report);
    await f.idle(session.workerThreadId!, "Понял.");
  } else await f.idle(session.workerThreadId!, report);
  await f.harness.behavior.callRpc("pauseSession", { sessionId: session.id });
  const transcript = f.repo.transcript(session.id)!;
  const source = transcript.messages.find((m) => m.role === role && m.text === report)!;
  const fact = role === "assistant" ? `По отчёту ассистента: ${report}` : report;
  const draft: Extraction = { rationale: "Предлагается убрать выполненный или отменённый шаг; задача остаётся открытой.", facts: [
    { kind, text: fact, citations: [{ messageRef: source.ref, quote: report }] },
  ], changes: { summary: { value: fact, evidenceRefs: ["fact:0"] }, nextStep: { value: null, evidenceRefs: ["fact:0"] } }, knowledge: [] };
  return { f, before, session: f.repo.session(session.id), transcript, draft };
}

describe("Clearing an explicit next step independently of task completion", () => {
  it.each([
    { kind: "progress" as const, role: "assistant" as const, report: "Alpha убран из автоскидки, Bravo сохранён. Для дополнительной правки ещё ждём апрув PR." },
    { kind: "decision" as const, role: "user" as const, report: "Старый следующий шаг отменяем. Задачу пока не закрываем, ждём решение по PR." },
  ])("proposes clearing from $kind and applies/reverses it only after approval while keeping the task open", async ({ kind, role, report }) => {
    const { f, before, session, transcript, draft } = await recordedStep(kind, report, role);
    await f.idle(session.reviewerThreadId!, draft);
    const pending = f.repo.session(session.id);
    expect(pending).toMatchObject({ status: "awaiting_approval", error: null, extractionRepair: null });
    const proposed = await f.detail(before.task.id);
    expect(proposed.task).toEqual(before.task);
    expect(proposed.projection).toEqual(before.projection);
    expect(proposed.facts).toEqual(before.facts);
    expect(f.repo.transcript(session.id)).toEqual(transcript);
    expect(f.repo.kernel.getProposal(pending.proposalId!).changes.status).toBeUndefined();
    await expect(Promise.resolve().then(() => f.repo.kernel.applyProposal(pending.proposalId!))).rejects.toThrow(/approved/);

    await f.harness.behavior.callRpc("accept", { proposalId: pending.proposalId, revision: before.task.revision });
    const applied = await f.detail(before.task.id);
    expect(applied.task).toMatchObject({ status: "open", revision: before.task.revision + 1 });
    expect(applied.planning).toEqual(before.planning);
    expect(applied.projection.nextStep).toBeNull();
    expect(applied.facts).toHaveLength(before.facts.length + 1);
    expect(f.repo.kernel.getApplicationReceipt(pending.proposalId!).fields).toEqual(["summary", "nextStep"]);

    const reverse = f.repo.kernel.proposeRevert(pending.proposalId!);
    expect((await f.detail(before.task.id)).projection.nextStep).toBeNull();
    await f.harness.behavior.callRpc("accept", { proposalId: reverse.id, revision: applied.task.revision });
    const restored = await f.detail(before.task.id);
    expect(restored.task.status).toBe("open");
    expect(restored.projection.nextStep).toBe(before.projection.nextStep);
  });

  it.each(["description", "new action", "unknown reference", "invented quote"])("rejects %s without changing the accepted step", async (failure) => {
    const { f, before, session, draft } = await recordedStep(failure === "description" ? "description" : "progress", "Основная правка выполнена. Дополнительный PR ещё открыт.");
    if (failure === "new action") draft.changes!.nextStep!.value = draft.facts[0].text;
    if (failure === "unknown reference") draft.changes!.nextStep!.evidenceRefs = ["fact:99"];
    if (failure === "invented quote") draft.facts[0].citations[0].quote = "Этого в разговоре не было.";
    await f.idle(session.reviewerThreadId!, draft);
    expect(f.repo.session(session.id)).toMatchObject({ status: "blocked", proposalId: null });
    const after = await f.detail(before.task.id);
    expect(after.task).toEqual(before.task);
    expect(after.projection).toEqual(before.projection);
    expect(after.facts).toEqual(before.facts);
  });
});

describe("Describing a concrete waiting dependency", () => {
  async function waitingReview(alreadyWaiting = false) {
    const f = await fixture(); hosts.push(f);
    await f.harness.behavior.setSettings({ maximumRepairs: 0 });
    const task = await f.create("Reopen estimate E1000123");
    if (alreadyWaiting) f.repo.status(task.id, "waiting", task.revision);
    const before = await f.detail(task.id);
    const session = sessionSchema.parse(await f.harness.behavior.callRpc("start", { ...f.startInput(task.id, before.task.revision), criteria: [] }));
    const report = "Alex replied, but has not created the SO yet. As agreed, estimate E1000123 must be closed again after the SO is created.";
    await f.idle(session.workerThreadId!, report);
    f.message(session.workerThreadId!, "user", "ждем ответа");
    await f.idle(session.workerThreadId!, "Остаётся дождаться создания SO.");
    await f.harness.behavior.callRpc("finish", { sessionId: session.id });
    const transcript = f.repo.transcript(session.id)!;
    const source = transcript.messages.find(m => m.text === report)!;
    const user = transcript.messages.find(m => m.text === "ждем ответа")!;
    const draft: Extraction = { rationale: "Keep the concrete dependency behind the user's shorthand.",
      facts: [
        { kind: "progress", text: `The assistant reports: ${report}`, citations: [{ messageRef: source.ref, quote: report }] },
        { kind: "decision", text: "The user chose to continue waiting.", citations: [{ messageRef: user.ref, quote: "ждем ответа" }] },
      ],
      changes: { status: { value: "waiting", evidenceRefs: ["fact:0", "fact:1"] },
        nextStep: { value: "Ждём, пока Alex создаст SO, затем снова закрыть E1000123.", evidenceRefs: ["fact:0", "fact:1"] } }, knowledge: [] };
    return { f, before, session: f.repo.session(session.id), transcript, draft };
  }

  it.each([false, true])("records a contextual wait from verified quotes without treating it as a verbatim instruction (already waiting=%s)", async alreadyWaiting => {
    const { f, before, session, draft } = await waitingReview(alreadyWaiting);
    await f.idle(session.reviewerThreadId!, draft);
    const review = f.repo.session(session.id);
    expect(review).toMatchObject({ status: "awaiting_approval", error: null });
    expect((await f.detail(before.task.id)).projection.nextStep).toBe(before.projection.nextStep);
    await f.harness.behavior.callRpc("accept", { proposalId: review.proposalId, revision: before.task.revision });
    const after = await f.detail(before.task.id);
    expect(after.task.status).toBe("waiting");
    expect(after.projection.nextStep).toBe(draft.changes!.nextStep!.value);
    expect(after.facts.filter(f => ["explicit_next_step", "user_instruction"].includes(f.kind))).toHaveLength(0);
    expect(after.planning).toEqual(before.planning);
  });

  it("also permits correcting an already waiting task without changing its status", async () => {
    const { before, session, transcript, draft } = await waitingReview(true);
    delete draft.changes!.status;
    const extraction = validateExtraction(draft, transcript, undefined, "waiting");
    expect(extractionProposal(extraction, { ...session, finishMode: undefined }, before, transcript).output.changes.nextStep).toEqual(draft.changes!.nextStep);
  });

  it.each(["open", "done", "archived", "missing evidence", "invented quote", "false instruction", "description only"])("preserves the evidence boundary: %s", async failure => {
    const { f, before, session, draft } = await waitingReview();
    if (["open", "done", "archived"].includes(failure)) draft.changes!.status!.value = failure as "open" | "done" | "archived";
    if (failure === "missing evidence") draft.changes!.nextStep!.evidenceRefs = ["fact:99"];
    if (failure === "invented quote") draft.facts[0].citations[0].quote = "Alex completed the SO.";
    if (failure === "false instruction") draft.facts[0].kind = "explicit_next_step";
    if (failure === "description only") {
      draft.facts[0].kind = "description";
      draft.changes!.nextStep!.evidenceRefs = ["fact:0"];
    }
    await f.idle(session.reviewerThreadId!, draft);
    expect(f.repo.session(session.id)).toMatchObject({ status: "blocked", proposalId: null });
    const after = await f.detail(before.task.id);
    expect(after.task).toEqual(before.task);
    expect(after.projection).toEqual(before.projection);
  });

  it("gives both manual and automatic workers the same waiting-description rule", () => {
    expect(managementGuide).toContain(waitingContextGuide);
    expect(automaticWorkGuide).toContain(waitingContextGuide);
  });
});
