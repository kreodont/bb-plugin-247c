import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useBbContext, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { TaskCard } from "./contracts.js";
import { switcherTasks } from "./task-switch-order.js";
import { beginUxAction } from "./ux-client.js";
import { UxScope, useUxRpc } from "./ux-app.js";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./components/ui/dialog.js";
import { Input } from "./components/ui/input.js";
import { cn } from "./lib/utils.js";

export const TASK_SWITCHER_EVENT = "c247-task-switcher";
export const openTaskSwitcher = () => { window.dispatchEvent(new Event(TASK_SWITCHER_EVENT)); };

export function TaskSwitcher({ dotFor, updated }: { dotFor: (task: TaskCard) => string; updated: (value: string) => string }) {
  const rpc = useUxRpc(), navigate = useBbNavigate(), context = useBbContext();
  const [open, setOpen] = useState(false), [query, setQuery] = useState(""), [index, setIndex] = useState(0);
  const [tasks, setTasks] = useState<TaskCard[] | null>(null), [error, setError] = useState<string | null>(null), [opening, setOpening] = useState<string | null>(null);
  const requests = useRef(new Map<string, string>()), busy = useRef(false);
  const load = useCallback(async () => {
    try { setTasks((await rpc.call("list", { history: false })).tasks); setError(null); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }, [rpc]);
  useEffect(() => {
    const show = () => { setQuery(""); setIndex(0); setOpen(true); void load(); };
    window.addEventListener(TASK_SWITCHER_EVENT, show);
    return () => window.removeEventListener(TASK_SWITCHER_EVENT, show);
  }, [load]);
  const visible = switcherTasks(tasks ?? [], query);
  const selected = Math.min(index, Math.max(visible.length - 1, 0));
  const current = context.threadId;

  async function choose(task: TaskCard) {
    if (busy.current) return;
    const finish = beginUxAction(task.activeThreadId ? "chat-open" : "chat-new");
    if (task.activeThreadId) { setOpen(false); if (task.activeThreadId !== current) navigate.toThread(task.activeThreadId); finish("ok"); return; }
    busy.current = true; setOpening(task.id);
    const requestId = requests.current.get(task.id) ?? crypto.randomUUID(); requests.current.set(task.id, requestId);
    try {
      const session = await rpc.call("openChat", { taskId: task.id, requestId });
      if (!session.workerThreadId) throw new Error(session.error || "The chat is still starting. Try again.");
      setOpen(false); navigate.toThread(session.workerThreadId); finish("ok");
    } catch (cause) { finish("error"); toast.error("Could not open the work chat", { description: cause instanceof Error ? cause.message : String(cause) }); }
    finally { busy.current = false; setOpening(null); }
  }
  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (visible.length) setIndex((selected + (event.key === "ArrowDown" ? 1 : visible.length - 1)) % visible.length);
    } else if (event.key === "Enter" && visible[selected]) { event.preventDefault(); void choose(visible[selected]); }
  }
  useEffect(() => { document.getElementById(`c247-switch-${visible[selected]?.id}`)?.scrollIntoView?.({ block: "nearest" }); }, [selected, visible]);

  return <Dialog open={open} onOpenChange={setOpen}><DialogContent className="gap-3 p-4 sm:max-w-lg">
    <DialogTitle className="text-base">Switch task</DialogTitle>
    <DialogDescription className="sr-only">Open the work chat of another 247C task.</DialogDescription>
    <UxScope page="tasks" view="switcher" className="flex min-h-0 flex-col gap-3">
      <Input autoFocus value={query} placeholder="Filter by title or customer" aria-label="Filter tasks" aria-controls="c247-switch-list"
        aria-activedescendant={visible[selected] ? `c247-switch-${visible[selected].id}` : undefined}
        onChange={event => { setQuery(event.target.value); setIndex(0); }} onKeyDown={onKeyDown} />
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {!tasks && !error && <p role="status" className="py-6 text-center text-sm text-muted-foreground">Loading tasks…</p>}
      {tasks && !visible.length && <p className="py-6 text-center text-sm text-muted-foreground">{query.trim() ? "No matching open tasks." : "No open tasks."}</p>}
      <ul id="c247-switch-list" role="listbox" aria-label="Open tasks" className="max-h-[60vh] overflow-y-auto">
        {visible.map((task, i) => {
          const here = Boolean(current && task.activeThreadId === current);
          const first = i === 0 || Boolean(visible[i - 1].activeThreadId) !== Boolean(task.activeThreadId);
          return <li key={task.id} role="presentation">
            {first && <p className="px-2 pb-1 pt-2 text-xs font-medium text-muted-foreground">{task.activeThreadId ? "Open chats" : "Other open tasks"}</p>}
            <button id={`c247-switch-${task.id}`} role="option" aria-selected={i === selected} type="button" data-c247-ux-action="task-switch"
              disabled={!!opening} onMouseMove={() => setIndex(i)} onClick={() => void choose(task)}
              className={cn("flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm", i === selected ? "bg-muted" : "hover:bg-muted/60")}>
              <span aria-hidden="true" className={cn("size-2 shrink-0 rounded-full", dotFor(task))} />
              <span className="min-w-0 flex-1 truncate">{task.title}</span>
              {here && <span className="shrink-0 text-xs text-muted-foreground">Current</span>}
              {task.pendingCount > 0 && <span className="shrink-0 rounded-full bg-orange-500/15 px-1.5 text-xs text-orange-700 dark:text-orange-300" title="Proposals awaiting a decision">{task.pendingCount}</span>}
              <span className="shrink-0 text-xs text-muted-foreground">{opening === task.id ? "Opening…" : task.activeThreadId ? updated(task.updatedAt) : "New chat"}</span>
            </button>
          </li>;
        })}
      </ul>
    </UxScope>
  </DialogContent></Dialog>;
}
