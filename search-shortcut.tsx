import { useEffect, useRef, type RefObject } from "react";
import { useBbContext, useBbNavigate, useSettings, useSidebarSplitLayout, experimental_useSidebarThreads } from "@get-bb/plugin-sdk/app";
import { prepareSearch } from "./search-ui.js";
import { withThread } from "./desk-routes.js";

type PageSearch = { root: HTMLElement; open: (query?: string) => void };
const pages = new Set<PageSearch>();

// The page owns navigation so its unsaved-edit guards also apply to shortcuts.
export function usePageSearchShortcut(root: RefObject<HTMLElement | null>, open: PageSearch["open"]) {
  const latest = useRef(open);
  latest.current = open;
  useEffect(() => {
    if (!root.current) return;
    const page = { root: root.current, open: (query?: string) => latest.current(query) };
    pages.add(page);
    return () => { pages.delete(page); };
  }, [root]);
}

// Keep BB's DOM compatibility boundary here. SDK hooks supply thread/project
// identity; DOM is used only for keyboard focus and selected text.
function paneId(element: Element | null): string | undefined {
  return element?.closest<HTMLElement>("[data-split-pane-id]")?.dataset.splitPaneId
    ?? element?.closest<HTMLElement>('[data-panel-id^="plugin-panel-main-"]')?.dataset.panelId?.slice("plugin-panel-main-".length);
}
const excluded = '[data-app-terminal], [data-app-browser], .monaco-editor, [data-c247-search-ignore]';
const modal = '[aria-modal="true"]:not([inert]):not([inert] *):not([data-state="closed"]), [role="dialog"][data-state="open"]:not([inert]):not([inert] *)';

export function isSearchShortcut(event: KeyboardEvent, platform = navigator.platform) {
  const mac = /Mac|iPhone|iPad/.test(platform);
  return !event.defaultPrevented && !event.isComposing && !event.repeat && !event.altKey && !event.shiftKey
    && (mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey)
    && (event.code === "KeyF" || event.key.toLowerCase() === "f");
}

export function selectedSearchText(target: Element, root?: HTMLElement): string | undefined {
  let text = "";
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) {
    if (target instanceof HTMLInputElement && target.type === "password") return;
    text = target.value.slice(target.selectionStart ?? 0, target.selectionEnd ?? 0);
  } else {
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed && (!root || (root.contains(selection.anchorNode) && root.contains(selection.focusNode)))) text = selection.toString();
  }
  return text.trim().replace(/\s+/g, " ").slice(0, 300) || undefined;
}

export function SearchShortcut() {
  const context = useBbContext(), navigate = useBbNavigate(), { values } = useSettings();
  const { threads } = experimental_useSidebarThreads(), layout = useSidebarSplitLayout();
  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if (!isSearchShortcut(event)) return;
      const target = event.target instanceof Element ? event.target : document.body;
      if (target.closest(excluded) || document.querySelector(modal)) return;
      const focused = layout?.panes.find(pane => pane.isFocused);
      const owner = paneId(target) ?? focused?.paneId;
      const page = [...pages].find(page => page.root.contains(target)
        || (owner ? paneId(page.root) === owner : !context.threadId && pages.size === 1));
      if (page) {
        event.preventDefault(); event.stopImmediatePropagation();
        page.open(selectedSearchText(target, page.root));
        return;
      }
      const pane = layout?.panes.find(pane => pane.paneId === owner);
      // A panel or another plugin in a split must not inherit the route's chat.
      const threadId = pane ? pane.threadId : context.threadId;
      if (!threadId || (owner && layout && !pane)) return;
      const thread = threads.find(thread => thread.id === threadId);
      const projectId = thread?.projectId ?? (context.threadId === threadId ? context.projectId : null);
      const projectMatches = Boolean(values?.threadProjectId && projectId === values.threadProjectId);
      if (thread?.originPluginId !== "247c" && !projectMatches) return;
      event.preventDefault(); event.stopImmediatePropagation();
      prepareSearch(selectedSearchText(target, target.closest<HTMLElement>("[data-thread-window]") ?? undefined));
      navigate.toPluginPanel("desk", { subPath: withThread("search", threadId) });
    };
    // Native/browser Find and BB's general handlers keep working outside our
    // scope. Capture only this exact shortcut, with complete teardown on reload.
    window.addEventListener("keydown", handle, true);
    return () => window.removeEventListener("keydown", handle, true);
  }, [context, navigate, values?.threadProjectId, threads, layout]);
  return null;
}
