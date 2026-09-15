// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { NavigationFrame, useNavigationGuard } from "./navigation.js";

const originalNavigation = Object.getOwnPropertyDescriptor(window, "navigation");
afterEach(() => {
  cleanup(); vi.restoreAllMocks();
  if (originalNavigation) Object.defineProperty(window, "navigation", originalNavigation);
  else Reflect.deleteProperty(window, "navigation");
});
function nativeNavigation(back = true, forward = true) {
  const navigation = Object.assign(new EventTarget(), { canGoBack: back, canGoForward: forward });
  Object.defineProperty(window, "navigation", { configurable: true, value: navigation });
  return navigation;
}
function Guard({ check }: { check: () => boolean | Promise<boolean> }) {
  useNavigationGuard(check); return <p>Current page</p>;
}

it("returns directly to the originating thread after all saves even without browser history", async () => {
  nativeNavigation(false, false);
  const order: string[] = [];
  const view = render(<NavigationFrame subPath="day/example/thread/thr_original" returnToThread={() => { order.push("thread"); }}><Guard check={async () => { order.push("save"); return true; }} /></NavigationFrame>);
  fireEvent.click(view.getByRole("button", { name: "Return to thread" }));
  await waitFor(() => expect(order).toEqual(["save", "thread"]));
});

it("uses native back and forward and updates button availability at history boundaries", () => {
  const navigation = nativeNavigation(false, false);
  const back = vi.spyOn(window.history, "back").mockImplementation(() => {});
  const forward = vi.spyOn(window.history, "forward").mockImplementation(() => {});
  const view = render(<NavigationFrame subPath=""><p>Tasks</p></NavigationFrame>);
  const previous = view.getByRole("button", { name: "Back" }) as HTMLButtonElement;
  const next = view.getByRole("button", { name: "Forward" }) as HTMLButtonElement;
  expect(previous.disabled).toBe(true); expect(next.disabled).toBe(true);
  act(() => { navigation.canGoBack = true; navigation.dispatchEvent(new Event("currententrychange")); });
  fireEvent.click(previous); expect(back).toHaveBeenCalledOnce(); expect(forward).not.toHaveBeenCalled();
  act(() => { navigation.canGoBack = false; navigation.canGoForward = true; navigation.dispatchEvent(new Event("currententrychange")); });
  expect(previous.disabled).toBe(true); expect(next.disabled).toBe(false);
  fireEvent.click(next); expect(forward).toHaveBeenCalledOnce();
});

it("traverses actual browser entries without rewriting them when Navigation API is absent", async () => {
  Object.defineProperty(window, "navigation", { configurable: true, value: undefined });
  const original = window.location.href;
  window.history.pushState({ retained: "thread" }, "", "/threads/example");
  window.history.pushState({ retained: "task" }, "", "/plugins/247c/desk/example");
  const view = render(<NavigationFrame subPath="example"><p>Task</p></NavigationFrame>);
  fireEvent.click(view.getByRole("button", { name: "Back" }));
  await waitFor(() => expect(window.location.pathname).toBe("/threads/example"));
  expect(window.history.state).toEqual({ retained: "thread" });
  fireEvent.click(view.getByRole("button", { name: "Forward" }));
  await waitFor(() => expect(window.location.pathname).toBe("/plugins/247c/desk/example"));
  expect(window.history.state).toEqual({ retained: "task" });
  window.history.replaceState(null, "", original);
});

it("waits for pending edits, ignores duplicate clicks and lets a failed save be retried", async () => {
  nativeNavigation();
  const back = vi.spyOn(window.history, "back").mockImplementation(() => {});
  const forward = vi.spyOn(window.history, "forward").mockImplementation(() => {});
  let finish!: (ok: boolean) => void;
  const check = vi.fn<() => Promise<boolean>>().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue(true);
  const view = render(<NavigationFrame subPath="day/2026-09-10"><Guard check={check} /></NavigationFrame>);
  fireEvent.click(view.getByRole("button", { name: "Back" }));
  fireEvent.click(view.getByRole("button", { name: "Forward" }));
  expect(check).toHaveBeenCalledOnce(); expect(back).not.toHaveBeenCalled(); expect(forward).not.toHaveBeenCalled();
  expect(view.getByRole("status").textContent).toBe("Saving before navigation…");
  await act(async () => finish(false));
  expect(back).not.toHaveBeenCalled();
  fireEvent.click(view.getByRole("button", { name: "Back" }));
  await waitFor(() => expect(back).toHaveBeenCalledOnce());
});

it("does not navigate from a different page when an old save finishes", async () => {
  nativeNavigation();
  const back = vi.spyOn(window.history, "back").mockImplementation(() => {});
  let finish!: (ok: boolean) => void;
  const check = () => new Promise<boolean>(resolve => { finish = resolve; });
  const view = render(<NavigationFrame subPath="day/2026-09-10"><Guard check={check} /></NavigationFrame>);
  fireEvent.click(view.getByRole("button", { name: "Back" }));
  view.rerender(<NavigationFrame subPath="proposals"><p>Proposals</p></NavigationFrame>);
  await act(async () => finish(true));
  expect(back).not.toHaveBeenCalled();
});

it("removes history listeners and cancels deferred navigation when the page unmounts", async () => {
  const navigation = nativeNavigation();
  const remove = vi.spyOn(navigation, "removeEventListener");
  const removeWindow = vi.spyOn(window, "removeEventListener");
  const back = vi.spyOn(window.history, "back").mockImplementation(() => {});
  let finish!: (ok: boolean) => void;
  const view = render(<NavigationFrame subPath="day"><Guard check={() => new Promise(resolve => { finish = resolve; })} /></NavigationFrame>);
  fireEvent.click(view.getByRole("button", { name: "Back" })); view.unmount();
  await act(async () => finish(true));
  expect(back).not.toHaveBeenCalled();
  expect(remove).toHaveBeenCalledWith("currententrychange", expect.any(Function));
  expect(removeWindow).toHaveBeenCalledWith("popstate", expect.any(Function));
  expect(removeWindow).toHaveBeenCalledWith("pageshow", expect.any(Function));
});

it("reports an unexpected save error without traversing history", async () => {
  nativeNavigation();
  const forward = vi.spyOn(window.history, "forward").mockImplementation(() => {});
  const view = render(<NavigationFrame subPath="day"><Guard check={async () => { throw new Error("Save is unavailable"); }} /></NavigationFrame>);
  fireEvent.click(view.getByRole("button", { name: "Forward" }));
  expect((await view.findByRole("alert")).textContent).toBe("Save is unavailable");
  expect(forward).not.toHaveBeenCalled();
  expect((view.getByRole("button", { name: "Forward" }) as HTMLButtonElement).disabled).toBe(false);
});
