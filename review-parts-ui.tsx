import { useEffect, useState } from "react";
import type { PartReview } from "./contracts.js";
import { Button } from "./components/ui/button.js";

export function usePartSelection(id: string, parts: string[], disabled: boolean, onChange?: (parts: string[] | undefined) => void, supplied?: string[], note = "Unchecked parts stay pending. Supporting quotes remain available as evidence.") {
  const signature = JSON.stringify([id, parts]);
  const [selected, setSelected] = useState(() => new Set(parts));
  useEffect(() => { setSelected(new Set(parts)); }, [signature]);
  const picked = parts.filter(part => supplied ? supplied.includes(part) : selected.has(part));
  const change = (next: Set<string>) => {
    setSelected(next);
    onChange?.(next.size === parts.length ? undefined : parts.filter(part => next.has(part)));
  };
  return {
    picked, all: picked.length === parts.length,
    bar: <div className="flex flex-wrap items-center gap-3 border-t border-border px-4 py-3 text-xs text-muted-foreground">
      <span>Selected {picked.length} of {parts.length} parts</span>
      <Button data-c247-ux-action="proposal-select-all" variant="ghost" size="sm" disabled={disabled} onClick={() => change(new Set(picked.length === parts.length ? [] : parts))}>{picked.length === parts.length ? "Clear parts" : "Select all parts"}</Button>
      <p className="w-full">{note}</p>
    </div>,
    checkbox: (part: string, label: string) => <label className="flex items-start gap-2 text-sm font-medium">
      <input data-c247-ux-action="proposal-select" type="checkbox" className="mt-0.5 accent-primary" aria-label={`Select part: ${label}`} checked={picked.includes(part)} disabled={disabled}
        onChange={e => { const next = new Set(picked); e.target.checked ? next.add(part) : next.delete(part); change(next); }} />{label}
    </label>,
  };
}

export function PartReviewNote({ review }: { review?: PartReview }) {
  if (!review) return null;
  return <p className="border-t border-border px-4 py-3 text-xs text-muted-foreground">
    Reviewed in parts: {review.accepted.length} accepted, {review.rejected.length} rejected, {review.remaining.length} kept for later.
    {review.remainingId && " The remaining parts have a separate proposal."} Original content and decisions are preserved in history.
  </p>;
}

export function partOutcome(review: PartReview | undefined, part: string): string {
  return review?.accepted.includes(part) ? " · Accepted" : review?.rejected.includes(part) ? " · Rejected" : review?.remaining.includes(part) ? " · Kept for later" : "";
}
