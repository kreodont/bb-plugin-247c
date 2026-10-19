import { expect, it, vi } from "vitest";
import { openSearchMessage } from "./search-navigation.js";
it("waits for host routing and applies only the native message fragment", async () => {
  const location = { pathname: "/plugins/247c/desk/search", replace: vi.fn() };
  const navigate = { toThread: vi.fn() };
  const wait = vi.fn(async () => { location.pathname = "/projects/project/threads/thr_target"; });
  await openSearchMessage("thr_target", 1276, navigate, location, wait);
  expect(navigate.toThread).toHaveBeenCalledWith("thr_target");
  expect(wait).toHaveBeenCalledOnce();
  expect(location.replace).toHaveBeenCalledWith("#msg=1276");
});
it("never changes the fragment of another chat if navigation fails", async () => {
  const location = { pathname: "/threads/thr_other", replace: vi.fn() };
  await expect(openSearchMessage("thr_missing", 12, { toThread: () => {} }, location, async () => {})).rejects.toThrow("could not be opened");
  expect(location.replace).not.toHaveBeenCalled();
});
it("lets a later click supersede a pending message jump", async () => {
  const location = { pathname: "/plugins/247c/desk/search", replace: vi.fn() };
  let release!: () => void;
  const first = openSearchMessage("thr_first", 1, { toThread: () => {} }, location, () => new Promise(resolve => { release = resolve; }));
  location.pathname = "/threads/thr_second";
  await openSearchMessage("thr_second", 2, { toThread: () => {} }, location);
  release(); await first;
  expect(location.replace.mock.calls).toEqual([["#msg=2"]]);
});
