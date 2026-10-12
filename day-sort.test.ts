import { expect, it } from "vitest";
import { sortDayItems } from "./day-sort.js";

it("sorts tasks and meetings together by reported descending without mutating input", () => {
  const row = (id: string, reportedMinutes: number | null, kind = "task") => Object.freeze({ id, reportedMinutes, kind });
  const items = Object.freeze([row("meeting", 15, "meeting"), row("blank", null), row("long", 120), row("zero", 0), row("long meeting", 60, "meeting"), row("tie", 15), row("short", 9)]);
  expect(sortDayItems(items).map(i => i.id)).toEqual(["long", "long meeting", "meeting", "tie", "short", "zero", "blank"]);
  expect(items.map(i => i.id)).toEqual(["meeting", "blank", "long", "zero", "long meeting", "tie", "short"]);
});
