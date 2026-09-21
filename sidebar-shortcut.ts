import type { PluginContentScriptContext } from "@get-bb/plugin-sdk/app";

// BB's experimental accessory is normally passive and disappears on hover.
// This content script adapts only the row containing our shortcut: keep the
// badge visible and reserve a separate 28px column for BB's options button.
// Keep these host DOM selectors isolated for compatibility with future BB UI.
const row = '[data-sidebar-navigation-item]:has(> [data-plugin-nav-sidebar-accessory] [data-c247-proposals-shortcut])';
export const sidebarShortcutStyles = `
${row} > button { padding-right: 6rem; }
${row} > [data-plugin-nav-sidebar-accessory] {
  right: 1.75rem;
  opacity: 1 !important;
}
${row} [data-c247-proposals-shortcut] { pointer-events: auto; }
`;

export function mountSidebarShortcut({ signal }: Pick<PluginContentScriptContext, "signal">) {
  if (signal.aborted) return;
  const style = document.createElement("style");
  style.dataset.c247SidebarShortcut = "";
  style.textContent = sidebarShortcutStyles;
  document.head.append(style);
  const dispose = () => {
    style.remove();
    signal.removeEventListener("abort", dispose);
  };
  signal.addEventListener("abort", dispose, { once: true });
  return dispose;
}
