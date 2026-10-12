import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { usePortalScopeProps } from "./lib/portal-scope.js";

// BB 0.46 moved panel navigation into an icon rail and stopped rendering
// sidebar accessories. Keep host DOM dependencies in this optional adapter.
const BODY = '[data-testid="app-sidebar-body"]';
const HEADER = '[data-testid="app-sidebar-top-reserve-row"]';
const RAIL = '[data-testid="app-nav-rail"]';
const STRUCTURE = `${BODY}, ${HEADER}, ${RAIL}`;
type Panel = { id: string; label: string; button: HTMLButtonElement; active: boolean; disabled: boolean };
type Mount = { host: HTMLElement; panels: Panel[] };

function readPanels(rail: Element): Panel[] {
  return Array.from(rail.querySelectorAll<HTMLElement>("[data-nav-rail-item]")).flatMap(row => {
    const id = row.dataset.navRailItem, button = row.querySelector<HTMLButtonElement>("button");
    const label = button?.getAttribute("aria-label");
    if (!id || id.startsWith("__bb__/") || !button || !label) return [];
    return [{ id, label, button, active: button.getAttribute("aria-current") === "page", disabled: button.disabled || button.getAttribute("aria-busy") === "true" }];
  });
}

function useSidebarMount(enabled: boolean) {
  const [mount, setMount] = useState<Mount | null>(null);
  useEffect(() => {
    if (!enabled) { setMount(null); return; }
    let host: HTMLElement | null = null, rail: Element | null = null, disposed = false, queued = false;
    const sync = () => {
      queued = false;
      if (disposed) return;
      const body = document.querySelector(BODY), header = body?.querySelector(HEADER);
      rail = document.querySelector(RAIL);
      const panels = rail ? readPanels(rail) : [];
      if (!body || !header || header.parentElement !== body || !panels.length) {
        setMount(null); host?.remove(); host = null; return;
      }
      if (!host) {
        host = document.createElement("div");
        host.dataset.c247SidebarPluginLinksHost = "";
        host.className = "shrink-0";
      }
      if (host.parentElement !== body || header.nextElementSibling !== host) header.after(host);
      const destination = host;
      setMount(previous => previous?.host === destination && previous.panels.length === panels.length && panels.every((panel, index) => {
        const old = previous.panels[index];
        return old.id === panel.id && old.label === panel.label && old.button === panel.button && old.active === panel.active && old.disabled === panel.disabled;
      }) ? previous : { host: destination, panels });
    };
    const observer = new MutationObserver(records => {
      const relevant = records.some(record => {
        if (host?.contains(record.target)) return false;
        if (rail?.contains(record.target) || record.target === host?.parentElement || (host && !host.isConnected)) return true;
        return [...Array.from(record.addedNodes), ...Array.from(record.removedNodes)].some(node => node instanceof Element && (node.matches(STRUCTURE) || node.querySelector(STRUCTURE)));
      });
      if (relevant && !queued) { queued = true; queueMicrotask(sync); }
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["aria-label", "aria-current", "aria-busy", "disabled", "data-nav-rail-item"] });
    sync();
    return () => { disposed = true; observer.disconnect(); host?.remove(); };
  }, [enabled]);
  return enabled ? mount : null;
}

function PanelIcon({ button }: { button: HTMLButtonElement }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const source = button.querySelector("[data-icon-root]");
    if (!source || !ref.current) return;
    const icon = source.cloneNode(true) as Element;
    icon.removeAttribute("id");
    icon.setAttribute("class", "size-4 shrink-0");
    ref.current.replaceChildren(icon);
    return () => icon.remove();
  }, [button]);
  return <span ref={ref} aria-hidden="true" className="inline-flex size-4 shrink-0" />;
}

export function SidebarPluginLinks({ enabled, accessory }: { enabled: boolean; accessory: ReactNode }) {
  const mount = useSidebarMount(enabled);
  const scope = usePortalScopeProps();
  if (!mount) return null;
  return createPortal(<nav {...scope} aria-label="Plugin shortcuts" className="mx-2 mb-2 max-h-[25vh] overflow-y-auto border-b border-border/60 pb-2">
    {mount.panels.map(panel => <div key={panel.id} data-c247-sidebar-plugin-link={panel.id} className={`flex min-w-0 items-center gap-1 rounded-md hover:bg-sidebar-accent ${panel.active ? "bg-sidebar-accent" : ""}`}>
      <button type="button" aria-label={panel.label} aria-current={panel.active ? "page" : undefined} disabled={panel.disabled}
        className="flex min-h-8 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md px-2 text-left text-sm text-sidebar-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        onClick={event => panel.button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, metaKey: event.metaKey, ctrlKey: event.ctrlKey, shiftKey: event.shiftKey, altKey: event.altKey }))}>
        <PanelIcon button={panel.button} /><span className="min-w-0 flex-1 truncate">{panel.label}</span>
      </button>
      {panel.id === "247c/desk" && <span className="shrink-0 pr-2">{accessory}</span>}
    </div>)}
  </nav>, mount.host);
}
