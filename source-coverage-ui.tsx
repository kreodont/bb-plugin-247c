import type { SourceCoverage } from "./updater-health-contracts.js";

export function SourceCoverageCard({ coverage, name, date }: { coverage: SourceCoverage; name: string; date: (value: string) => string }) {
  const scan = coverage.chatScan;
  const availableChatsChecked = coverage.status === "partial" && !!scan && scan.available > 0
    && scan.checked === scan.available && scan.pendingMessages === 0 && coverage.gaps.length === 0;
  const limitations = coverage.limitations ?? [];
  return <section className="rounded-xl border border-border bg-card p-4" aria-label={`${name} collection coverage`}>
    <h2 className="font-medium">{name}</h2>
    <p className="mt-2 text-xs text-muted-foreground">Last collection: {date(coverage.collectedAt)}</p>
    <p className={`mt-3 text-sm ${coverage.status === "complete" || availableChatsChecked ? "" : "text-destructive"}`}>{coverage.status === "complete" ? "Collection complete" : availableChatsChecked ? "Available chats checked" : coverage.status === "partial" ? "Collection incomplete" : "Source unavailable"}</p>
    {coverage.fullyCheckedThrough && <p className="mt-1 text-xs text-muted-foreground">Fully checked through {date(coverage.fullyCheckedThrough)}</p>}
    {availableChatsChecked ? <p className="mt-1 text-xs text-muted-foreground">Available chat lists have been checked and their message queue is empty. Access and history limits are listed below.</p> : coverage.status !== "complete" && <p className="mt-1 text-xs text-muted-foreground">Full coverage not confirmed for {date(coverage.since)} to {date(coverage.collectedAt)}. Some records were collected; gaps remain.</p>}
    <p className="mt-2 text-xs text-muted-foreground">Saved records: {coverage.savedRecords}{scan ? <> · Available chats checked: {scan.checked} of {scan.available} · Excluded chats: {scan.excluded} · Messages queued: {scan.pendingMessages}</> : coverage.scannedChats !== undefined && coverage.discoveredChats !== undefined && <> · Chats checked: {coverage.scannedChats} of {coverage.discoveredChats}</>}</p>
    {coverage.gaps.length > 0 && <details className="mt-2 text-xs text-muted-foreground"><summary className="cursor-pointer">Collection gaps · {coverage.gaps.length}</summary>{coverage.gaps.map((gap, index) => <p key={index} className="mt-1 whitespace-pre-wrap break-words">{gap}</p>)}</details>}
    {limitations.length > 0 && <details className="mt-2 text-xs text-muted-foreground"><summary className="cursor-pointer">Access and history limits · {limitations.length}</summary>{limitations.map((limit, index) => <p key={index} className="mt-1 whitespace-pre-wrap break-words">{limit}</p>)}{coverage.status !== "complete" && <p className="mt-2">Full coverage remains unconfirmed for {date(coverage.since)} to {date(coverage.collectedAt)}. Excluded sources and unavailable history may contain unseen work.</p>}</details>}
    <p className="mt-2 text-xs text-muted-foreground">Collection coverage is separate from proposal analysis.</p>
  </section>;
}
