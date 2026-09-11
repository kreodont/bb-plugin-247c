import { createHash } from "node:crypto";
import { syncStartSchema } from "./contracts.js";
import { PolicyError } from "./core/errors.js";
import type { SourceSyncRuntime } from "./source-sync.js";

export const UPDATE_TIME_ZONE = "Europe/Athens";
export const UPDATE_SCHEDULE = "hourly-source-updates";
// BB cron uses the server timezone. Check a minute boundary, then select the
// Athens hour explicitly so this also works if the server changes timezone.
export const UPDATE_CRON = "* * * * *";

export function hourlyUpdateSlot(date: Date): string | null {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: UPDATE_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(date).map(part => [part.type, part.value]));
  const hour = Number(parts.hour);
  return parts.minute === "00" && hour >= 8 && hour <= 20 ? `${parts.year}-${parts.month}-${parts.day}T${parts.hour}` : null;
}

export function hourlyUpdateId(slot: string): string {
  const namespace = Buffer.from("e4aebc9aae3b4a51894a69c2c1e21d3d", "hex");
  const bytes = createHash("sha1").update(namespace).update(`247c-hourly:${slot}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function scheduledSourceUpdate(sync: SourceSyncRuntime, enabled: () => Promise<boolean>, date = new Date()): Promise<string | null> {
  const slot = hourlyUpdateSlot(date);
  if (!slot || !await enabled()) return null;
  if (sync.store.active().length) return null;
  const requestId = hourlyUpdateId(slot);
  // The native cron runner and a repeated callback must not create a second
  // check for a completed or failed attempt in the same hourly slot.
  if (sync.repo.db.prepare("SELECT id FROM source_sync_runs WHERE id=?").get(requestId)) return null;
  const previous = sync.repo.db.prepare("SELECT id FROM source_sync_runs WHERE status IN ('completed','partial') ORDER BY rowid DESC LIMIT 1").get() as { id: string } | undefined;
  if (!previous) throw new PolicyError("Для расписания сначала выполни проверку вручную и выбери аккаунт, модель и рабочую папку.");
  const source = sync.store.request(previous.id).input;
  const input = syncStartSchema.parse({ requestId, since: null, request: { ...source.request,
    input: [{ type: "text", text: "Плановая почасовая проверка обновлений 247C по поручению пользователя. Проанализируй готовую выгрузку почты, Slack и Jira и подготовь предложения для задач 247C. Прочитай все страницы выгрузки и заверши прогон штатной отправкой результата. Предложения ждут принятия пользователем в панели 247C.", mentions: [] }],
  } });
  try { return (await sync.start(input)).id; }
  catch (error) {
    // A manual check may have started after the initial read.
    if (sync.store.active().length) return null;
    throw error;
  }
}
