import { useCallback, useEffect, useState } from "react";
import { useRealtime, useRealtimeConnectionState, useRpc, type PluginContentScriptContext, type PluginComposerThreadRowStatus } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./contracts.js";
import { Icon } from "./components/ui/icon.js";

export const REVIEW_ACTIVITY_ICON = "247c-review-running";
export function ReviewActivityIcon({ className }: { className?: string }) {
  return <Icon name="Loading" className={`animate-spin motion-reduce:animate-none ${className ?? ""}`} />;
}

// One bridge per frontend generation. The app overlay supplies live RPC data;
// the content script owns route-independent, host-rendered sidebar statuses.
export function createReviewActivityIndicator() {
  let current = new Map<string, PluginComposerThreadRowStatus>();
  const listeners = new Set<() => void>();
  const update = (next: typeof current) => { current = next; listeners.forEach(listener => listener()); };

  function mount({ signal, experimental_setThreadRowStatus: setStatus }: PluginContentScriptContext) {
    if (signal.aborted || !setStatus) return;
    let shown = new Map<string, PluginComposerThreadRowStatus>();
    const apply = () => {
      for (const threadId of shown.keys()) if (!current.has(threadId)) setStatus(threadId, null);
      for (const [threadId, status] of current) if (shown.get(threadId)?.label !== status.label) setStatus(threadId, status);
      shown = new Map(current);
    };
    const dispose = () => {
      listeners.delete(apply);
      signal.removeEventListener("abort", dispose);
      for (const threadId of shown.keys()) setStatus(threadId, null);
      shown.clear();
    };
    listeners.add(apply);
    signal.addEventListener("abort", dispose, { once: true });
    apply();
    return dispose;
  }

  function Overlay() {
    const rpc = useRpc<typeof rpcContract>(), connection = useRealtimeConnectionState();
    const [revision, setRevision] = useState(0);
    const refresh = useCallback(() => setRevision(value => value + 1), []);
    useRealtime("desk-changed", refresh);
    useEffect(() => {
      const timer = setInterval(refresh, 15_000);
      window.addEventListener("focus", refresh);
      return () => { clearInterval(timer); window.removeEventListener("focus", refresh); update(new Map()); };
    }, [refresh]);
    useEffect(() => {
      let active = true;
      rpc.call("reviewActivity", {}).then(({ threads }) => {
        if (!active) return;
        update(new Map(threads.map(({ threadId, status }) => [threadId, {
          icon: REVIEW_ACTIVITY_ICON, tone: "running",
          label: status === "collecting" ? "Saving conversation for review" : status === "review_starting" ? "Starting conversation review" : "Reviewing conversation",
        }])));
      }, () => { if (active) update(new Map()); });
      return () => { active = false; };
    }, [rpc, revision, connection]);
    return null;
  }
  return { mount, Overlay };
}
