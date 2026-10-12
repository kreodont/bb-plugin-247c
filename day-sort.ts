import type { DayItem } from "./day-contracts.js";

// Sort every day entry together. Blank time remains distinct from explicit zero.
// Stable ties retain their existing order without rewriting saved ordinals.
export function sortDayItems<T extends Pick<DayItem, "reportedMinutes">>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => {
    const left = a.reportedMinutes, right = b.reportedMinutes;
    if (left === null) return right === null ? 0 : 1;
    if (right === null) return -1;
    return right - left;
  });
}
