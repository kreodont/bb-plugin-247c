import { afterEach, describe, expect, it } from "vitest";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { fixture } from "./test-support.js";
import { sessionSchema, type Extraction } from "./contracts.js";

type RawEvents = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["events"]["list"]>>;
type Spawn = Extract<Parameters<BbPluginApi["sdk"]["threads"]["spawn"]>[0], { prompt: string }>;
const hosts: Awaited<ReturnType<typeof fixture>>[] = [];
afterEach(async () => { for (const f of hosts.splice(0)) await f.harness.lifecycle.dispose(); });

function request(threadId: string, spawn: Spawn): RawEvents {
  return [{ id: `request_${threadId}`, scope: { kind: "thread" }, threadId, seq: 1, createdAt: Date.now(), type: "client/turn/requested", data: {
    direction: "outbound", requestId: `request_${threadId}`, source: "spawn", initiator: "user", senderThreadId: null,
    systemMessageKind: "unlabeled", systemMessageSubject: null, input: [{ type: "text", text: spawn.prompt!, mentions: [] }],
    target: { kind: "thread-start" }, request: { method: "thread/start", params: {} },
    execution: { model: spawn.model!, reasoningLevel: spawn.reasoningLevel!, permissionMode: "accept-edits", serviceTier: "default", source: "client/turn/requested" },
  } }];
}

async function failedRecorder() {
  const f = await fixture(); hosts.push(f);
  await f.harness.behavior.setSettings({ maximumRepairs: 0 });
  const task = await f.create();
  const session = sessionSchema.parse(await f.harness.behavior.callRpc("start", { ...f.startInput(task.id, task.revision), criteria: [] }));
  const report = "Правка Alpha работает в проде. Дополнительный PR ещё ждёт одобрения.";
  await f.idle(session.workerThreadId!, report);
  await f.harness.behavior.callRpc("finish", { sessionId: session.id });
  const reviewing = f.repo.session(session.id);
  const before = await f.detail(task.id);
  const transcript = f.repo.transcript(session.id)!;
  const source = transcript.messages.find((m) => m.text === report)!;
  const draft: Extraction = { rationale: "Сохранить подтверждённый результат шага, оставив задачу открытой.",
    facts: [{ kind: "progress", text: `Ассистент сообщил: ${report}`, citations: [{ messageRef: source.ref, quote: report }] }],
    changes: { summary: { value: `Ассистент сообщил: ${report}`, evidenceRefs: ["fact:0"] }, nextStep: { value: null, evidenceRefs: ["fact:0"] } }, knowledge: [] };
  const spawn = f.harness.inspection.sdk.callsTo("threads.spawn").at(-1)![0] as Spawn;
  const events = new Map([[reviewing.reviewerThreadId!, request(reviewing.reviewerThreadId!, spawn)]]);
  f.harness.inspection.sdk.stub("threads.events.list", ({ threadId }) => events.get(threadId) ?? []);
  f.outputs.set(reviewing.reviewerThreadId!, JSON.stringify(draft));
  f.threads.set(reviewing.reviewerThreadId!, { ...f.threads.get(reviewing.reviewerThreadId!)!, status: "idle", archivedAt: Date.now() });
  // A saved session from the earlier validator, before progress could clear a step.
  f.repo.saveSession({ ...reviewing, status: "blocked", error: "nextStep needs explicit_next_step or user_instruction evidence" });
  return { f, task, before, session: f.repo.session(session.id), draft, transcript, events, spawn };
}

describe("Recovering saved recorder responses", () => {
  it("finds a valid earlier response behind an invalid later one, without generating or approving anything", async () => {
    const { f, task, before, session, draft, transcript, events, spawn } = await failedRecorder();
    const newer = await f.bb.sdk.threads.spawn(spawn);
    events.set(newer.id, request(newer.id, spawn));
    f.outputs.set(newer.id, "broken JSON");
    f.threads.set(newer.id, { ...f.threads.get(newer.id)!, status: "idle", archivedAt: Date.now() });
    f.repo.saveSession({ ...session, round: session.round + 1, reviewerThreadId: newer.id });
    const count = f.harness.inspection.sdk.callsTo("threads.spawn").length;
    const recovered = sessionSchema.parse(await f.harness.behavior.callRpc("retry", { sessionId: session.id }));
    expect(recovered).toMatchObject({ status: "awaiting_approval", reviewerThreadId: session.reviewerThreadId, reviewerModel: spawn.model, error: null, extractionRepair: null });
    expect(recovered.extraction).toEqual(draft);
    expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(count);
    const after = await f.detail(task.id);
    expect(after.task).toEqual(before.task);
    expect(after.projection).toEqual(before.projection);
    expect(after.facts).toEqual(before.facts);
    expect(f.repo.transcript(session.id)).toEqual(transcript);
    expect(f.repo.kernel.getProposal(recovered.proposalId!).status).toBe("pending");
    expect(f.repo.kernel.getProposal(recovered.proposalId!).idempotencyKey).toBe(`conversation:${session.id}:recovered:${session.reviewerThreadId}`);
    await expect(Promise.resolve().then(() => f.repo.kernel.applyProposal(recovered.proposalId!))).rejects.toThrow(/approved/);
  });

  it.each(["changed transcript", "changed dossier", "extra recorder message", "invalid quote", "explicit model", "unavailable history"])("generates a fresh response for %s", async (condition) => {
    const { f, task, before, session, draft, events, spawn } = await failedRecorder();
    if (condition === "changed transcript") events.set(session.reviewerThreadId!, request(session.reviewerThreadId!, { ...spawn, prompt: spawn.prompt!.replace("Правка Alpha", "Другая правка") }));
    if (condition === "changed dossier") f.repo.classify({ taskId: task.id, revision: before.planning.revision, urgent: true, important: null });
    if (condition === "extra recorder message") events.get(session.reviewerThreadId!)!.push({ ...events.get(session.reviewerThreadId!)![0], id: "second_request", seq: 2 });
    if (condition === "invalid quote") { draft.facts[0].citations[0].quote = "Несуществующая цитата"; f.outputs.set(session.reviewerThreadId!, JSON.stringify(draft)); }
    if (condition === "unavailable history") f.harness.inspection.sdk.stub("threads.events.list", () => { throw new Error("History unavailable"); });
    const retried = sessionSchema.parse(await f.harness.behavior.callRpc("retry", { sessionId: session.id, ...(condition === "explicit model" ? { recorder: "same" } : {}) }));
    expect(retried.status).toBe("reviewing");
    expect(retried.reviewerThreadId).not.toBe(session.reviewerThreadId);
    expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(3);
    expect(f.repo.detail(task.id).proposals).toHaveLength(0);
  });

  it("never revives a recovered proposal after the user rejects it", async () => {
    const { f, session } = await failedRecorder();
    const recovered = sessionSchema.parse(await f.harness.behavior.callRpc("retry", { sessionId: session.id }));
    await f.harness.behavior.callRpc("reject", { proposalId: recovered.proposalId });
    const fresh = sessionSchema.parse(await f.harness.behavior.callRpc("retry", { sessionId: session.id }));
    await f.idle(fresh.reviewerThreadId!, "broken JSON");
    expect(f.repo.session(session.id).status).toBe("blocked");
    const again = sessionSchema.parse(await f.harness.behavior.callRpc("retry", { sessionId: session.id }));
    expect(again.status).toBe("reviewing");
    expect(again.reviewerThreadId).not.toBe(session.reviewerThreadId);
    expect(f.repo.kernel.getProposal(recovered.proposalId!).status).toBe("rejected");
    expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(4);
  });

  it("does not save a recovered draft when the dossier changes while history is being read", async () => {
    const { f, task, before, session, events } = await failedRecorder();
    f.harness.inspection.sdk.stub("threads.events.list", ({ threadId }) => {
      f.repo.classify({ taskId: task.id, revision: before.planning.revision, urgent: true, important: null });
      return events.get(threadId) ?? [];
    });
    await expect(f.harness.behavior.callRpc("retry", { sessionId: session.id })).rejects.toThrow(/The dossier changed/);
    expect(f.repo.session(session.id)).toMatchObject({ status: "blocked", proposalId: null });
    expect(f.repo.detail(task.id).proposals).toHaveLength(0);
    expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(2);
  });

  it("rolls back the recovery session and proposal together if persistence fails", async () => {
    const { f, task, session } = await failedRecorder();
    f.repo.db.exec("CREATE TRIGGER fail_recovery BEFORE INSERT ON session_updates BEGIN SELECT RAISE(ABORT, 'recovery failure'); END");
    await expect(f.harness.behavior.callRpc("retry", { sessionId: session.id })).rejects.toThrow("recovery failure");
    expect(f.repo.session(session.id)).toEqual(session);
    expect(f.repo.detail(task.id).proposals).toHaveLength(0);
    expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(2);
  });
});
