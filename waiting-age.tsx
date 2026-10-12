import { useEffect, useState } from "react";
import { localDay } from "./day-contracts.js";
import { usePlanningTimeZone } from "./day-zone.js";

export function waitingDays(since: string | null | undefined, timeZone: string, now = new Date()): number | null {
  if (!since || !Number.isFinite(Date.parse(since))) return null;
  // Compare calendar dates, not 24-hour durations: DST and the local midnight
  // boundary must behave like the rest of the day planner.
  const day = (date: Date) => Date.parse(`${localDay(date, timeZone)}T00:00:00Z`);
  return Math.max(0, Math.round((day(now) - day(new Date(since))) / 86_400_000));
}

export function WaitingStatus({ since }: { since?: string | null }) {
  const timeZone = usePlanningTimeZone();
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const refresh = () => setNow(new Date());
    const timer = window.setInterval(refresh, 60_000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);
  const days = waitingDays(since, timeZone, now);
  const title = days === null ? "Waiting start date is unavailable" : `Waiting since ${new Intl.DateTimeFormat("en-GB", {
    timeZone, day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
  }).format(new Date(since!))} (${timeZone})`;
  return <span title={title}>Waiting for response{days !== null && <> · {days} {days === 1 ? "day" : "days"}</>}</span>;
}
