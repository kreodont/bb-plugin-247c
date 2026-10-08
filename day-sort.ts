import type { DayItem } from "./day-contracts.js";

export const DAY_SORT_KEY = "247c:day-sort";
export const durationSorts = {
  "planned-asc": { label: "Planned: shortest first", field: "plannedMinutes", direction: 1 },
  "planned-desc": { label: "Planned: longest first", field: "plannedMinutes", direction: -1 },
  "reported-asc": { label: "Reported: shortest first", field: "reportedMinutes", direction: 1 },
  "reported-desc": { label: "Reported: longest first", field: "reportedMinutes", direction: -1 },
  "actual-asc": { label: "Actual: shortest first", field: "actualMinutes", direction: 1 },
  "actual-desc": { label: "Actual: longest first", field: "actualMinutes", direction: -1 },
} as const;
export type DaySort = "manual" | keyof typeof durationSorts;
export function isDaySort(value: unknown): value is DaySort {
  return typeof value === "string" && (value === "manual" || Object.hasOwn(durationSorts, value));
}
export function savedDaySort(): DaySort {
  try {
    const value = window.localStorage.getItem(DAY_SORT_KEY);
    if (isDaySort(value)) return value;
  } catch { /* Use manual order when browser storage is unavailable. */ }
  return "manual";
}

type Sortable = Pick<DayItem, "kind" | "plannedMinutes" | "reportedMinutes" | "actualMinutes">;
export function sortDayItems<T extends Sortable>(items: readonly T[], sort: DaySort): T[] {
  if (sort === "manual") return [...items];
  const { field, direction } = durationSorts[sort];
  const tasks = items.filter(item => item.kind === "task").sort((a, b) => {
    const left = a[field], right = b[field];
    // Blank time is unknown, not zero, and stays last in either direction.
    if (left === null) return right === null ? 0 : 1;
    if (right === null) return -1;
    return (left - right) * direction;
  });
  // Preserve calendar order and stable ties without changing saved ordinals.
  let next = 0;
  return items.map(item => item.kind === "task" ? tasks[next++] : item);
}
