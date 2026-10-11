import { z } from "zod";
import { uxDaySummarySchema, type UxEvent } from "./ux-contracts.js";

export const summaryFileSchema = z.object({ days: z.array(uxDaySummarySchema.extend({ through: z.string() })) });
export type SummaryFile = z.infer<typeof summaryFileSchema>;
export type DaySummary = z.infer<typeof uxDaySummarySchema>;
export const emptyDay = (date: string): DaySummary => ({ date, events: 0, clicks: 0, results: 0, errors: 0, actions: [] });

// Counts only: never retain coordinates, client IDs, submitted notes or file content.
export function countEvents(day: DaySummary, events: UxEvent[]) {
  for (const event of events) {
    day.events++;
    if (event.kind === "result") { day.results++; if (event.outcome === "error") day.errors++; }
    if (event.kind !== "click") continue;
    day.clicks++;
    const action = day.actions.find(a => a.page === event.page && a.action === event.action);
    if (action) action.count++;
    else day.actions.push({ page: event.page, action: event.action, count: 1 });
  }
}
