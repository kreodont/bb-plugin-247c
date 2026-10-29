import { useEffect } from "react";
import { useBbNavigate, useSettings } from "@get-bb/plugin-sdk/app";
import { sourceHref } from "./task-sources.js";

// Apply the local navigation preference to existing and streamed chat links.
// Keep message text and evidence URLs intact; use BB's browser preference.
export function SlackBrowserLinks() {
  const { values } = useSettings();
  const navigate = useBbNavigate();
  const enabled = values?.slackLinksInBrowser === true;
  useEffect(() => {
    if (!enabled) return;
    const open = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== (event.type === "auxclick" ? 1 : 0)) return;
      const link = event.composedPath().find((node): node is HTMLAnchorElement => node instanceof HTMLAnchorElement);
      if (!link || link.hasAttribute("download")) return;
      const original = link.getAttribute("href");
      if (!original) return;
      const destination = sourceHref(original, true);
      if (!destination || destination === original || !navigate.openUrl(destination)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    // Run before Markdown's own link handler, which closes over its original URL.
    window.addEventListener("click", open, true);
    window.addEventListener("auxclick", open, true);
    return () => {
      window.removeEventListener("click", open, true);
      window.removeEventListener("auxclick", open, true);
    };
  }, [enabled, navigate]);
  return null;
}
