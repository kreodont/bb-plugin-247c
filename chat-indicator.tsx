import { Icon } from "./components/ui/icon.js";

// A filled speech bubble marks an existing chat without replacing priority
// colors or implying that an idle conversation is currently running.
export function ChatIndicator() {
  return <span aria-hidden="true" title="Chat open" data-c247-chat-open="" className="inline-flex size-6 shrink-0 items-center justify-center rounded-md bg-foreground text-background"><Icon name="MessageSquare" className="size-3.5" /></span>;
}
