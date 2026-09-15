import { DAY_TIME_ZONE } from "./day-contracts.js";
import { z } from "zod";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { parseSourceConfig } from "./source-config.js";

export const timeZoneSchema = z.string().min(1).max(100).refine(value => {
  try { new Intl.DateTimeFormat("en", { timeZone: value }).format(); return true; } catch { return false; }
}, "Enter a valid IANA time zone.");
export const excludedReviewModelsSchema = z.array(z.object({ providerId: z.string().min(1).max(200), model: z.string().min(1).max(200) }).strict()).max(100);
export function parseExcludedReviewModels(value = "[]") { return excludedReviewModelsSchema.parse(JSON.parse(value)); }
export const settingDescriptors = {
    threadProjectId: { type: "string", label: "Thread project", description: "BB project ID for all new 247C conversations, reviews and source checks. Uses its default project folder. Leave blank to use the composer selection and personal review workspaces.", default: "", experimental_schema: z.string().trim().max(200) },
    codexReviewer: { type: "string", label: "Codex verification model", default: "gpt-5.6-sol", experimental_schema: z.string().trim().min(1).max(200) },
    claudeReviewer: { type: "string", label: "Personal Claude verification model (sessions with criteria)", default: "claude-fable-5-1", experimental_schema: z.string().trim().min(1).max(200) },
    maximumRepairs: { type: "number", label: "Repair attempts after verification", default: 2, experimental_schema: z.number().int().min(0).max(2) },
    sessionMinutes: { type: "number", label: "Review or verification timeout in minutes (conversations have no timeout)", default: 20, experimental_schema: z.number().int().min(1).max(60) },
    sources: { type: "string", label: "Sources: JSON account, Slack, Jira and calendar profile", default: "{}", experimental_schema: z.string().max(32000).refine(value => { try { parseSourceConfig(value); return true; } catch { return false; } }, "A valid source profile JSON is required.") },
    calendarMeetings: { type: "boolean", label: "Import work Google Calendar meetings when checking updates", default: true },
    hourlyUpdates: { type: "boolean", label: "Check sources on the configured hourly schedule", default: false },
    timeZone: { type: "string", label: "Planning and hourly checks: time zone", description: "IANA name, such as Europe/London. Changing it affects future date calculations; existing manual entries keep their dates.", default: DAY_TIME_ZONE, experimental_schema: timeZoneSchema },
    updateStartHour: { type: "number", label: "Hourly checks: first hour (inclusive)", default: 8, experimental_schema: z.number().int().min(0).max(23) },
    updateEndHour: { type: "number", label: "Hourly checks: last hour (inclusive)", description: "An end before the start covers an overnight window.", default: 20, experimental_schema: z.number().int().min(0).max(23) },
    workProvider: { type: "string", label: "New work conversations: preferred provider", description: "Leave blank to use the native BB selection.", default: "", experimental_schema: z.string().trim().max(200) },
    workModel: { type: "string", label: "New work conversations: preferred model", default: "", experimental_schema: z.string().trim().max(200) },
    syncProvider: { type: "string", label: "Source checks: preferred provider", default: "", experimental_schema: z.string().trim().max(200) },
    syncModel: { type: "string", label: "Source checks: preferred model", default: "", experimental_schema: z.string().trim().max(200) },
    excludedReviewModels: { type: "string", label: "Review models unavailable on local accounts (JSON)", description: "Array of providerId/model pairs. Model IDs are matched after normalizing aliases and context-window suffixes.", default: "[]", experimental_schema: z.string().max(32000).refine(value => { try { parseExcludedReviewModels(value); return true; } catch { return false; } }, "Enter a valid list of provider/model exclusions.") },
} as const;
export function defineSettings(bb: BbPluginApi) { return bb.settings.define(settingDescriptors); }
export type SettingsHandle = ReturnType<typeof defineSettings>;
export type LocalSettings = Awaited<ReturnType<SettingsHandle["get"]>>;

// Validate the entire patch before any setting is persisted. Never include
// rejected values in diagnostics: source configuration may contain private data.
export function validateSettings(value: unknown): Partial<LocalSettings> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid local settings patch: settings must be an object.");
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!Object.hasOwn(settingDescriptors, key)) throw new Error("Invalid local settings patch: an unknown setting was found. Check the patch against the installed version.");
    const descriptor = settingDescriptors[key as keyof LocalSettings];
    if (typeof entry !== descriptor.type) throw new Error(`Invalid local settings patch: check ${key}.`);
    if ("experimental_schema" in descriptor && !descriptor.experimental_schema.safeParse(entry).success) throw new Error(`Invalid local settings patch: check ${key}.`);
    result[key] = entry;
  }
  return result;
}
