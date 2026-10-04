import { createContext, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Button } from "./components/ui/button.js";
import { Icon } from "./components/ui/icon.js";
import { deskRoute } from "./desk-routes.js";

type Guard = () => boolean | Promise<boolean>;
const NavigationGuards = createContext<((guard: Guard) => () => void) | null>(null);

export function useNavigationGuard(guard: Guard) {
  const register = useContext(NavigationGuards), latest = useRef(guard);
  latest.current = guard;
  useEffect(() => register?.(() => latest.current()), [register]);
}

// The installed SDK routes panel links through browser history but exposes no
// back/forward method. Use native traversal without changing BB's history state.
// Navigation API availability: https://developer.mozilla.org/en-US/docs/Web/API/Navigation/canGoBack
type BrowserNavigation = EventTarget & { readonly canGoBack: boolean; readonly canGoForward: boolean };
function browserNavigation() {
  return (window as Window & { navigation?: BrowserNavigation }).navigation;
}
function availability() {
  const navigation = browserNavigation();
  // Older browsers cannot report the current index. Leave traversal available
  // when a history exists; the browser safely does nothing at an unknown edge.
  const fallback = window.history.length > 1;
  return Number(navigation?.canGoBack ?? fallback) | (Number(navigation?.canGoForward ?? fallback) << 1);
}
function subscribeHistory(update: () => void) {
  const navigation = browserNavigation();
  navigation?.addEventListener("currententrychange", update);
  window.addEventListener("popstate", update);
  window.addEventListener("pageshow", update);
  return () => {
    navigation?.removeEventListener("currententrychange", update);
    window.removeEventListener("popstate", update);
    window.removeEventListener("pageshow", update);
  };
}

export function NavigationFrame({ subPath, children, returnToThread, goTo, today, pendingTotal = 0, failedReviews = 0 }: { subPath: string; children: ReactNode; returnToThread?: () => void; goTo?: (path: string) => void; today?: string; pendingTotal?: number; failedReviews?: number }) {
  const guards = useRef(new Set<Guard>()), flight = useRef(false), mounted = useRef(true), route = useRef({ subPath });
  if (route.current.subPath !== subPath) route.current = { subPath };
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const activePath = deskRoute(subPath).path;
  const activeSection = activePath.startsWith("day/") || activePath.startsWith("report/") ? "nav-today" : activePath === "proposals" ? "nav-proposals" : !["reviews", "updates", "knowledge", "ux"].includes(activePath) ? "nav-tasks" : null;
  const available = useSyncExternalStore(subscribeHistory, availability, () => 0);
  const register = useCallback((guard: Guard) => {
    guards.current.add(guard);
    return () => { guards.current.delete(guard); };
  }, []);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function move(direction: "back" | "forward" | "thread" | "section", path = "") {
    if (flight.current || (direction === "section" ? !goTo : direction === "thread" ? !returnToThread : !(availability() & (direction === "back" ? 1 : 2)))) return;
    flight.current = true; setBusy(true); setError(null);
    const from = route.current;
    try {
      for (const guard of [...guards.current]) if (!await guard()) return;
      // Saving can finish after another navigation or after this pane closes.
      if (mounted.current && route.current === from) {
        if (direction === "section") goTo?.(path);
        else if (direction === "thread") returnToThread?.();
        else window.history[direction]();
      }
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : "Could not navigate. Try again.");
    } finally {
      flight.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return <NavigationGuards.Provider value={register}><div className="flex h-full min-h-0 flex-col">
    <nav aria-label="247C navigation" className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border bg-background px-3 py-2">
      <span title="Go back"><Button data-c247-ux-action="back" type="button" variant="ghost" size="sm" aria-label="Back" disabled={busy || !(available & 1)} onClick={() => void move("back")}><Icon name="ChevronLeft" aria-hidden="true" /></Button></span>
      <span title="Go forward"><Button data-c247-ux-action="forward" type="button" variant="ghost" size="sm" aria-label="Forward" disabled={busy || !(available & 2)} onClick={() => void move("forward")}><Icon name="ChevronRight" aria-hidden="true" /></Button></span>
      {goTo && <><div className="mr-1 h-5 border-l border-border" />{[{ label: "Today", path: `day/${today}`, action: "nav-today" }, { label: "Tasks", path: "", action: "nav-tasks" }, { label: pendingTotal ? `Proposals · ${pendingTotal}` : "Proposals", path: "proposals", action: "nav-proposals" }].map(link => <Button key={link.action} data-c247-ux-action={link.action} variant={activeSection === link.action ? "secondary" : "ghost"} size="sm" disabled={busy} aria-current={activeSection === link.action ? "page" : undefined} onClick={() => void move("section", link.path)}>{link.label}</Button>)}{failedReviews > 0 && <Button variant={activePath === "reviews" ? "secondary" : "ghost"} size="sm" className="text-destructive" disabled={busy} aria-current={activePath === "reviews" ? "page" : undefined} onClick={() => void move("section", "reviews")}><Icon name="AlertCircle" />Failed reviews · {failedReviews}</Button>}<details className="relative"><summary className="cursor-pointer rounded px-3 py-2 text-xs text-muted-foreground">More</summary><div className="absolute left-0 top-full z-30 flex min-w-40 flex-col rounded-lg border border-border bg-background p-1 shadow-lg">{[{ label: "Updates", path: "updates", action: "nav-updates" }, { label: "Failed reviews", path: "reviews", action: "other" }, { label: "Knowledge base", path: "knowledge", action: "nav-knowledge" }, { label: "UX recording", path: "ux", action: "other" }].map(link => <Button key={link.path} data-c247-ux-action={link.action} variant="ghost" size="sm" disabled={busy} className="justify-start" onClick={e => { e.currentTarget.closest("details")?.removeAttribute("open"); void move("section", link.path); }}>{link.label}</Button>)}</div></details></>}
      {returnToThread && <Button data-c247-ux-action="return-thread" type="button" variant="outline" size="sm" className="ml-auto" disabled={busy} onClick={() => void move("thread")}><Icon name="MessageSquare" aria-hidden="true" />Return to thread</Button>}
      {busy && <span role="status" className="ml-2 text-xs text-muted-foreground">Saving before navigation…</span>}
      {error && <p role="alert" className="w-full px-2 text-sm text-destructive">{error}</p>}
    </nav>
    <div className="min-h-0 flex-1">{children}</div>
  </div></NavigationGuards.Provider>;
}
