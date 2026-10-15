import { useEffect, useRef, useState } from "react";
import { useBbNavigate, useSdk, type PluginThreadHeaderActionProps } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Button } from "./components/ui/button.js";
import { Icon } from "./components/ui/icon.js";
import { cn } from "./lib/utils.js";
import { UxScope } from "./ux-app.js";
import { beginUxAction } from "./ux-client.js";

const TERMINAL_TITLE = "247C · ZSH";
const pending = new Map<string, Promise<string>>();

function terminalForThread(sdk: ReturnType<typeof useSdk>, threadId: string): Promise<string> {
  const existing = pending.get(threadId);
  if (existing) return existing;
  const request = (async () => {
    const scope = { kind: "thread" as const, threadId };
    const { sessions } = await sdk.terminals.list({ scope });
    const terminal = sessions.find(item => item.threadId === threadId && item.title === TERMINAL_TITLE
      && (item.status === "running" || item.status === "starting"));
    if (terminal) return terminal.id;
    // Let BB resolve the thread's machine and workspace. Do not send a command
    // into an existing terminal, which might be running unrelated work.
    return (await sdk.terminals.create({ scope, title: TERMINAL_TITLE, cols: 100, rows: 30,
      start: { mode: "command", command: "exec zsh -l" } })).id;
  })();
  pending.set(threadId, request);
  void request.finally(() => { if (pending.get(threadId) === request) pending.delete(threadId); }).catch(() => {});
  return request;
}

function ThreadTerminal({ threadId, isCompactViewport }: PluginThreadHeaderActionProps) {
  const sdk = useSdk(), navigate = useBbNavigate();
  const [busy, setBusy] = useState(false);
  const opening = useRef(false), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function open() {
    if (opening.current) return;
    opening.current = true; setBusy(true);
    const finish = beginUxAction("thread-terminal");
    try {
      if (typeof navigate.experimental_openTerminal !== "function") throw new Error("Update BB to open terminals from this button.");
      const terminalId = await terminalForThread(sdk, threadId);
      // A late reply must not open the old thread's terminal in another chat.
      if (!mounted.current) return;
      if (!await navigate.experimental_openTerminal({ terminalId })) throw new Error("The terminal could not be shown. Check that this thread has an available workspace and zsh is installed on its machine, then try again.");
      finish("ok");
    } catch (error) {
      finish("error");
      if (mounted.current) toast.error("Could not open ZSH", { description: error instanceof Error ? error.message : "Try again." });
    } finally { opening.current = false; if (mounted.current) setBusy(false); }
  }
  return <UxScope page="thread" view={threadId}><span title="Open ZSH in this thread's workspace" className="inline-flex"><Button type="button" size="sm" variant="outline"
    data-c247-ux-action="thread-terminal" aria-label="Open ZSH terminal"
    className={cn("h-7 shrink-0", isCompactViewport ? "w-7 px-0" : "px-2")} disabled={busy} onClick={() => void open()}>
    <Icon name={busy ? "Loading" : "Terminal"} aria-hidden="true" />{!isCompactViewport && "ZSH"}
  </Button></span></UxScope>;
}

export function ThreadTerminalAction(props: PluginThreadHeaderActionProps) {
  return <ThreadTerminal key={props.threadId} {...props} />;
}
