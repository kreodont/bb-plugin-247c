// @vitest-environment jsdom
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot, type CapturedPluginApp, type RenderedSlot } from "@get-bb/plugin-sdk/testing/app";
import { randomUUID } from "node:crypto";
import { fixture } from "./test-support.js";
import { dossierSchema, rpcContract, sessionSchema, type Extraction } from "./contracts.js";
import { taskProposalPath } from "./desk-routes.js";

let app: CapturedPluginApp;
const mounts: RenderedSlot[] = [], hosts: Awaited<ReturnType<typeof fixture>>[] = [];
beforeAll(async () => { app = await loadPluginApp(() => import("./app.js")); }, 60000);
afterEach(async () => { mounts.splice(0).forEach(m => m.lifecycle.unmount()); for (const f of hosts.splice(0)) await f.harness.lifecycle.dispose(); vi.restoreAllMocks(); localStorage.clear(); });

async function setup() {
  const f = await fixture(); hosts.push(f);
  const task = await f.create("Existing context");
  const session = sessionSchema.parse(await f.harness.behavior.callRpc("start", { ...f.startInput(task.id, task.revision), criteria: [] }));
  const rpc = Object.fromEntries(Object.keys(rpcContract).map(name => [name, (input: unknown) => f.harness.behavior.callRpc(name, input)]));
  function header(threadId = session.workerThreadId!, compact = false) {
    const slot = renderSlot(app.threadHeaderActions.find(s => s.id === "proposal")!, { threadId, isCompactViewport: compact, projectId: "proj_personal" }, { rpc }); mounts.push(slot); return slot;
  }
  function page() {
    const slot = renderSlot(app.navPanels[0], { subPath: taskProposalPath(task.id, session.id, session.workerThreadId!) }, { rpc }); mounts.push(slot); return slot;
  }
  async function finish() {
    const quote = "The configuration is ready.";
    f.message(session.workerThreadId!, "user", quote);
    await f.idle(session.workerThreadId!, "Verified the configuration.");
    await f.harness.behavior.callRpc("finish", { sessionId: session.id });
    const ref = f.repo.transcript(session.id)!.messages.find(m => m.text === quote)!.ref;
    const extraction: Extraction = { rationale: "Record the completed check", facts: [{ kind: "progress", text: quote, citations: [{ messageRef: ref, quote }] }],
      changes: { summary: { value: quote, evidenceRefs: ["fact:0"] } }, knowledge: [] };
    await f.idle(f.repo.session(session.id).reviewerThreadId!, extraction);
    return f.repo.session(session.id).proposalId!;
  }
  return { f, task, session, header, page, finish };
}

it("appears when the recorder finishes, opens the exact session and returns to its thread without accepting or running work", async () => {
  const { f, task, session, header, page, finish } = await setup();
  const h = header(), unrelated = header("unrelated");
  await h.behavior.emitRealtime("desk-changed", {});
  await unrelated.behavior.emitRealtime("desk-changed", {});
  expect(within(h.container).queryByRole("button")).toBeNull();
  expect(within(unrelated.container).queryByRole("button")).toBeNull();
  const proposalId = await finish(), calls = f.harness.inspection.sdk.callsTo("threads.spawn").length;
  await h.behavior.emitRealtime("desk-changed", {});
  fireEvent.click(await within(h.container).findByRole("button", { name: "Proposal" }));
  expect(h.inspection.navigateCalls).toEqual([{ method: "toPluginPanel", path: "desk", options: { subPath: taskProposalPath(task.id, session.id, session.workerThreadId!) } }]);
  const p = page(), review = within(await within(p.container).findByRole("region", { name: "Session proposal" }));
  expect(review.getByText("Record the completed check")).toBeTruthy();
  expect(review.getByRole("button", { name: "Accept changes" })).toBeTruthy();
  await waitFor(() => expect(document.activeElement).toBe(review.getByRole("heading", { name: "Proposal from this session" })));
  fireEvent.click(within(p.container).getByRole("button", { name: "Return to thread" }));
  await waitFor(() => expect(p.inspection.navigateCalls).toContainEqual({ method: "toThread", threadId: session.workerThreadId }));
  expect(f.repo.kernel.getProposal(proposalId).status).toBe("pending");
  expect(f.repo.kernel.getTask(task.id).revision).toBe(task.revision);
  expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(calls);
  const compact = header(f.repo.session(session.id).reviewerThreadId!, true);
  const button = await within(compact.container).findByRole("button", { name: "Proposal" });
  expect(button.textContent).toBe("");
  fireEvent.click(button);
  expect(JSON.stringify(compact.inspection.navigateCalls)).toContain(`/thread/${f.repo.session(session.id).reviewerThreadId}`);
});

it("follows the remaining proposal in place after a partial acceptance and retains the accepted decision", async () => {
  const { f, task, session, page, finish } = await setup();
  const original = await finish(), p = page();
  const region = await within(p.container).findByRole("region", { name: "Session proposal" });
  fireEvent.click(within(region).getByRole("checkbox", { name: "Select part: Record 1: Progress" }));
  fireEvent.click(within(region).getByRole("button", { name: "Accept selected parts · 1" }));
  await waitFor(() => expect(f.repo.session(session.id).proposalId).not.toBe(original));
  const remaining = f.repo.session(session.id).proposalId!;
  await waitFor(() => expect(within(region).queryByRole("checkbox", { name: "Select part: Summary" })).toBeNull());
  expect(within(region).getByRole("checkbox", { name: "Select part: Record 1: Progress" })).toBeTruthy();
  expect(f.repo.kernel.getProposal(remaining).status).toBe("pending");
  fireEvent.click(within(region).getByRole("button", { name: "Accept changes" }));
  await waitFor(() => expect(f.repo.session(session.id).status).toBe("applied"));
  await within(region).findByText("Accepted");
  expect(within(region).queryByRole("button", { name: "Accept changes" })).toBeNull();
  expect(f.repo.kernel.getProposal(original).status).toBe("rejected");
  expect(f.repo.detail(task.id).projection.summary).toBe("The configuration is ready.");
});

it("opens a historical session beyond recent list limits with its records and receipt and rejects mismatched task links", async () => {
  const { f, task, session, page, finish } = await setup();
  const id = await finish();
  await f.harness.behavior.callRpc("accept", { proposalId: id, revision: task.revision });
  const archived = f.repo.session(session.id), update = f.repo.detail(task.id).sessionUpdates[0];
  for (let i = 0; i < 201; i++) {
    const current = f.repo.kernel.getTask(task.id), fact = f.repo.detail(task.id).facts[0];
    const proposal = f.repo.propose({ taskId: task.id, revision: current.revision, requestId: randomUUID(), draft: { rationale: "Later history", confidence: 1, changes: { summary: { value: "Later", evidenceRefs: [fact.id] } } } }, "test");
    f.repo.reject(proposal.id);
    f.repo.db.prepare("UPDATE proposals SET created_at=? WHERE id=?").run("2099-01-01T00:00:00.000Z", proposal.id);
    const later = { ...archived, id: randomUUID(), proposalId: proposal.id, workerThreadId: null, reviewerThreadId: null, updatedAt: "2099-01-01T00:00:00.000Z" };
    f.repo.insertSession(later, f.startInput(task.id, current.revision));
    f.repo.db.prepare("INSERT INTO session_updates VALUES (?,?,?)").run(proposal.id, later.id, JSON.stringify({ ...update, proposalId: proposal.id, sessionId: later.id }));
  }
  const recent = f.repo.detail(task.id);
  expect(recent.sessions.some(s => s.id === session.id)).toBe(false);
  expect(recent.proposals.some(p => p.id === id)).toBe(false);
  expect(recent.sessionUpdates.some(u => u.proposalId === id)).toBe(false);
  const detail = dossierSchema.parse(await f.harness.behavior.callRpc("detail", { id: task.id, sessionId: session.id }));
  expect(detail.sessions.some(s => s.id === session.id)).toBe(true);
  expect(detail.proposals.find(p => p.id === id)?.receipt).not.toBeNull();
  expect(detail.sessionUpdates.find(u => u.proposalId === id)).toEqual(update);
  const p = page(), region = within(await within(p.container).findByRole("region", { name: "Session proposal" }));
  expect(region.getByText("Accepted")).toBeTruthy();
  expect(region.getByText("Dossier records · 1")).toBeTruthy();
  const other = await f.create();
  await expect(f.harness.behavior.callRpc("detail", { id: other.id, sessionId: session.id })).rejects.toThrow(/different task/);
});
