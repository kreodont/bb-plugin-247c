import type { SourceCoverage } from "./updater-health-contracts.js";

export function SourceCoverageCard({ coverage, name, date }: { coverage: SourceCoverage; name: string; date: (value: string) => string }) {
  return <section className="rounded-xl border border-border bg-card p-4" aria-label={`${name} collection coverage`}>
    <h2 className="font-medium">{name}</h2>
    <p className="mt-2 text-xs text-muted-foreground">Last collection: {date(coverage.collectedAt)}</p>
    <p className={`mt-3 text-sm ${coverage.status === "complete" ? "" : "text-destructive"}`}>{coverage.status === "complete" ? "Collection complete" : coverage.status === "partial" ? "Collection incomplete" : "Source unavailable"}</p>
    {coverage.fullyCheckedThrough && <p className="mt-1 text-xs text-muted-foreground">Fully checked through {date(coverage.fullyCheckedThrough)}</p>}
    {coverage.status !== "complete" && <p className="mt-1 text-xs text-muted-foreground">Full coverage not confirmed for {date(coverage.since)} to {date(coverage.collectedAt)}. Some records were collected; gaps remain.</p>}
    <p className="mt-2 text-xs text-muted-foreground">Saved records: {coverage.savedRecords}{coverage.scannedChats !== undefined && coverage.discoveredChats !== undefined && <> · Chats checked: {coverage.scannedChats} of {coverage.discoveredChats}</>}</p>
    {coverage.gaps.length > 0 && <details className="mt-2 text-xs text-muted-foreground"><summary className="cursor-pointer">Collection gaps · {coverage.gaps.length}</summary>{coverage.gaps.map((gap, index) => <p key={index} className="mt-1 whitespace-pre-wrap break-words">{gap}</p>)}</details>}
    <p className="mt-2 text-xs text-muted-foreground">Collection coverage is separate from proposal analysis.</p>
  </section>;
}
