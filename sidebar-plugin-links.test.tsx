// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { SidebarPluginLinks } from "./sidebar-plugin-links.js";

afterEach(() => { cleanup(); document.body.replaceChildren(); });

function shell() {
  const parent = document.createElement("div");
  parent.innerHTML = `<div data-testid="app-nav-rail">
    <span data-nav-rail-item="__bb__/search-threads"><button aria-label="Search threads"></button></span>
    <span data-nav-rail-item="247c/desk"><button aria-label="247C"><svg data-icon-root></svg></button></span>
    <span data-nav-rail-item="notes/notes"><button aria-label="Notes"></button></span>
    </div><div data-testid="app-sidebar-body"><div data-testid="app-sidebar-top-reserve-row">New thread</div><div>Chats</div></div>`;
  document.body.append(parent);
  return { parent, rail: parent.querySelector('[data-testid="app-nav-rail"]')!, body: parent.querySelector('[data-testid="app-sidebar-body"]')!, button: parent.querySelector<HTMLButtonElement>('[aria-label="247C"]')! };
}
const shortcuts = () => within(document.body).findByRole("navigation", { name: "Plugin shortcuts" });

it("restores visible plugin links above chats and delegates navigation, including split clicks", async () => {
  const s = shell(), open = vi.fn(); s.button.addEventListener("click", open);
  render(<SidebarPluginLinks enabled accessory={<span>4 proposals · 38 · 3:18</span>} />);
  const nav = await shortcuts();
  expect(s.body.children[1].contains(nav)).toBe(true);
  expect(within(nav).getAllByRole("button").map(button => button.textContent)).toEqual(["247C", "Notes"]);
  expect(nav.textContent).toContain("4 proposals · 38 · 3:18");
  fireEvent.click(within(nav).getByRole("button", { name: "247C" }));
  fireEvent.click(within(nav).getByRole("button", { name: "247C" }), { metaKey: true });
  expect(open).toHaveBeenCalledTimes(2);
  expect(open.mock.calls[1][0].metaKey).toBe(true);
});

it("keeps accessory actions separate from opening the panel", async () => {
  const s = shell(), open = vi.fn(), proposals = vi.fn(); s.button.addEventListener("click", open);
  render(<SidebarPluginLinks enabled accessory={<button onClick={proposals}>Review proposals</button>} />);
  fireEvent.click(within(await shortcuts()).getByRole("button", { name: "Review proposals" }));
  expect(proposals).toHaveBeenCalledOnce(); expect(open).not.toHaveBeenCalled();
});

it("follows the host's active, disabled, reordered and hidden panel state", async () => {
  const s = shell(); render(<SidebarPluginLinks enabled accessory={null} />);
  const nav = await shortcuts();
  s.button.setAttribute("aria-current", "page"); s.button.disabled = true;
  s.rail.prepend(s.rail.lastElementChild!);
  await waitFor(() => {
    const button = within(nav).getByRole("button", { name: "247C" }) as HTMLButtonElement;
    expect(button.getAttribute("aria-current")).toBe("page"); expect(button.disabled).toBe(true);
    expect(within(nav).getAllByRole("button")[0].textContent).toBe("Notes");
  });
  s.button.parentElement!.remove();
  await waitFor(() => expect(within(nav).queryByRole("button", { name: "247C" })).toBeNull());
});

it("recovers when BB replaces its sidebar and cleans up on disable or unmount", async () => {
  const old = shell(); const view = render(<SidebarPluginLinks enabled accessory={null} />);
  await shortcuts(); old.parent.remove(); const next = shell();
  await waitFor(() => expect(next.body.querySelector('[aria-label="Plugin shortcuts"]')).not.toBeNull());
  expect(document.querySelectorAll('[data-c247-sidebar-plugin-links-host]')).toHaveLength(1);
  view.rerender(<SidebarPluginLinks enabled={false} accessory={null} />);
  await waitFor(() => expect(document.querySelector('[data-c247-sidebar-plugin-links-host]')).toBeNull());
  view.rerender(<SidebarPluginLinks enabled accessory={null} />); await shortcuts();
  view.unmount();
  expect(document.querySelector('[data-c247-sidebar-plugin-links-host]')).toBeNull();
});

it("does not add duplicate navigation on older BB layouts or when disabled", async () => {
  document.body.innerHTML = '<div data-testid="app-sidebar-body"><div data-sidebar-navigation-item>247C</div></div>';
  const view = render(<SidebarPluginLinks enabled accessory={null} />);
  expect(document.querySelector('[aria-label="Plugin shortcuts"]')).toBeNull();
  shell(); view.rerender(<SidebarPluginLinks enabled={false} accessory={null} />);
  expect(document.querySelector('[aria-label="Plugin shortcuts"]')).toBeNull();
});
