import { expect, it } from "vitest";
import { durationSorts, isDaySort, sortDayItems } from "./day-sort.js";

it.each(Object.entries(durationSorts))("sorts %s numerically, keeping blanks last and calendar order intact", (sort, { field, direction }) => {
  const row = (id: string, minutes: number | null, kind: "task" | "meeting" = "task") => Object.freeze({ id, kind, plannedMinutes: null, reportedMinutes: null, actualMinutes: null, [field]: minutes });
  const items = Object.freeze([row("early meeting", 120, "meeting"), row("late meeting", 1, "meeting"), row("blank", null), row("long", 120), row("short", 9), row("zero", 0), row("tie", 9)]);
  if (!isDaySort(sort)) throw new Error("Invalid test sort");
  expect(sortDayItems(items, sort).map(i => i.id)).toEqual(["early meeting", "late meeting", ...(direction === 1 ? ["zero", "short", "tie", "long"] : ["long", "short", "tie", "zero"]), "blank"]);
  expect(sortDayItems(items, "manual")).toEqual(items);
});

it("rejects invalid persisted sort modes", () => {
  expect(isDaySort("manual")).toBe(true);
  for (const value of [null, undefined, "", "constructor", "__proto__", "planned", {}]) expect(isDaySort(value)).toBe(false);
});
