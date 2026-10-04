// @vitest-environment jsdom
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot, type CapturedPluginApp, type RenderedSlot } from "@get-bb/plugin-sdk/testing/app";
import { fixture } from "./test-support.js";
import { rpcContract, sessionSchema } from "./contracts.js";

let app: CapturedPluginApp;
const mounts: RenderedSlot[] = [], hosts: Awaited<ReturnType<typeof fixture>>[] = [];
beforeAll(async () => { app = await loadPluginApp(() => import("./app.js")); }, 60000);
afterEach(async () => { mounts.splice(0).forEach(m => m.lifecycle.unmount()); for (const f of hosts.splice(0)) await f.harness.lifecycle.dispose(); vi.restoreAllMocks(); });
async function setup(compact = false) {
  const f = await fixture(); hosts.push(f);
  const task = await f.create();
  const session = sessionSchema.parse(await f.harness.behavior.callRpc("start", { ...f.startInput(task.id, task.revision), criteria: [] }));
  const rpc = Object.fromEntries(Object.keys(rpcContract).map(name => [name, (input: unknown) => f.harness.behavior.callRpc(name, input)]));
  function mount(threadId = session.workerThreadId!) {
    const slot = renderSlot(app.threadHeaderActions.find(s => s.id === "session")!, { threadId, projectId: "proj_personal", isCompactViewport: compact }, { rpc }); mounts.push(slot); return slot;
  }
  const header = mount();
  await header.findByRole("button", { name: "Finish session" });
  return { f, task, session, header, mount };
}

it.each([false, true])("opens the recorder from the original chat without sending work, then hides on completion (compact=%s)", async compact => {
  const { f, session, header, mount } = await setup(compact);
  fireEvent.click(header.getByRole("button", { name: "Finish session" }));
  const button = await header.findByRole("button", { name: "Open review" });
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  const reviewer = f.repo.session(session.id).reviewerThreadId!;
  expect(button.textContent).toBe(compact ? "" : "Open review");
  fireEvent.click(button);
  await waitFor(() => expect(header.inspection.navigateCalls).toEqual([{ method: "toThread", threadId: reviewer }]));
  expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(2);
  expect(f.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
  expect(f.repo.session(session.id).status).toBe("reviewing");
  const reviewHeader = mount(reviewer), unrelated = mount("unrelated");
  await reviewHeader.behavior.emitRealtime("desk-changed", {});
  await unrelated.behavior.emitRealtime("desk-changed", {});
  expect(within(reviewHeader.container).queryByRole("button")).toBeNull();
  expect(within(unrelated.container).queryByRole("button")).toBeNull();
  await f.idle(reviewer, { rationale: "No new records", facts: [], changes: null, knowledge: [] });
  await header.behavior.emitRealtime("desk-changed", {});
  await waitFor(() => expect(within(header.container).queryByRole("button")).toBeNull());
});

it("shows preparation during repair and resolves a newer recorder even before the next UI refresh", async () => {
  const { f, session, header } = await setup();
  await f.harness.behavior.callRpc("finish", { sessionId: session.id });
  await header.behavior.emitRealtime("desk-changed", {});
  await header.findByRole("button", { name: "Open review" });
  const old = f.repo.session(session.id).reviewerThreadId!;
  await f.idle(old, "Invalid extraction");
  expect(f.repo.session(session.id).status).toBe("collecting");
  await header.behavior.emitRealtime("desk-changed", {});
  const preparing = await header.findByRole("button", { name: "Starting review…" });
  expect((preparing as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(preparing);
  expect(header.inspection.navigateCalls).toHaveLength(0);
  await f.harness.behavior.emitThreadEvent("thread.idle", { thread: f.threads.get(session.workerThreadId!)!, lastAssistantText: null });
  await header.behavior.setRealtimeConnectionState("connected");
  await header.behavior.emitRealtime("desk-changed", {});
  const button = await header.findByRole("button", { name: "Open review" });
  const replacement = f.repo.session(session.id).reviewerThreadId!;
  expect(replacement).not.toBe(old);
  // A further retry finishes its launch before the UI receives its event.
  f.repo.saveSession({ ...f.repo.session(session.id), status: "blocked", error: "Retry requested" });
  await f.harness.behavior.callRpc("retry", { sessionId: session.id });
  const latest = f.repo.session(session.id).reviewerThreadId!;
  expect(latest).not.toBe(replacement);
  const spawns = f.harness.inspection.sdk.callsTo("threads.spawn").length;
  fireEvent.click(button);
  await waitFor(() => expect(header.inspection.navigateCalls).toEqual([{ method: "toThread", threadId: latest }]));
  expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(spawns);
});

it("does not navigate to a finished or cancelled review from an outdated header", async () => {
  const { f, session, header } = await setup();
  await f.harness.behavior.callRpc("finish", { sessionId: session.id });
  await header.behavior.emitRealtime("desk-changed", {});
  const button = await header.findByRole("button", { name: "Open review" });
  await f.harness.behavior.callRpc("cancel", { sessionId: session.id });
  fireEvent.click(button);
  await waitFor(() => expect(within(header.container).queryByRole("button")).toBeNull());
  expect(header.inspection.navigateCalls).toHaveLength(0);
});

it("does not redirect after leaving the original thread while its link is being resolved", async () => {
  const { f, session, header } = await setup();
  await f.harness.behavior.callRpc("finish", { sessionId: session.id });
  await header.behavior.emitRealtime("desk-changed", {});
  const button = await header.findByRole("button", { name: "Open review" });
  const call = f.harness.behavior.callRpc.bind(f.harness.behavior);
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  vi.spyOn(f.harness.behavior, "callRpc").mockImplementation(async (name, input) => { if (name === "threadSession") await pending; return call(name, input); });
  fireEvent.click(button);
  header.lifecycle.unmount(); mounts.splice(mounts.indexOf(header), 1);
  release();
  await call("threadSession", { threadId: session.workerThreadId! });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(header.inspection.navigateCalls).toHaveLength(0);
});
