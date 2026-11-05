// @vitest-environment jsdom
import { afterEach, beforeAll, expect, it } from "vitest";
import { fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot, type CapturedPluginApp, type RenderedSlot } from "@get-bb/plugin-sdk/testing/app";
import { fixture } from "./test-support.js";
import { rpcContract, sessionSchema } from "./contracts.js";
let app: CapturedPluginApp;
const mounts: RenderedSlot[] = [], hosts: Awaited<ReturnType<typeof fixture>>[] = [];
beforeAll(async () => { app = await loadPluginApp(() => import("./app.js")); }, 60000);
afterEach(async () => { for (const m of mounts.splice(0)) m.lifecycle.unmount(); for (const f of hosts.splice(0)) await f.harness.lifecycle.dispose(); });
async function setup() {
  const f = await fixture(); hosts.push(f);
  const rpc = Object.fromEntries(Object.keys(rpcContract).map(name => [name, (input: unknown) => f.harness.behavior.callRpc(name, input)]));
  return { f, rpc };
}
it("enables automatic work from its page and exposes a persistent off switch", async () => {
  const { f, rpc } = await setup(), slot = renderSlot(app.navPanels[0], { subPath: "automatic" }, { rpc }); mounts.push(slot);
  const enable = await slot.findByRole("button", { name: "Turn on" });
  await waitFor(() => expect((enable as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(enable);
  await slot.findByRole("button", { name: "Turn off" });
  expect(await f.harness.behavior.callRpc("automationState", {})).toMatchObject({ enabled: true });
  fireEvent.click(slot.getByRole("button", { name: "Turn off" }));
  await slot.findByRole("button", { name: "Turn on" });
  expect(await f.harness.behavior.callRpc("automationState", {})).toMatchObject({ enabled: false });
});
it("pauses from the worker header in one click and hides the action during review", async () => {
  const { f, rpc } = await setup(), task = await f.create();
  const session = sessionSchema.parse(await f.harness.behavior.callRpc("start", { ...f.startInput(task.id, task.revision), criteria: [] }));
  await f.idle(session.workerThreadId!, "Investigated the issue and saved the local findings.");
  const slot = renderSlot(app.threadHeaderActions.find(action => action.id === "pause")!, { threadId: session.workerThreadId!, projectId: "proj_personal", isCompactViewport: false }, { rpc }); mounts.push(slot);
  fireEvent.click(await slot.findByRole("button", { name: "Pause session" }));
  await waitFor(() => expect(f.repo.session(session.id).status).toBe("reviewing"));
  await waitFor(() => expect(slot.queryByRole("button", { name: "Pause session" })).toBeNull());
  expect(f.repo.kernel.getTask(task.id).status).toBe("open");
  expect(await f.harness.behavior.callRpc("automationState", {})).toMatchObject({ paused: [{ taskId: task.id }] });
});

it("shows a ready session as waiting for the user to finish", async () => {
  const { f, rpc } = await setup(), task = await f.create();
  await f.harness.behavior.callRpc("automationSet", { enabled: true });
  const session = sessionSchema.parse(await f.harness.behavior.callRpc("start", { ...f.startInput(task.id, task.revision), criteria: [] }));
  f.repo.saveSession({ ...session, automation: { state: "ready", outcome: "done", note: "The work is ready." } });
  const slot = renderSlot(app.navPanels[0], { subPath: "automatic" }, { rpc }); mounts.push(slot);
  await slot.findByText(/Ready for you to finish/);
  expect(slot.queryByText(/^Finishing/)).toBeNull();
  expect(slot.getByText(/Sessions stay open until you choose Finish session or Pause session/)).toBeTruthy();
});
