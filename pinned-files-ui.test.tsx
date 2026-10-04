// @vitest-environment jsdom
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot, type CapturedPluginApp, type RenderedSlot } from "@get-bb/plugin-sdk/testing/app";
import { UxCollector } from "./ux-client.js";
import { UX_BUILD } from "./ux-contracts.js";

let app: CapturedPluginApp;
const mounts: RenderedSlot[] = [];
let collector: UxCollector | undefined;
beforeAll(async () => { app = await loadPluginApp(() => import("./app.js")); }, 60000);
afterEach(() => { collector?.dispose(); collector = undefined; mounts.splice(0).forEach(m => m.lifecycle.unmount()); vi.restoreAllMocks(); });
const file = { id: "fc6f91af-04be-4a17-8e66-2c758e26ef38", name: "Private notes", path: "/private/notes.json", hostId: "host_local" };
function mount(compact = false, accepted: () => boolean = () => true) {
  let files = [file];
  const slot = renderSlot(app.threadHeaderActions.find(s => s.id === "pinned-files")!, { threadId: "thr_unrelated", projectId: "proj_other", isCompactViewport: compact }, {
    rpc: {
      pinnedFiles: () => ({ files }),
      unpinFile: () => { files = []; return { files }; },
      pinFile: (input) => { files = [{ ...file, ...(input as { name: string; path: string }) }]; return { files }; },
    },
    openFilePreview: accepted,
  });
  mounts.push(slot); return slot;
}

it.each([false, true])("opens from an unrelated thread through the host preview with no content RPC (compact=%s)", async compact => {
  const slot = mount(compact);
  const trigger = within(slot.container).getByRole("button", { name: "Pinned files" });
  expect(trigger.textContent).toBe(compact ? "" : "Pinned files");
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  const send = vi.fn().mockResolvedValue({ reason: "saved" });
  collector = new UxCollector(send, () => {}, false);
  collector.update({ enabled: true, recordingId: crypto.randomUUID(), endsAt: Date.now() + 60000, storageAvailable: true, retentionDays: 7, bytes: 0, build: UX_BUILD });
  fireEvent.click(trigger);
  const open = await within(document.body).findByRole("button", { name: "Open Private notes" });
  const calls = slot.inspection.rpcCalls.length;
  fireEvent.click(open);
  await waitFor(() => expect(within(document.body).queryByRole("dialog")).toBeNull());
  expect(slot.inspection.navigateCalls).toEqual([{ method: "experimental_openFilePreview", options: { target: { kind: "host", hostId: "host_local", path: file.path }, location: null } }]);
  expect(slot.inspection.rpcCalls).toHaveLength(calls);
  await collector.flush(); expect(send).not.toHaveBeenCalled();
  expect(slot.inspection.composer.text).toBe("");
});

it("supports adding and removing shortcuts without task or file mutation RPCs", async () => {
  const slot = mount();
  fireEvent.click(within(slot.container).getByRole("button", { name: "Pinned files" }));
  fireEvent.click(await within(document.body).findByRole("button", { name: "Unpin Private notes" }));
  await within(document.body).findByText("No pinned files yet.");
  fireEvent.click(within(document.body).getByRole("button", { name: "Pin a file" }));
  fireEvent.change(within(document.body).getByRole("textbox", { name: "File path" }), { target: { value: "/notes/today.md" } });
  fireEvent.click(within(document.body).getByRole("button", { name: "Pin file" }));
  await within(document.body).findByRole("button", { name: "Open today.md" });
  expect(slot.inspection.rpcCalls.map(call => call.method)).toEqual(["pinnedFiles", "unpinFile", "pinFile"]);
  expect(slot.inspection.navigateCalls).toHaveLength(0);
});

it("keeps the list open and suppresses private host error payloads when opening fails", async () => {
  const slot = mount(false, () => { throw new Error("PRIVATE_HOST_ERROR_CONTENT"); });
  fireEvent.click(within(slot.container).getByRole("button", { name: "Pinned files" }));
  fireEvent.click(await within(document.body).findByRole("button", { name: "Open Private notes" }));
  expect(within(document.body).getByRole("alert").textContent).toContain("Could not open the file panel");
  expect(document.body.textContent).not.toContain("PRIVATE_HOST_ERROR_CONTENT");
  expect(within(document.body).getByRole("dialog")).toBeTruthy();
});
