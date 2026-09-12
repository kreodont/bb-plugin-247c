import { useState } from "react";
import type { TaskSourceLink } from "./contracts.js";
import { Button } from "./components/ui/button.js";
import { Icon } from "./components/ui/icon.js";
import { sourceUrl } from "./task-sources.js";

const sourceDate = (value: string) => new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" }).format(new Date(value));

export function TaskSources({ links }: { links: TaskSourceLink[] }) {
  const [expanded, setExpanded] = useState(false);
  const safe = links.filter(link => sourceUrl(link.url));
  if (!safe.length) return null;
  const shown = expanded ? safe : safe.slice(0, 3);
  return <nav aria-label="Task sources" className="flex flex-wrap items-center gap-2 rounded-xl border border-primary/20 bg-primary/5 p-3">
    <span className="mr-1 text-sm font-medium">Sources</span>
    {shown.map(link => <a key={link.url} href={link.url} target="_blank" rel="noopener noreferrer"
      title={`${link.origin ? "Original task source" : "Source of an accepted record or change"}\n${link.url}`}
      className="inline-flex max-w-full items-center gap-2 rounded-lg border border-primary/20 bg-background px-3 py-2 text-sm font-medium text-primary hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <span className="truncate">{link.label}</span>
      {link.occurredAt && Number.isFinite(Date.parse(link.occurredAt)) && <time dateTime={link.occurredAt} className="shrink-0 text-xs font-normal text-muted-foreground">{sourceDate(link.occurredAt)}</time>}
      <Icon name="ExternalLink" aria-hidden="true" className="size-3.5 shrink-0" />
    </a>)}
    {safe.length > 3 && <Button type="button" variant="ghost" size="sm" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? "Show less" : `+${safe.length - 3} more`}</Button>}
  </nav>;
}
