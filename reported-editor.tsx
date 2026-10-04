import { useEffect, useRef, useState } from "react";
import { useUxRpc, UxScope } from "./ux-app.js";
import { formatMinutes, parseMinutes, type DayItem } from "./day-contracts.js";
import { Button } from "./components/ui/button.js";
import { Input } from "./components/ui/input.js";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./components/ui/dialog.js";

export function ReportedEditor({ taskId, threadId, close, saved }: { taskId: string; threadId: string; close: () => void; saved: () => Promise<void> }) {
  const rpc = useUxRpc();
  const [snapshot, setSnapshot] = useState<{ date: string; item: DayItem | null }>(), [draft, setDraft] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (snapshot) { input.current?.focus(); input.current?.select(); } }, [snapshot]);
  const mounted = useRef(true), flight = useRef(false), request = useRef<{ key: string; id: string } | undefined>(undefined);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function load() {
    try {
      const day = await rpc.call("day", {});
      if (!mounted.current) return;
      const item = day.items.find(i => i.taskId === taskId && i.date === day.date) ?? null;
      setSnapshot({ date: day.date, item }); setDraft(item?.reportedMinutes == null ? "" : formatMinutes(item.reportedMinutes)); setError(null);
    } catch { if (mounted.current) setError("Could not load today's time. Try again."); }
  }
  useEffect(() => { void load(); }, [taskId]);
  async function save() {
    if (!snapshot || flight.current) return;
    flight.current = true; setBusy(true); setError(null);
    try {
      const minutes = parseMinutes(draft), item = snapshot.item;
      if (item && item.reportedDate !== snapshot.date) throw new Error("This entry is reported on another date. Use Day Plan to review it.");
      const key = JSON.stringify([snapshot.date, item?.id, item?.revision, minutes]);
      if (request.current?.key !== key) request.current = { key, id: crypto.randomUUID() };
      if (item) await rpc.call("dayEdit", { id: item.id, revision: item.revision, requestId: request.current.id, operation: "set", reportedMinutes: minutes });
      else await rpc.call("dayAdd", { date: snapshot.date, taskId, plannedMinutes: 0, reportedMinutes: minutes, requestId: request.current.id });
      if (mounted.current) { await saved(); close(); }
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : "Could not save the time. Try again."); }
    finally { flight.current = false; if (mounted.current) setBusy(false); }
  }
  return <Dialog open onOpenChange={open => { if (!open && !flight.current) close(); }}><DialogContent className="sm:max-w-sm">
    <UxScope page="thread" view={threadId}><DialogTitle>Reported time</DialogTitle><DialogDescription>Set the total for {snapshot?.date ?? "today"}. You will stay in this thread.</DialogDescription>
      <form className="mt-4 space-y-4" onSubmit={e => { e.preventDefault(); void save(); }}>
        <label className="block text-sm">Reported total<Input ref={input} data-c247-ux-action="field" autoFocus aria-label="Reported total" placeholder="For example, 45m or 1:30" value={draft} disabled={busy || !snapshot} onChange={e => setDraft(e.target.value)} /></label>
        <p className="text-xs text-muted-foreground">An empty field clears the value. Planned time stays unchanged.</p>
        {error && <div role="alert" className="text-sm text-destructive">{error}<Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void load()}>Reload saved time</Button></div>}
        <div className="flex justify-end gap-2"><Button type="button" variant="ghost" disabled={busy} onClick={close}>Cancel</Button><Button data-c247-ux-action="reported-save" type="submit" disabled={busy || !snapshot}>{busy ? "Saving…" : "Save total"}</Button></div>
      </form>
    </UxScope>
  </DialogContent></Dialog>;
}
