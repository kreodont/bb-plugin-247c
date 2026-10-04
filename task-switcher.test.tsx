// @vitest-environment jsdom
import { afterEach, beforeAll, expect, it } from "vitest";
import { fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot, type CapturedPluginApp, type RenderedSlot } from "@get-bb/plugin-sdk/testing/app";
import { switcherTasks } from "./task-switch-order.js";
import { fixture } from "./test-support.js";
import { rpcContract, type TaskCard } from "./contracts.js";

let app: CapturedPluginApp;
const mounts: RenderedSlot[] = [], hosts: Awaited<ReturnType<typeof fixture>>[] = [];
beforeAll(async () => { app = await loadPluginApp(() => import("./app.js")); }, 60000);
afterEach(async () => { mounts.splice(0).forEach(m => m.lifecycle.unmount()); for (const f of hosts.splice(0)) await f.harness.lifecycle.dispose(); localStorage.clear(); });

const card = (id: string, title: string, updatedAt: string, extra: Partial<TaskCard> = {}) =>
  ({ id, title, status: "open", updatedAt, pendingCount: 0, activeThreadId: null, customer: null, ...extra }) as TaskCard;

it("lists open chats first by recent update, then other open tasks, and filters by title or customer", () => {
  const tasks = [
    card("a", "Billing schedule", "2026-10-01T10:00:00Z"),
    card("b", "Deploy report", "2026-10-03T10:00:00Z", { activeThreadId: "thr_b" }),
    card("c", "Old chat", "2026-09-24T10:00:00Z", { activeThreadId: "thr_c" }),
    card("d", "Closed work", "2026-10-04T10:00:00Z", { status: "done" }),
    card("e", "Waiting reply", "2026-10-02T10:00:00Z", { status: "waiting", customer: "Acme" }),
  ];
  expect(switcherTasks(tasks, "").map(t => t.id)).toEqual(["b", "c", "e", "a"]);
  expect(switcherTasks(tasks, "acme").map(t => t.id)).toEqual(["e"]);
  expect(switcherTasks(tasks, "  chat OLD ").map(t => t.id)).toEqual(["c"]);
});

it("opens from the thread header, jumps to an open chat with the keyboard, and starts a chat for a task without one", async () => {
  const f = await fixture({ settings: { threadProjectId: "proj_tasks", composerDefaults: JSON.stringify({ providerId: "claude-work", model: "claude-opus-5[1m]" }) } }); hosts.push(f);
  f.harness.inspection.sdk.stub("projects.get", () => ({ id: "proj_tasks", kind: "standard", sources: [{ type: "local_path", hostId: "host_test", path: "/work", isDefault: true }] }));
  const create = async (title: string) => await f.harness.behavior.callRpc("create", { title, description: "Context", requestId: crypto.randomUUID() }) as TaskCard;
  const withChat = await create("Deploy report"), withoutChat = await create("Billing schedule");
  const rpc = Object.fromEntries(Object.keys(rpcContract).map(name => [name, (input: unknown) => f.harness.behavior.callRpc(name, input)]));
  const opened = await f.harness.behavior.callRpc("openChat", { taskId: withChat.id, requestId: crypto.randomUUID() }) as { workerThreadId: string };
  const overlay = renderSlot(app.appOverlays.find(s => s.id === "task-switcher")!, {}, { rpc, context: { threadId: "thr_elsewhere" } }); mounts.push(overlay);
  const header = renderSlot(app.threadHeaderActions.find(s => s.id === "switch")!, { threadId: "thr_elsewhere", isCompactViewport: false, projectId: "proj_personal" }, { rpc }); mounts.push(header);

  fireEvent.click(within(header.container).getByRole("button", { name: "Switch task" }));
  const list = await within(document.body).findByRole("listbox", { name: "Open tasks" });
  await waitFor(() => expect(within(list).getAllByRole("option")).toHaveLength(2));
  expect(within(list).getAllByRole("option")[0].textContent).toContain("Deploy report");
  fireEvent.keyDown(within(document.body).getByRole("textbox", { name: "Filter tasks" }), { key: "Enter" });
  await waitFor(() => expect(overlay.inspection.navigateCalls).toContainEqual({ method: "toThread", threadId: opened.workerThreadId }));

  fireEvent.click(within(header.container).getByRole("button", { name: "Switch task" }));
  const filter = await within(document.body).findByRole("textbox", { name: "Filter tasks" });
  fireEvent.change(filter, { target: { value: "billing" } });
  await waitFor(() => expect(within(document.body).getAllByRole("option")).toHaveLength(1));
  fireEvent.keyDown(filter, { key: "Enter" });
  await waitFor(() => expect(f.repo.list().tasks.find(t => t.id === withoutChat.id)?.activeThreadId).toBeTruthy());
  const started = f.repo.list().tasks.find(t => t.id === withoutChat.id)!.activeThreadId!;
  await waitFor(() => expect(overlay.inspection.navigateCalls).toContainEqual({ method: "toThread", threadId: started }));
});
