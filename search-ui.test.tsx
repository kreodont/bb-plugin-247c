// @vitest-environment jsdom
import { afterEach, beforeAll, expect, it } from "vitest";
import { fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot, type CapturedPluginApp, type RenderedSlot } from "@get-bb/plugin-sdk/testing/app";
import { fixture } from "./test-support.js";
import { rpcContract } from "./contracts.js";
import { TaskSearch } from "./search-index.js";
import { prepareSearch } from "./search-ui.js";
let app: CapturedPluginApp;
const hosts: Awaited<ReturnType<typeof fixture>>[] = [], mounts: RenderedSlot[] = [];
beforeAll(async () => { app = await loadPluginApp(() => import("./app.js")); }, 60000);
afterEach(async () => { mounts.splice(0).forEach(m => m.lifecycle.unmount()); for (const f of hosts.splice(0)) await f.harness.lifecycle.dispose(); prepareSearch(""); });
async function setup(path = "search/thread/thr_origin") {
  const f = await fixture(); hosts.push(f);
  const rpc = Object.fromEntries(Object.keys(rpcContract).map(name => [name, (input: unknown) => f.harness.behavior.callRpc(name, input)]));
  const slot = renderSlot(app.navPanels[0], { subPath: path }, { rpc }); mounts.push(slot);
  return { f, slot };
}
it("searches old conversation text, highlights safely and offers task, chat and exact message navigation", async () => {
  prepareSearch("Malachite");
  const { f, slot } = await setup();
  const task = await f.create(), session = await f.start(task.id, task.revision);
  f.message(session.workerThreadId!, "assistant", 'Malachite <img src=x onerror="danger()">');
  const index = new TaskSearch(f.repo, f.bb, () => {}); await index.refresh(new AbortController().signal);
  await slot.behavior.emitRealtime("search-changed", {});
  const article = await waitFor(() => { const a = slot.container.querySelector("article"); expect(a).not.toBeNull(); return within(a! as HTMLElement); });
  expect(slot.container.querySelector('article')?.textContent).toContain('<img src=x onerror="danger()">');
  expect(slot.container.querySelector("img")).toBeNull();
  expect(slot.container.querySelector("mark")?.textContent).toBe("Malachite");
  expect(article.getByRole("button", { name: "Open message" })).toBeTruthy();
  fireEvent.click(article.getByRole("button", { name: "Open task" }));
  fireEvent.click(article.getByRole("button", { name: "Open chat" }));
  expect(slot.inspection.navigateCalls).toContainEqual({ method: "toPluginPanel", path: "desk", options: { subPath: `${task.id}/thread/thr_origin` } });
  expect(slot.inspection.navigateCalls).toContainEqual({ method: "toThread", threadId: session.workerThreadId });
  expect(f.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
});
it("opens global search from the task filter without putting search text in navigation or browser storage", async () => {
  const { slot } = await setup("tasks");
  const input = await slot.findByRole("textbox", { name: "Find a task" });
  fireEvent.change(input, { target: { value: "private query" } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(slot.inspection.navigateCalls).toContainEqual({ method: "toPluginPanel", path: "desk", options: { subPath: "search" } });
  expect(JSON.stringify(localStorage)).not.toContain("private query");
});

it("shows temporary failures but removes the warning and retry control for a confirmed missing chat", async () => {
  const { f, slot } = await setup();
  const task = await f.create(); await f.start(task.id, task.revision);
  const index = new TaskSearch(f.repo, f.bb, () => {});
  f.harness.inspection.sdk.stub("threads.timeline", () => { throw new Error("Request timed out"); });
  await index.refresh(new AbortController().signal); await slot.behavior.emitRealtime("search-changed", {});
  expect(await slot.findByText(/1 chat could not be read/)).toBeTruthy();
  expect(slot.getByRole("button", { name: "Retry indexing" })).toBeTruthy();
  f.harness.inspection.sdk.stub("threads.timeline", () => { throw new Error("HTTP 404: Thread not found"); });
  index.retry(); await index.refresh(new AbortController().signal); await slot.behavior.emitRealtime("search-changed", {});
  await waitFor(() => expect(slot.queryByText(/could not be read/)).toBeNull());
  expect(slot.queryByRole("button", { name: "Retry indexing" })).toBeNull();
  expect(slot.getByText(/0\/0 chats checked/)).toBeTruthy();
});
