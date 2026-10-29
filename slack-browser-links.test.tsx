// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { fireEvent } from "@testing-library/react";
import { renderSlot, type RenderedSlot } from "@get-bb/plugin-sdk/testing/app";
import { SlackBrowserLinks } from "./slack-browser-links.js";

const mounts: RenderedSlot[] = [], elements: HTMLElement[] = [];
afterEach(() => { mounts.splice(0).forEach(m => m.lifecycle.unmount()); elements.splice(0).forEach(e => e.remove()); });
const original = "https://example.slack.com/archives/C123/p1234567890000000?thread_ts=1234500000.000001&cid=C123#reply";
function mount(enabled = true, accepted = true) {
  const slot = renderSlot({ component: SlackBrowserLinks }, {}, { settings: { slackLinksInBrowser: enabled }, openUrl: () => accepted });
  mounts.push(slot); return slot;
}
function anchor(href = original) {
  const link = document.createElement("a"), label = document.createElement("span");
  link.href = href; label.textContent = "Original message"; link.append(label); document.body.append(link); elements.push(link);
  const fallback = vi.fn((event: Event) => event.preventDefault());
  link.addEventListener("click", fallback); link.addEventListener("auxclick", fallback);
  return { link, label, fallback };
}

it("routes existing and newly rendered chat links once before the original Markdown handler without rewriting them", () => {
  const existing = anchor(), slot = mount(), streamed = anchor();
  for (const [target, type, init] of [
    [existing, "click", {}], [streamed, "click", { detail: 0 }],
    [existing, "click", { metaKey: true }], [existing, "click", { ctrlKey: true }],
    [streamed, "auxclick", { button: 1 }],
  ] as const) {
    fireEvent(target.label, new MouseEvent(type, { bubbles: true, cancelable: true, composed: true, ...init }));
    expect(target.fallback).not.toHaveBeenCalled();
    expect(target.link.getAttribute("href")).toBe(original);
    expect(target.link.textContent).toBe("Original message");
  }
  expect(slot.inspection.navigateCalls).toEqual(Array.from({ length: 5 }, () => ({ method: "openUrl", url: original.replace("/archives/", "/messages/") })));
});

it("leaves other URLs, downloads and right clicks with the host", () => {
  const slot = mount();
  for (const href of ["https://example.com/report", "https://example.slack.com.evil.test/archives/C123/p123", "https://example.slack.com/files/F123", original.replace("/archives/", "/messages/"), "https://user:password@example.slack.com/archives/C123/p123"]) {
    const { label, fallback } = anchor(href); fireEvent.click(label); expect(fallback).toHaveBeenCalledOnce();
  }
  const download = anchor(); download.link.download = "message"; fireEvent.click(download.label); expect(download.fallback).toHaveBeenCalledOnce();
  const right = anchor(); fireEvent(right.label, new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 2 })); expect(right.fallback).toHaveBeenCalledOnce();
  expect(slot.inspection.navigateCalls).toEqual([]);
});

it("respects disabled settings, host refusal and cleanup across remounts", () => {
  const { label, fallback } = anchor();
  const disabled = mount(false); fireEvent.click(label); expect(disabled.inspection.navigateCalls).toEqual([]);
  disabled.lifecycle.unmount(); mounts.splice(mounts.indexOf(disabled), 1);
  const refused = mount(true, false); fireEvent.click(label); expect(fallback).toHaveBeenCalledTimes(2);
  refused.lifecycle.unmount(); mounts.splice(mounts.indexOf(refused), 1);
  const active = mount(); fireEvent.click(label); expect(active.inspection.navigateCalls).toHaveLength(1); expect(fallback).toHaveBeenCalledTimes(2);
  active.lifecycle.unmount(); mounts.splice(mounts.indexOf(active), 1);
  fireEvent.click(label); expect(fallback).toHaveBeenCalledTimes(3); expect(active.inspection.navigateCalls).toHaveLength(1);
  const reloaded = mount(); fireEvent.click(label); expect(reloaded.inspection.navigateCalls).toHaveLength(1); expect(fallback).toHaveBeenCalledTimes(3);
});
