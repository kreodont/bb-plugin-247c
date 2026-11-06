import { afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { fixture } from "./test-support.js";
import { connectorCall, reportsFor, sourceData, startSourceSync, submitSourceData } from "./source-sync-test-support.js";
import { readSourceCalls, SourceSyncStore } from "./source-sync.js";
import { SourceChatUpdates } from "./source-chat-updates.js";
import { sourceParts } from "./proposal-parts.js";
import { rpcContract, sessionSchema, type SyncCandidate } from "./contracts.js";

const hosts: Awaited<ReturnType<typeof fixture>>[] = [];
afterEach(async () => { for (const f of hosts.splice(0)) await f.harness.lifecycle.dispose(); vi.restoreAllMocks(); });
async function setup(status: "waiting" | "open" = "waiting", proposedStatus: "open" | "done" = "open") {
  const f = await fixture({ settings: { workProvider: "codex", workModel: "gpt-5.6-sol" } }); hosts.push(f);
  const task = await f.create();
  if (status === "waiting") f.repo.status(task.id, "waiting", task.revision);
  const { run } = await startSourceSync(f), { input } = await sourceData(f, run, task.id);
  if (proposedStatus) input.suggestions[0].changes.status = { value: proposedStatus, evidenceRefs: ["fact:0"] };
  await submitSourceData(f, run, input);
  const store = new SourceSyncStore(f.repo), candidate = store.candidates()[0];
  return { f, task, store, candidate };
}
function dispatcher(f: Awaited<ReturnType<typeof fixture>>) {
  const openChat = vi.fn(async (input: { taskId: string; requestId: string }) => sessionSchema.parse(await f.harness.behavior.callRpc("openChat", input)));
  return { openChat, service: new SourceChatUpdates(f.bb, f.repo, { openChat }, () => ({ projectId: "proj_personal", providerId: "codex", model: "gpt-5.6-sol" })) };
}
function stubSend(f: Awaited<ReturnType<typeof fixture>>) {
  const send = vi.fn<typeof f.bb.sdk.threads.send>();
  f.harness.sdk.stub("threads.send", send);
  return send;
}
function patchDelivery(f: Awaited<ReturnType<typeof fixture>>, candidate: SyncCandidate, patch: Partial<NonNullable<SyncCandidate["chatDelivery"]>>) {
  f.repo.db.prepare("UPDATE source_sync_candidates SET value_json=? WHERE id=?").run(JSON.stringify({ ...candidate, chatDelivery: { ...candidate.chatDelivery, ...patch } }), candidate.id);
}

it("offers separate waiting actions for an evidenced resume proposal before acceptance", async () => {
  const { f, task, store, candidate } = await setup();
  expect(candidate.actions).toEqual(["reopen", "openChat"]);
  expect(candidate.changes.status).toBeUndefined();
  expect(sourceParts(candidate)).toEqual(expect.arrayContaining(["action:reopen", "action:openChat"]));
  expect(f.repo.kernel.getTask(task.id).status).toBe("waiting");
  expect(f.repo.sessions(task.id)).toHaveLength(0);
  expect(candidate.chatDelivery).toBeUndefined();
  store.accept(candidate.id);
  expect(f.repo.kernel.getTask(task.id).status).toBe("open");
  expect(store.candidate(candidate.id).chatDelivery?.state).toBe("pending");
  const once = f.repo.detail(task.id);
  store.accept(candidate.id);
  expect(f.repo.detail(task.id)).toEqual(once);
});

it.each([
  { author: "user", quote: "The order fails because the tax code is missing. Can you confirm the correct code?", status: undefined },
  { author: "user", quote: "The order fails because the tax code is missing. Can you confirm the correct code?", status: "waiting" as const },
  { author: "colleague", quote: "Thanks, I will confirm the correct code tomorrow.", status: undefined },
])("keeps waiting after $author updates (status $status), including after acceptance", async ({ author, quote, status }) => {
  const f = await fixture(); hosts.push(f);
  const task = await f.create(); f.repo.status(task.id, "waiting", task.revision);
  const { run } = await startSourceSync(f), { input } = await sourceData(f, run, task.id);
  connectorCall(f, run.threadId!, "mcp__Gmail__get_thread", { threadId: "tax-thread" }, { messages: [{ id: "tax-reply", author, text: quote }] });
  const calls = await readSourceCalls(f.bb, run.threadId!);
  const citation = { callRef: calls.at(-1)!.ref, source: "gmail" as const, url: "https://mail.google.com/mail/u/0/#all/tax-thread",
    messageId: "tax-reply", occurredAt: run.until, quote };
  const draft = input.suggestions[0], step = "Wait for the colleague to confirm the correct tax code, then retry the order.";
  draft.rationale = "The investigation is complete; the next step must reflect the pending external answer.";
  draft.facts = [{ kind: "progress", text: "The correct tax code was requested; a response is still pending.", citations: [citation] },
    { kind: "explicit_next_step", text: step, citations: [citation] }];
  draft.changes = { nextStep: { value: step, evidenceRefs: ["fact:1"] }, ...(status ? { status: { value: status, evidenceRefs: ["fact:0"] } } : {}) };
  input.reports = reportsFor(calls);
  await submitSourceData(f, run, input);
  const store = new SourceSyncStore(f.repo), candidate = store.pendingCandidates()[0];
  expect(candidate.actions).toEqual([]);
  expect(sourceParts(candidate).some(p => p.startsWith("action:"))).toBe(false);
  const { service, openChat } = dispatcher(f), send = stubSend(f);
  store.accept(candidate.id); await service.flush();
  expect(f.repo.kernel.getTask(task.id).status).toBe("waiting");
  expect(f.repo.detail(task.id).projection.nextStep).toBe(step);
  expect(f.repo.sessions(task.id)).toHaveLength(0);
  expect(store.candidate(candidate.id).chatDelivery).toBeUndefined();
  expect(openChat).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
});

it("rejects reopening without an evidenced next step and keeps the task waiting", async () => {
  const f = await fixture(); hosts.push(f);
  const task = await f.create(); f.repo.status(task.id, "waiting", task.revision);
  const { run } = await startSourceSync(f), { input } = await sourceData(f, run, task.id);
  input.suggestions[0].changes.status = { value: "open", evidenceRefs: ["fact:0"] };
  delete input.suggestions[0].changes.nextStep;
  await expect(submitSourceData(f, run, input)).rejects.toThrow(/Resuming a waiting task requires/);
  expect(new SourceSyncStore(f.repo).pendingCandidates()).toEqual([]);
  expect(f.repo.kernel.getTask(task.id).status).toBe("waiting");
});

it.each([["open", undefined], ["waiting", "done"]] as const)("does not add waiting actions to %s / %s proposals", async (status, proposed) => {
  const { candidate } = await setup(status, proposed);
  expect(candidate.actions).toEqual([]);
});

it("supports chat-only acceptance while keeping reopen unchecked, then explicit rejection", async () => {
  const { f, task, store, candidate } = await setup();
  const input = { kind: "source" as const, id: candidate.id, revision: candidate.baseRevision, parts: ["action:openChat"], decision: "accept" as const, requestId: randomUUID() };
  const result = store.reviewParts(input);
  expect(f.repo.kernel.getTask(task.id).status).toBe("waiting");
  const remaining = store.candidate(result.remainingId!);
  expect(remaining.actions).toEqual(["reopen"]);
  expect(remaining.chatDelivery).toBeUndefined();
  const accepted = store.candidates().find(c => c.status === "applied")!;
  expect(accepted.actions).toEqual(["openChat"]);
  expect(accepted.chatDelivery?.message).toContain('"acceptedChanges":{}');
  expect(store.reviewParts(input)).toEqual(result);
  store.reject(remaining.id);
  expect(f.repo.kernel.getTask(task.id).status).toBe("waiting");
});

it("reopens without launching a chat when the chat part is rejected", async () => {
  const { f, task, store, candidate } = await setup();
  const result = store.reviewParts({ kind: "source", id: candidate.id, revision: candidate.baseRevision, decision: "reject", parts: ["action:openChat"], requestId: randomUUID() });
  store.accept(result.remainingId!);
  await dispatcher(f).service.flush();
  expect(f.repo.kernel.getTask(task.id).status).toBe("open");
  expect(f.repo.sessions(task.id)).toHaveLength(0);
});

it.each([false, true])("opens or reuses the work chat and delivers once (existing=%s)", async existing => {
  const { f, task, store, candidate } = await setup();
  const { openChat, service } = dispatcher(f);
  const previous = existing ? await openChat({ taskId: task.id, requestId: randomUUID() }) : null;
  const send = stubSend(f).mockImplementation(async args => {
    f.message(args.threadId, "user", args.input.map(p => p.type === "text" ? p.text : "").join("\n"));
    return { ok: true, delivery: "sent" };
  });
  store.accept(candidate.id);
  await Promise.all([service.flush(), service.flush()]);
  const saved = store.candidate(candidate.id);
  expect(saved.chatDelivery?.state).toBe("sent");
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0][0].mode).toBe("queue-if-active");
  expect(send.mock.calls[0][0].input).toEqual([expect.objectContaining({ text: expect.stringContaining("https://mail.google.com/") })]);
  expect(f.repo.sessions(task.id)).toHaveLength(1);
  if (previous) expect(saved.chatDelivery?.threadId).toBe(previous.workerThreadId);
  store.accept(candidate.id);
  await dispatcher(f).service.flush(); // A fresh service instance reads persisted state.
  expect(send).toHaveBeenCalledTimes(1);
  const page = rpcContract.proposalInbox.output.parse(await f.harness.behavior.callRpc("proposalInbox", {}));
  expect(page.recentlyAccepted[0].chatDelivery).toMatchObject({ state: "sent", threadId: saved.chatDelivery?.threadId });
});

it("resumes committed pending work after reload", async () => {
  const { f, store, candidate } = await setup();
  store.accept(candidate.id);
  await f.reload();
  const send = stubSend(f).mockResolvedValue({ ok: true, delivery: "sent" });
  await dispatcher(f).service.flush();
  expect(send).toHaveBeenCalledTimes(1);
  expect(new SourceSyncStore(f.repo).candidate(candidate.id).chatDelivery?.state).toBe("sent");
});

it("never repeats an ambiguous send and keeps the failure visible", async () => {
  const { f, store, candidate } = await setup();
  const send = stubSend(f).mockRejectedValue(new Error("connection lost"));
  store.accept(candidate.id);
  await dispatcher(f).service.flush();
  expect(store.candidate(candidate.id).chatDelivery?.state).toBe("uncertain");
  await dispatcher(f).service.flush();
  expect(send).toHaveBeenCalledTimes(1);
  const page = rpcContract.proposalInbox.output.parse(await f.harness.behavior.callRpc("proposalInbox", {}));
  expect(page.recentlyAccepted[0].chatDelivery?.error).toContain("Check the chat");
});

it("reconciles a lost send response using the saved message marker", async () => {
  const { f, store, candidate } = await setup();
  const send = stubSend(f).mockImplementation(async args => {
    f.message(args.threadId, "user", args.input.map(p => p.type === "text" ? p.text : "").join("\n"));
    throw new Error("response lost");
  });
  store.accept(candidate.id);
  await dispatcher(f).service.flush();
  expect(store.candidate(candidate.id).chatDelivery?.state).toBe("sent");
  const saved = store.candidate(candidate.id);
  patchDelivery(f, saved, { state: "sending" }); // Crash after BB accepted, before local receipt.
  await dispatcher(f).service.flush();
  expect(store.candidate(candidate.id).chatDelivery?.state).toBe("sent");
  expect(send).toHaveBeenCalledTimes(1);
});

it("does not roll back an approval if the configured chat model is unavailable", async () => {
  const { f, task, store, candidate } = await setup();
  store.accept(candidate.id);
  const service = new SourceChatUpdates(f.bb, f.repo, { openChat: vi.fn().mockRejectedValue(new Error("model unavailable")) }, () => ({ projectId: "", providerId: "", model: "" }));
  await service.flush();
  expect(f.repo.kernel.getTask(task.id).status).toBe("open");
  expect(store.candidate(candidate.id)).toMatchObject({ status: "applied", chatDelivery: { state: "failed", error: expect.stringContaining("model unavailable") } });
});

it("waits for an active review and then reuses its resumed work conversation", async () => {
  const { f, task, store, candidate } = await setup();
  const { service, openChat } = dispatcher(f);
  const session = await openChat({ taskId: task.id, requestId: randomUUID() });
  f.repo.saveSession({ ...session, status: "reviewing" });
  store.accept(candidate.id);
  const send = stubSend(f).mockResolvedValue({ ok: true, delivery: "sent" });
  await service.flush();
  expect(send).not.toHaveBeenCalled();
  expect(store.candidate(candidate.id).chatDelivery?.state).toBe("pending");
  f.repo.saveSession({ ...session, status: "working" });
  await service.flush();
  expect(send).toHaveBeenCalledTimes(1);
  expect(store.candidate(candidate.id).chatDelivery?.threadId).toBe(session.workerThreadId);
});

it("reuses a chat created before a restart and recognizes an already queued update", async () => {
  const { f, task, store, candidate } = await setup();
  store.accept(candidate.id);
  const saved = store.candidate(candidate.id);
  const session = await dispatcher(f).openChat({ taskId: task.id, requestId: saved.chatDelivery!.requestId });
  const send = stubSend(f).mockResolvedValue({ ok: true, delivery: "sent" });
  await dispatcher(f).service.flush();
  expect(f.repo.sessions(task.id)).toHaveLength(1);
  expect(send).toHaveBeenCalledTimes(1);
  const delivered = store.candidate(candidate.id);
  patchDelivery(f, delivered, { state: "sending" });
  f.harness.sdk.stub("threads.queuedMessages.list", () => [{ content: [{ type: "text", text: delivered.chatDelivery!.message }] }]);
  await dispatcher(f).service.flush();
  expect(store.candidate(candidate.id).chatDelivery).toMatchObject({ state: "queued", threadId: session.workerThreadId });
  expect(send).toHaveBeenCalledTimes(1);
});

it.each(["syncAccept", "acceptInbox", "reviewParts"])("dispatches from the %s approval RPC", async method => {
  const { f, store, candidate } = await setup();
  const send = stubSend(f).mockResolvedValue({ ok: true, delivery: "sent" });
  await f.harness.behavior.callRpc(method, method === "syncAccept" ? { candidateId: candidate.id }
    : method === "acceptInbox" ? { items: [{ kind: "source", id: candidate.id, revision: candidate.baseRevision }] }
    : { kind: "source", id: candidate.id, revision: candidate.baseRevision, decision: "accept", parts: ["action:openChat"], requestId: randomUUID() });
  await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  await vi.waitFor(() => expect(store.candidates().some(c => c.chatDelivery?.state === "sent")).toBe(true));
});


it.each(["recover", "rejected", "pending", "later-wait", "different-step", "extra-field"] as const)(
  "handles an omitted resume action without reviving reviewed work: %s", async scenario => {
    const f = await fixture({ settings: { workProvider: "codex", workModel: "gpt-5.6-sol" } }); hosts.push(f);
    const task = await f.create(), store = new SourceSyncStore(f.repo);
    f.repo.status(task.id, "waiting", task.revision);
    const first = (await startSourceSync(f)).run, data = await sourceData(f, first, task.id);
    for (const fact of data.input.suggestions[0].facts) for (const citation of fact.citations) citation.occurredAt = first.until;
    store.submit(first.id, data.input, data.calls);
    const original = store.pendingCandidates()[0];
    if (scenario === "rejected") store.reject(original.id);
    else if (scenario !== "pending") store.accept(original.id);
    if (scenario === "later-wait") {
      let current = f.repo.kernel.getTask(task.id);
      current = f.repo.status(task.id, "open", current.revision);
      f.repo.status(task.id, "waiting", current.revision);
    }
    const second = (await startSourceSync(f)).run;
    const corrected = structuredClone(data.input), draft = corrected.suggestions[0];
    draft.changes = { status: { value: "open", evidenceRefs: ["fact:0"] }, nextStep: draft.changes.nextStep };
    if (scenario === "different-step") {
      draft.facts[1].text = "Send another report.";
      draft.changes.nextStep!.value = draft.facts[1].text;
    }
    if (scenario === "extra-field") draft.changes.summary = { value: "Different summary", evidenceRefs: ["fact:0"] };
    const result = store.submit(second.id, corrected, data.calls);
    if (scenario !== "recover") {
      expect(result.duplicates).toBe(1);
      expect(f.repo.kernel.getTask(task.id).status).toBe("waiting");
      return;
    }
    expect(result.suggestions).toBe(1);
    const candidate = store.pendingCandidates()[0];
    expect(candidate.actions).toEqual(["reopen", "openChat"]);
    expect(f.repo.kernel.getTask(task.id).status).toBe("waiting");
    store.accept(candidate.id);
    const send = stubSend(f).mockResolvedValue({ ok: true, delivery: "sent" });
    await dispatcher(f).service.flush();
    expect(f.repo.kernel.getTask(task.id).status).toBe("open");
    expect(send).toHaveBeenCalledTimes(1);
    const third = (await startSourceSync(f)).run;
    expect(store.submit(third.id, corrected, data.calls).duplicates).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
  });
