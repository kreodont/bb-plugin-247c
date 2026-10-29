import { knowledgePathSchema } from "./knowledge-search.js";
import { composerDefaultsSchema } from "./local-settings.js";
import { calendarCommandSchema } from "./calendar-script.js";
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
    slackLinksInBrowser: { type: "boolean", label: "Open Slack sources in the browser", description: "Open Slack message links in BB chats and source buttons through the web route, avoiding the desktop-app launch page. Saved locally; original messages and source URLs are preserved.", default: false },
    sidebarPluginLinks: { type: "boolean", label: "Show plugin links above chats", description: "Restore text links for visible plugin panels above the chat list in BB's icon-rail layout, including 247C counts and reported time. Saved in the local settings patch.", default: false },
    sourceUpdaterProjectId: { type: "string", label: "Source updater project", description: "Project containing the existing script automation to monitor for missed runs, failures and pauses. Monitoring never starts a model or changes the schedule.", default: "", experimental_schema: z.string().trim().max(200) },
    sourceUpdaterAutomationId: { type: "string", label: "Source updater automation", description: "Existing BB automation ID. Configure both updater IDs to enable persistent health warnings and an app-wide notification.", default: "", experimental_schema: z.string().trim().max(200) },
    sourceUpdaterStatusFile: { type: "string", label: "Source updater status file", description: "Optional absolute path to a script-written status snapshot. Includes manual analysis recovery in updater health without rerunning source collection.", default: "", experimental_schema: z.string().trim().max(4096) },
    knowledgeDirectory: { type: "string", label: "Knowledge export folder", description: "Empty dedicated local folder for generated OpenKnowledge snapshots of accepted notes and imported documents. Leave blank to disable. Keep outside the plugin checkout.", default: "", experimental_schema: knowledgePathSchema },
    openKnowledgeExecutable: { type: "string", label: "OpenKnowledge executable", description: "Absolute path to the local okn binary. Enables ranked excerpts in c247_knowledge when an export folder is configured. Search uses no model and suppresses telemetry; failures fall back to SQLite.", default: "", experimental_schema: knowledgePathSchema },
    localSettingsPatch: { type: "string", label: "Local settings patch", description: "Absolute path to a private JSON settings patch, applied whenever 247C loads, including after updates. Keep it outside the plugin checkout. Leave blank to use the automatically maintained patch next to the database.", default: "", experimental_schema: z.string().trim().max(4096) },
    composerDefaults: { type: "string", label: "Conversation account and model", description: "Optional JSON with providerId and model for new work, review discussions and source checks. Leave {} to use the native composer defaults and previous conversation selection.", default: "{}", experimental_schema: z.string().max(1000).refine(value => { try { composerDefaultsSchema.parse(JSON.parse(value)); return true; } catch { return false; } }, "Use a JSON object with both providerId and model, or {}.") },
    calendarReaderCommand: { type: "string", label: "Calendar reader command", description: "Optional JSON argument array for a local calendar reader. It receives dates and known meetings on stdin and returns normalized calendar events. Leave [] to use the connected Google Calendar.", default: "[]", experimental_schema: z.string().max(32000).refine(value => { try { calendarCommandSchema.parse(JSON.parse(value)); return true; } catch { return false; } }, "Use a JSON argument array with an absolute executable path.") },
    sourceImportRoot: { type: "string", label: "Local collector import folder", description: "Allow receipt-verified Teams, Outlook and ClickUp proposal bundles from this local folder. Leave blank to disable.", default: "", experimental_schema: z.string().trim().max(4096) },
    dayPlannerProjectId: { type: "string", label: "Day planner project", description: "BB project ID containing the existing day-planning automation.", default: "", experimental_schema: z.string().trim().max(200) },
    dayPlannerAutomationId: { type: "string", label: "Day planner automation", description: "Existing BB automation ID to run with Create day plan. Leave blank to hide the button.", default: "", experimental_schema: z.string().trim().max(200) },
    threadProjectId: { type: "string", label: "Thread project", description: "BB project ID for all new 247C conversations, reviews and source checks. Uses its default project folder. Leave blank to use the composer selection and personal review workspaces.", default: "", experimental_schema: z.string().trim().max(200) },
    scopeAgentsToProject: { type: "boolean", label: "Limit agent context to the thread project", description: "Expose 247C agent tools and their instructions only in the configured Thread project and conversations created by 247C. Other projects keep the plugin UI and CLI. With no Thread project selected, only 247C-created conversations receive the agent tools. Applies when a provider session is next constructed.", default: false },
    threadInstructions: { type: "string", label: "Thread instructions", description: "Additional instructions for 247C work, review and source-check sessions, and threads in the configured Thread project. Applied when BB next starts or resumes a provider session. Keep required JSON formats and exact source quotations intact.", default: "", experimental_multiline: true, experimental_schema: z.string().trim().max(1500) },
    codexReviewer: { type: "string", label: "Codex verification model", default: "gpt-5.6-sol", experimental_schema: z.string().trim().min(1).max(200) },
    claudeReviewer: { type: "string", label: "Personal Claude verification model (sessions with criteria)", default: "claude-fable-5-1", experimental_schema: z.string().trim().min(1).max(200) },
    maximumRepairs: { type: "number", label: "Repair attempts after verification", default: 2, experimental_schema: z.number().int().min(0).max(2) },
    sessionMinutes: { type: "number", label: "Review or verification timeout in minutes (conversations have no timeout)", default: 20, experimental_schema: z.number().int().min(1).max(60) },
    sources: { type: "string", label: "Sources: JSON account, Slack, Jira and calendar profile", default: "{}", experimental_schema: z.string().max(32000).refine(value => { try { parseSourceConfig(value); return true; } catch { return false; } }, "A valid source profile JSON is required.") },
    calendarMeetings: { type: "boolean", label: "Import work Google Calendar meetings when checking updates", default: true },
    reportMeetingsWhenPlanned: { type: "boolean", label: "Meetings: report planned time immediately", description: "Set automatic reported time to planned time when a meeting enters the plan, including upcoming meetings. Manual reported corrections always win. When disabled, wait until the meeting ends.", default: false },
    hourlyUpdates: { type: "boolean", label: "Check sources on the configured hourly schedule", default: false },
    updateWeekdaysOnly: { type: "boolean", label: "Hourly checks: weekdays only", description: "Skip Saturday and Sunday in the configured time zone. The next check resumes from the saved source checkpoints; manual checks remain available.", default: false },
    timeZone: { type: "string", label: "Planning and hourly checks: time zone", description: "IANA name, such as Europe/London. Changing it affects future date calculations; existing manual entries keep their dates.", default: DAY_TIME_ZONE, experimental_schema: timeZoneSchema },
    updateStartHour: { type: "number", label: "Hourly checks: first hour (inclusive)", default: 8, experimental_schema: z.number().int().min(0).max(23) },
    updateEndHour: { type: "number", label: "Hourly checks: last hour (inclusive)", description: "An end before the start covers an overnight window.", default: 20, experimental_schema: z.number().int().min(0).max(23) },
    workProvider: { type: "string", label: "New work conversations: preferred provider", description: "Leave blank to use the native BB selection.", default: "", experimental_schema: z.string().trim().max(200) },
    workModel: { type: "string", label: "New work conversations: preferred model", default: "", experimental_schema: z.string().trim().max(200) },
    syncProvider: { type: "string", label: "Source checks: preferred provider", description: "Used by the native composer and hourly checks. Blank lets hourly checks reuse the last successful account.", default: "", experimental_schema: z.string().trim().max(200) },
    syncModel: { type: "string", label: "Source checks: preferred model", description: "Used by the native composer and hourly checks. Blank lets hourly checks reuse the last successful model.", default: "", experimental_schema: z.string().trim().max(200) },
    syncReasoningLevel: { type: "string", label: "Hourly checks: reasoning level", description: "Override the saved reasoning level for hourly checks. Blank reuses the last successful check's selection.", default: "", experimental_schema: z.enum(["", "low", "medium", "high", "xhigh", "max", "none", "ultra", "ultracode"]) },
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
    if (key === "localSettingsPatch" || !Object.hasOwn(settingDescriptors, key)) throw new Error("Invalid local settings patch: an unknown setting was found. Check the patch against the installed version.");
    const descriptor = settingDescriptors[key as keyof LocalSettings];
    if (typeof entry !== descriptor.type) throw new Error(`Invalid local settings patch: check ${key}.`);
    if ("experimental_schema" in descriptor && !descriptor.experimental_schema.safeParse(entry).success) throw new Error(`Invalid local settings patch: check ${key}.`);
    result[key] = entry;
  }
  return result;
}
