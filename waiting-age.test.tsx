// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PlanningTimeZone } from "./day-zone.js";
import { WaitingStatus, waitingDays } from "./waiting-age.js";

afterEach(() => { cleanup(); vi.useRealTimers(); });

it("counts local calendar days across midnight and daylight saving changes", () => {
  const now = new Date("2026-10-12T21:05:00Z");
  expect(waitingDays("2026-10-12T20:55:00Z", "Europe/Berlin", now)).toBe(0);
  expect(waitingDays("2026-10-12T20:55:00Z", "Europe/Athens", now)).toBe(1);
  expect(waitingDays("2026-03-28T23:30:00Z", "Europe/Berlin", new Date("2026-03-29T22:30:00Z"))).toBe(1);
  expect(waitingDays("2026-10-24T22:30:00Z", "Europe/Berlin", new Date("2026-10-25T23:30:00Z"))).toBe(1);
  expect(waitingDays("2026-10-09T12:00:00Z", "Europe/Athens", now)).toBe(4);
  expect(waitingDays("2026-10-20T12:00:00Z", "Europe/Athens", now)).toBe(0);
  expect(waitingDays(null, "UTC", now)).toBeNull();
  expect(waitingDays("invalid", "UTC", now)).toBeNull();
});

it("refreshes at midnight and after focus without a task update", () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-12T20:59:30Z"));
  const view = render(<PlanningTimeZone.Provider value="Europe/Athens"><WaitingStatus since="2026-10-12T10:00:00Z" /></PlanningTimeZone.Provider>);
  expect(screen.getByText("Waiting for response · 0 days").title).toBe("Waiting since 12 Oct 2026, 13:00 (Europe/Athens)");
  act(() => { vi.advanceTimersByTime(60_000); });
  expect(screen.getByText("Waiting for response · 1 day")).toBeTruthy();
  vi.setSystemTime(new Date("2026-10-15T10:00:00Z"));
  fireEvent.focus(window);
  expect(screen.getByText("Waiting for response · 3 days")).toBeTruthy();
  view.unmount(); expect(vi.getTimerCount()).toBe(0);
});

it("does not invent an age for missing history", () => {
  render(<WaitingStatus since={null} />);
  expect(screen.getByText("Waiting for response").title).toBe("Waiting start date is unavailable");
});
