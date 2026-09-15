import { DAY_TIME_ZONE } from "./day-contracts.js";
import { createHash } from "node:crypto";
import { syncStartSchema } from "./contracts.js";
import { PolicyError } from "./core/errors.js";
import type { SourceSyncRuntime } from "./source-sync.js";

export const UPDATE_TIME_ZONE = DAY_TIME_ZONE; // Compatibility default; installed settings override it.
type Schedule = { timeZone: string; updateStartHour: number; updateEndHour: number };
const defaultSchedule: Schedule = { timeZone: UPDATE_TIME_ZONE, updateStartHour: 8, updateEndHour: 20 };
export const UPDATE_SCHEDULE = "hourly-source-updates";
// BB cron uses the server timezone. Check a minute boundary, then select the
// configured hour explicitly so this also works if the server changes timezone.
export const UPDATE_CRON = "* * * * *";

export function hourlyUpdateSlot(date: Date, schedule = defaultSchedule): string | null {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: schedule.timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(date).map(part => [part.type, part.value]));
  const hour = Number(parts.hour);
  const inWindow = schedule.updateStartHour <= schedule.updateEndHour
    ? hour >= schedule.updateStartHour && hour <= schedule.updateEndHour
    : hour >= schedule.updateStartHour || hour <= schedule.updateEndHour;
  return parts.minute === "00" && inWindow ? `${parts.year}-${parts.month}-${parts.day}T${parts.hour}` : null;
}

export function hourlyUpdateId(slot: string): string {
  const namespace = Buffer.from("e4aebc9aae3b4a51894a69c2c1e21d3d", "hex");
  const bytes = createHash("sha1").update(namespace).update(`247c-hourly:${slot}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function scheduledSourceUpdate(sync: SourceSyncRuntime, enabled: () => Promise<boolean>, date = new Date(), schedule = defaultSchedule): Promise<string | null> {
  const slot = hourlyUpdateSlot(date, schedule);
  if (!slot || !await enabled()) return null;
  if (sync.store.active().length) return null;
  const requestId = hourlyUpdateId(slot);
  // The native cron runner and a repeated callback must not create a second
  // check for a completed or failed attempt in the same hourly slot.
  if (sync.repo.db.prepare("SELECT id FROM source_sync_runs WHERE id=?").get(requestId)) return null;
  const previous = sync.repo.db.prepare("SELECT id FROM source_sync_runs WHERE status IN ('completed','partial') AND json_extract(request_json,'$.externalImport') IS NULL ORDER BY rowid DESC LIMIT 1").get() as { id: string } | undefined;
  if (!previous) throw new PolicyError("Before enabling the schedule, run a manual check and select an account, model and workspace.");
  const source = sync.store.request(previous.id).input;
  if (!source) throw new PolicyError("The previous native check has no launch request.");
  const input = syncStartSchema.parse({ requestId, since: null, request: { ...source.request,
    input: [{ type: "text", text: "Scheduled hourly 247C update check requested by the user. Analyze the prepared email, Slack and Jira export and propose updates to 247C tasks. Read every export page and finish the run by submitting the result through the standard tool. Proposals await user acceptance in the 247C panel.", mentions: [] }],
  } });
  try { return (await sync.start(input)).id; }
  catch (error) {
    // A manual check may have started after the initial read.
    if (sync.store.active().length) return null;
    throw error;
  }
}
