import { useEffect, useRef, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./contracts.js";
import { Input } from "./components/ui/input.js";
import { Button } from "./components/ui/button.js";

export const customerKey = (value: string | null | undefined) => (value ?? "").trim().normalize("NFKC").toLocaleLowerCase("en");
export function customerChoices(tasks: { customer?: string | null }[]): string[] {
  const names = new Map<string, string>();
  for (const task of tasks) if (task.customer && !names.has(customerKey(task.customer))) names.set(customerKey(task.customer), task.customer);
  return [...names.values()].sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }));
}

export function CustomerEditor({ taskId, revision, value, disabled, action }: {
  taskId: string; revision: number; value: string | null; disabled: boolean;
  action: (fn: () => Promise<unknown>) => Promise<boolean>;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [draft, setDraft] = useState(value ?? ""), [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [choices, setChoices] = useState<string[]>([]);
  const dirty = useRef(false), inflight = useRef(false);
  const request = useRef<{ value: string | null; revision: number; id: string } | null>(null);
  useEffect(() => { if (!dirty.current) setDraft(value ?? ""); }, [value]);
  useEffect(() => { let live = true; void rpc.call("customers", {}).then(names => { if (live) setChoices(names); }).catch(() => {}); return () => { live = false; }; }, [rpc]);
  async function save() {
    const customer = draft.trim() || null;
    if (!dirty.current || inflight.current || disabled) return;
    if (customer === value) { dirty.current = false; setState("idle"); return; }
    if (!request.current || request.current.value !== customer || request.current.revision !== revision)
      request.current = { value: customer, revision, id: crypto.randomUUID() };
    inflight.current = true; setState("saving");
    try {
      const ok = await action(() => rpc.call("setCustomer", { taskId, revision, customer, requestId: request.current!.id }));
      if (ok) { dirty.current = false; setDraft(customer ?? ""); request.current = null; }
      setState(ok ? "saved" : "error");
    } finally { inflight.current = false; }
  }
  const saveRef = useRef(save); saveRef.current = save;
  useEffect(() => {
    if (!dirty.current) return;
    const timer = setTimeout(() => void saveRef.current(), 700);
    return () => clearTimeout(timer);
  }, [draft]);
  return <section className="rounded-xl border border-border p-4">
    <label htmlFor={`customer-${taskId}`} className="mb-2 block text-sm font-medium">Customer</label>
    <Input id={`customer-${taskId}`} list={`customers-${taskId}`} aria-label="Customer" maxLength={200} value={draft} disabled={disabled || state === "saving"}
      placeholder="Not specified" onChange={event => { dirty.current = true; setDraft(event.target.value); setState("idle"); }}
      onBlur={() => void save()} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); void save(); } }} />
    <datalist id={`customers-${taskId}`}>{choices.map(name => <option key={name} value={name} />)}</datalist>
    <p className="mt-2 text-xs text-muted-foreground" role="status">{state === "saving" ? "Saving…" : state === "saved" ? "Saved" : state === "error" ? "Not saved. Your entry is kept." : "Saves automatically. Clear the field for no customer."}</p>
    {state === "error" && <Button size="sm" variant="outline" className="mt-2" disabled={disabled} onClick={() => void save()}>Retry customer save</Button>}
  </section>;
}
