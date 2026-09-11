import { useEffect, useRef } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./contracts.js";

/** A panel acknowledges the exact rendered revision, never a background read. */
export function TaskViewMarker({ id, revision }: { id: string; revision: number }) {
  const rpc = useRpc<typeof rpcContract>();
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    let visible = typeof IntersectionObserver === "undefined", sending = false, saved = false;
    const mark = () => {
      if (!visible || document.visibilityState === "hidden" || sending || saved) return;
      sending = true;
      void rpc.call("taskSeen", { id, revision }).then(() => { saved = true; }).catch(() => {}).finally(() => { sending = false; });
    };
    const observer = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver(entries => {
      visible = entries.some(entry => entry.isIntersecting); mark();
    });
    if (ref.current?.parentElement) observer?.observe(ref.current.parentElement);
    document.addEventListener("visibilitychange", mark);
    window.addEventListener("focus", mark);
    mark();
    return () => { observer?.disconnect(); document.removeEventListener("visibilitychange", mark); window.removeEventListener("focus", mark); };
  }, [rpc, id, revision]);
  return <span ref={ref} aria-hidden="true" className="pointer-events-none absolute size-px" />;
}
