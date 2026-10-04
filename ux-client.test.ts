// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { UX_BUILD, type UxState } from "./ux-contracts.js";
import { UxCollector, beginUxAction, markUxFeedback, uxViewChanged } from "./ux-client.js";

let collector: UxCollector | undefined;
afterEach(() => { collector?.dispose(); collector = undefined; document.body.innerHTML = ""; vi.useRealTimers(); });
function setup() {
  vi.useFakeTimers(); Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  document.body.innerHTML = '<div data-c247-ux-page="tasks" data-c247-ux-view="PRIVATE_TASK_ID"><button data-c247-ux-action="task-open">Private task title</button><input value="secret"><div data-c247-ux-private><button id="private">Do not record</button></div></div><button id="outside">Other app</button>';
  const send = vi.fn().mockResolvedValue({ reason: "saved" }), status = vi.fn();
  collector = new UxCollector(send, status, false);
  const state: UxState = { enabled: true, recordingId: crypto.randomUUID(), endsAt: Date.now()+60000, storageAvailable: true, retentionDays: 7, bytes: 0, build: UX_BUILD };
  return { send, status, state, c: collector };
}
it("records only scoped controls and never reads labels, input contents, raw view IDs or outside clicks", async () => {
  const { c, send, state } = setup(); c.update(state);
  for (const el of Array.from(document.querySelectorAll("button,input"))) el.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 20, clientY: 30 }));
  document.querySelector("input")!.dispatchEvent(new InputEvent("input", { bubbles: true, data: "SECRET_TYPED_TEXT" }));
  await c.flush(); const batch = send.mock.calls[0][0];
  expect(batch.events.map((e: { kind: string }) => e.kind)).toEqual(["view", "click", "click"]);
  expect(batch.events.filter((e: { kind: string }) => e.kind === "click").map((e: { action: string }) => e.action)).toEqual(["task-open", "field"]);
  expect(JSON.stringify(batch)).not.toMatch(/Private|secret|PRIVATE_TASK_ID|Other app|SECRET_TYPED_TEXT/);
});
it("samples pointer movement, stops on hidden pages, and detaches listeners on disposal", async () => {
  const { c, send, state } = setup(); c.update(state); const button = document.querySelector("button")!;
  for (let i=0; i<20; i++) button.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 30, clientY: 40 }));
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
  vi.advanceTimersByTime(1100); button.dispatchEvent(new MouseEvent("pointermove", { bubbles: true }));
  await c.flush(); expect(send.mock.calls[0][0].events.filter((e: { kind: string }) => e.kind === "pointer")).toHaveLength(1);
  c.dispose(); button.click(); await vi.advanceTimersByTimeAsync(10000); expect(send).toHaveBeenCalledTimes(1);
});
it("captures outcomes without RPC arguments and allows only explicitly submitted feedback text", async () => {
  const { c, send, state } = setup(); c.update(state);
  const finish = beginUxAction("day-edit"); vi.advanceTimersByTime(400); finish("error");
  expect(markUxFeedback("Could not find the field")).toBe(true); await c.flush();
  expect(send.mock.calls[0][0].events).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "result", action: "day-edit", outcome: "error", durationMs: 400 }), expect.objectContaining({ kind: "feedback", note: "Could not find the field" })]));
});
it("retries the same batch without duplication and drops queued events when paused", async () => {
  const { c, send, state } = setup(); send.mockRejectedValueOnce(new Error("offline")); c.update(state);
  await c.flush(); await c.flush(); expect(send.mock.calls[0][0].batchId).toBe(send.mock.calls[1][0].batchId);
  document.querySelector("button")!.click(); c.update({ ...state, enabled: false, recordingId: null }); await c.flush();
  expect(send).toHaveBeenCalledTimes(2);
});
it("records a changed route without storing its task or thread identifier", async () => {
  const { c, send, state } = setup(); c.update(state);
  const root = document.querySelector<HTMLElement>("[data-c247-ux-page]")!; root.dataset.c247UxPage = "day"; root.dataset.c247UxView = "PRIVATE_THREAD_ID"; uxViewChanged();
  await c.flush(); expect(send.mock.calls[0][0].events.map((e: { page: string }) => e.page)).toEqual(["tasks", "day"]); expect(JSON.stringify(send.mock.calls)).not.toContain("PRIVATE_THREAD_ID");
});

it("excludes WebDriver automation even if the global study is enabled", async () => {
  const { c, send, status, state } = setup(); c.dispose();
  Object.defineProperty(navigator, "webdriver", { configurable: true, value: true });
  try {
    collector = new UxCollector(send, status); collector.update(state);
    expect(markUxFeedback("Automated probe")).toBe(false);
    await collector.flush(); expect(send).not.toHaveBeenCalled();
  } finally { Reflect.deleteProperty(navigator, "webdriver"); }
});
