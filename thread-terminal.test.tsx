// @vitest-environment jsdom
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { act, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot, type CapturedPluginApp, type RenderedSlot } from "@get-bb/plugin-sdk/testing/app";
import { toast } from "sonner";

let app: CapturedPluginApp;
const mounts: RenderedSlot[] = [];
beforeAll(async () => { app = await loadPluginApp(() => import("./app.js")); }, 60000);
afterEach(() => { mounts.splice(0).forEach(slot => slot.lifecycle.unmount()); vi.restoreAllMocks(); });
function terminal(id: string, threadId: string, status: "running" | "exited" = "running") {
  return { id, threadId, title: "247C · Terminal", status, hostId: "host_test", environmentId: "env_test", initialCwd: "/workspace",
    cols: 100, rows: 30, createdAt: 1, updatedAt: 1, lastUserInputAt: null, exitCode: null, closeReason: null };
}
function mount(threadId: string, options: Parameters<typeof renderSlot>[2], compact = false) {
  const slot = renderSlot(app.threadHeaderActions.find(action => action.id === "terminal")!,
    { threadId, projectId: "proj_test", isCompactViewport: compact }, options);
  mounts.push(slot); return slot;
}

it("replaces the header switcher and creates, reopens and replaces an exited terminal in the exact thread scope", async () => {
  const sessions = [terminal("unrelated", "thread_other")];
  const create = vi.fn(async () => { const item = terminal(`term_${sessions.length}`, "thread_work"); sessions.push(item); return item; });
  const list = vi.fn(async () => ({ sessions }));
  const slot = mount("thread_work", { sdk: { terminals: { list, create } }, openTerminal: () => true });
  expect(app.threadHeaderActions.some(action => action.id === "switch")).toBe(false);
  const button = within(slot.container).getByRole("button", { name: "Open terminal" });
  expect(button.textContent).toBe("Terminal");
  fireEvent.click(button);
  await waitFor(() => expect(slot.inspection.navigateCalls).toEqual([{ method: "experimental_openTerminal", options: { terminalId: "term_1" } }]));
  expect(list).toHaveBeenCalledWith({ scope: { kind: "thread", threadId: "thread_work" } });
  expect(create).toHaveBeenCalledWith({ scope: { kind: "thread", threadId: "thread_work" }, cols: 100, rows: 30, title: "247C · Terminal", start: { mode: "shell" } });
  fireEvent.click(button);
  await waitFor(() => expect(slot.inspection.navigateCalls).toHaveLength(2));
  expect(create).toHaveBeenCalledTimes(1);
  sessions[1].status = "exited";
  fireEvent.click(button);
  await waitFor(() => expect(slot.inspection.navigateCalls).toContainEqual({ method: "experimental_openTerminal", options: { terminalId: "term_2" } }));
  expect(create).toHaveBeenCalledTimes(2);
});

it("deduplicates rapid clicks and remounts without opening a stale panel after navigating away", async () => {
  let resolve!: (value: ReturnType<typeof terminal>) => void;
  const result = new Promise<ReturnType<typeof terminal>>(done => { resolve = done; });
  const create = vi.fn(() => result), list = vi.fn(async () => ({ sessions: [] }));
  const options = { sdk: { terminals: { list, create } }, openTerminal: () => true };
  const first = mount("thread_pending", options);
  const button = within(first.container).getByRole("button", { name: "Open terminal" });
  fireEvent.click(button); fireEvent.click(button);
  await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
  first.lifecycle.unmount(); mounts.splice(mounts.indexOf(first), 1);
  const second = mount("thread_pending", options, true);
  const compact = within(second.container).getByRole("button", { name: "Open terminal" });
  expect(compact.textContent).toBe("");
  fireEvent.click(compact);
  await act(async () => { resolve(terminal("pending_term", "thread_pending")); await result; });
  await waitFor(() => expect(second.inspection.navigateCalls).toHaveLength(1));
  expect(first.inspection.navigateCalls).toEqual([]);
  expect(create).toHaveBeenCalledTimes(1);
});

it("reports open failures and lets a retry reuse the created shell", async () => {
  const errors = vi.spyOn(toast, "error").mockImplementation(() => "toast");
  const sessions: ReturnType<typeof terminal>[] = [];
  const create = vi.fn(async () => { const item = terminal("retry_term", "thread_retry"); sessions.push(item); return item; });
  const list = vi.fn(async () => ({ sessions }));
  const openTerminal = vi.fn().mockReturnValueOnce(false).mockReturnValue(true);
  const slot = mount("thread_retry", { sdk: { terminals: { list, create } }, openTerminal });
  const button = within(slot.container).getByRole("button", { name: "Open terminal" });
  fireEvent.click(button);
  await waitFor(() => expect(errors).toHaveBeenCalledWith("Could not open terminal", { description: expect.stringContaining("could not be shown") }));
  fireEvent.click(button);
  await waitFor(() => expect(openTerminal).toHaveBeenCalledTimes(2));
  expect(create).toHaveBeenCalledTimes(1);
});
