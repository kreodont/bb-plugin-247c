import { createContext, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Button } from "./components/ui/button.js";
import { Icon } from "./components/ui/icon.js";

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

export function NavigationFrame({ subPath, children }: { subPath: string; children: ReactNode }) {
  const guards = useRef(new Set<Guard>()), flight = useRef(false), mounted = useRef(true), route = useRef({ subPath });
  if (route.current.subPath !== subPath) route.current = { subPath };
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const available = useSyncExternalStore(subscribeHistory, availability, () => 0);
  const register = useCallback((guard: Guard) => {
    guards.current.add(guard);
    return () => { guards.current.delete(guard); };
  }, []);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function move(direction: "back" | "forward") {
    if (flight.current || !(availability() & (direction === "back" ? 1 : 2))) return;
    flight.current = true; setBusy(true); setError(null);
    const from = route.current;
    try {
      for (const guard of [...guards.current]) if (!await guard()) return;
      // Saving can finish after another navigation or after this pane closes.
      if (mounted.current && route.current === from) window.history[direction]();
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : "Could not navigate. Try again.");
    } finally {
      flight.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return <NavigationGuards.Provider value={register}><div className="flex h-full min-h-0 flex-col">
    <nav aria-label="247C navigation" className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border bg-background px-3 py-2">
      <span title="Go back"><Button type="button" variant="ghost" size="sm" aria-label="Back" disabled={busy || !(available & 1)} onClick={() => void move("back")}><Icon name="ChevronLeft" aria-hidden="true" />Back</Button></span>
      <span title="Go forward"><Button type="button" variant="ghost" size="sm" aria-label="Forward" disabled={busy || !(available & 2)} onClick={() => void move("forward")}><span>Forward</span><Icon name="ChevronRight" aria-hidden="true" /></Button></span>
      {busy && <span role="status" className="ml-2 text-xs text-muted-foreground">Saving before navigation…</span>}
      {error && <p role="alert" className="w-full px-2 text-sm text-destructive">{error}</p>}
    </nav>
    <div className="min-h-0 flex-1">{children}</div>
  </div></NavigationGuards.Provider>;
}
