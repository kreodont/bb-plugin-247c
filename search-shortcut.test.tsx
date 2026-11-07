// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, fireEvent, waitFor } from "@testing-library/react";
import { renderSlot, type RenderedSlot, type RenderSlotOptions } from "@get-bb/plugin-sdk/testing/app";
import { SearchShortcut, isSearchShortcut, selectedSearchText } from "./search-shortcut.js";
import { SearchPage, prepareSearch } from "./search-ui.js";
import { NavigationFrame, useNavigationGuard } from "./navigation.js";

const mounts: RenderedSlot[] = [];
afterEach(() => {
  mounts.splice(0).forEach(m => m.lifecycle.unmount());
  window.getSelection()?.removeAllRanges();
  prepareSearch(""); vi.restoreAllMocks();
});
function mount(component: () => React.JSX.Element | null, options: RenderSlotOptions = {}) {
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  const slot = renderSlot({ component }, {}, options); mounts.push(slot); return slot;
}
function shortcut(target: Element = document.body) {
  const event = new KeyboardEvent("keydown", { key: "f", code: "KeyF", metaKey: true, bubbles: true, cancelable: true });
  act(() => { target.dispatchEvent(event); }); return event;
}
function select(node: Node) {
  const range = document.createRange(); range.selectNodeContents(node);
  const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
}
const searchResult = { hits: [], total: 0, nextOffset: null, state: { documents: 0, pending: 0, threads: 0, indexedThreads: 0, unavailableThreads: 0, lastIndexedAt: null } };

it("opens global search from a task chat with selected text and a return-to-thread route", async () => {
  const slot = mount(() => <><SearchShortcut /><div data-thread-window=""><p>BK-812</p></div></>, {
    context: { threadId: "thr_task", projectId: "proj_work" }, settings: { threadProjectId: "proj_work" },
  });
  const text = slot.getByText("BK-812"); select(text);
  expect(shortcut(text).defaultPrevented).toBe(true);
  expect(slot.inspection.navigateCalls).toEqual([{ method: "toPluginPanel", path: "desk", options: { subPath: "search/thread/thr_task" } }]);
  slot.lifecycle.unmount(); mounts.pop();
  const search = mount(() => <SearchPage />, { rpc: { search: () => searchResult } });
  expect((search.getByRole("searchbox") as HTMLInputElement).value).toBe("BK-812");
  await waitFor(() => expect(search.inspection.rpcCalls).toContainEqual({ method: "search", input: { query: "BK-812", scope: "all", status: "all", offset: 0 } }));
  expect(JSON.stringify(localStorage)).not.toContain("BK-812");
});

it("does not capture Find in unrelated chats, and removes its listener on unmount", () => {
  const slot = mount(() => <SearchShortcut />, { context: { threadId: "thr_personal", projectId: "proj_personal" }, settings: { threadProjectId: "proj_work" } });
  expect(shortcut().defaultPrevented).toBe(false);
  expect(slot.inspection.navigateCalls).toEqual([]);
  slot.lifecycle.unmount(); mounts.pop();
  expect(shortcut().defaultPrevented).toBe(false);
});

it.each(["data-app-terminal", "data-app-browser", "data-c247-search-ignore"])("leaves %s Find to its own surface", attribute => {
  const slot = mount(() => <><SearchShortcut /><div {...{ [attribute]: "" }}><input aria-label="Surface input" /></div></>, { context: { threadId: "thr_task", projectId: "proj_work" }, settings: { threadProjectId: "proj_work" } });
  expect(shortcut(slot.getByRole("textbox")).defaultPrevented).toBe(false);
  expect(slot.inspection.navigateCalls).toEqual([]);
});

it("preserves editor and modal shortcuts", () => {
  const slot = mount(() => <><SearchShortcut /><div className="monaco-editor"><textarea /></div><div role="dialog" aria-modal="true">Approval</div></>, { context: { threadId: "thr_task", projectId: "proj_work" }, settings: { threadProjectId: "proj_work" } });
  expect(shortcut(slot.getByRole("textbox")).defaultPrevented).toBe(false);
  expect(shortcut().defaultPrevented).toBe(false);
});

it("respects unsaved-edit guards and focuses Search again without leaving stale filters", async () => {
  const guard = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true), goTo = vi.fn();
  function Content() { useNavigationGuard(guard); return <SearchPage />; }
  prepareSearch("existing query");
  const slot = mount(() => <><SearchShortcut /><NavigationFrame subPath="search" goTo={goTo}><Content /></NavigationFrame></>, { rpc: { search: () => searchResult } });
  const input = slot.getByRole("searchbox") as HTMLInputElement;
  const filter = slot.getByRole("combobox", { name: "Search in" });
  fireEvent.change(filter, { target: { value: "messages" } }); filter.focus();
  shortcut(filter);
  await waitFor(() => expect(guard).toHaveBeenCalledOnce());
  expect(goTo).not.toHaveBeenCalled();
  await waitFor(() => expect(slot.getByRole("button", { name: "Tasks" }).hasAttribute("disabled")).toBe(false));
  shortcut(filter);
  await waitFor(() => expect(goTo).toHaveBeenCalledWith("search"));
  expect(document.activeElement).toBe(input);
  expect(input.value).toBe("existing query");
  expect((filter as HTMLSelectElement).value).toBe("all");
  const text = slot.getByText("Tasks, dossier history and conversations, including closed tasks.");
  select(text); shortcut(text);
  await waitFor(() => expect(input.value).toBe(text.textContent));
  expect(document.activeElement).toBe(input);
  expect(input.selectionStart).toBe(0); expect(input.selectionEnd).toBe(input.value.length);
});

it("uses the focused split's thread rather than another pane's route or project", () => {
  const slot = mount(() => <><SearchShortcut /><div data-split-pane-id="other"><input /></div></>, {
    context: { threadId: "thr_task", projectId: "proj_work" }, settings: { threadProjectId: "proj_work" },
    sidebarSplitLayout: { panes: [
      { paneId: "task", threadId: "thr_task", isFocused: false, rect: { x: 0, y: 0, width: .5, height: 1 } },
      { paneId: "other", threadId: "thr_personal", isFocused: true, rect: { x: .5, y: 0, width: .5, height: 1 } },
    ] },
  });
  expect(shortcut(slot.getByRole("textbox")).defaultPrevented).toBe(false);
  expect(shortcut().defaultPrevented).toBe(false);
  expect(slot.inspection.navigateCalls).toEqual([]);
});

it("supports Russian keyboard layout and Ctrl+F on Windows, without hijacking modified shortcuts", () => {
  expect(isSearchShortcut(new KeyboardEvent("keydown", { key: "а", code: "KeyF", metaKey: true }), "MacIntel")).toBe(true);
  expect(isSearchShortcut(new KeyboardEvent("keydown", { key: "f", ctrlKey: true }), "Win32")).toBe(true);
  expect(isSearchShortcut(new KeyboardEvent("keydown", { key: "f", ctrlKey: true }), "MacIntel")).toBe(false);
  expect(isSearchShortcut(new KeyboardEvent("keydown", { key: "f", metaKey: true, shiftKey: true }), "MacIntel")).toBe(false);
});

it("reads only selected input text, caps the query and never reads password text", () => {
  const input = document.createElement("input"); input.value = "prefix BK-812 suffix"; input.setSelectionRange(7, 13);
  expect(selectedSearchText(input)).toBe("BK-812");
  input.setSelectionRange(0, 0); expect(selectedSearchText(input)).toBeUndefined();
  input.value = "x".repeat(500); input.select(); expect(selectedSearchText(input)).toHaveLength(300);
  input.type = "password"; input.select(); expect(selectedSearchText(input)).toBeUndefined();
});
