import { z } from "zod";
import { homedir } from "node:os";
import { resolve } from "node:path";

// Installation-specific data belongs in BB settings, never in the source tree.
export const sourceConfigSchema = z.object({
  profilePath: z.string().default(""),
  expectedEmail: z.union([z.email(), z.literal("")]).default(""),
  accountPool: z.object({
    pluginId: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    accountId: z.string().uuid(),
    organizationUuid: z.string().uuid(),
  }).strict().nullable().default(null),
  calendarId: z.string().min(1).default("primary"),
  jiraSite: z.string().regex(/^(?:[a-z0-9-]+\.atlassian\.net)?$/).default(""),
  jiraScope: z.string().min(1).max(4000).default("assignee = currentUser() OR reporter = currentUser()"),
  jiraProjects: z.array(z.string().regex(/^[A-Z][A-Z0-9]*$/)).max(100).default([]).transform(projects => [...new Set(projects)]),
  slackChannels: z.array(z.string().regex(/^[A-Za-z0-9_-]+$/)).max(100).default([]),
  slackGroups: z.array(z.string().regex(/^[A-Z0-9]+$/)).max(100).default([]),
  slackUserId: z.string().regex(/^[A-Z0-9]*$/).default(""),
  mailFilters: z.string().max(4000).default("-in:draft -in:chats -in:spam -in:trash"),
  analysisContext: z.string().max(16000).default(""),
}).strict();
export type SourceConfig = z.infer<typeof sourceConfigSchema>;
export const defaultSourceConfig = sourceConfigSchema.parse({});
export function parseSourceConfig(text: string): SourceConfig {
  const config = sourceConfigSchema.parse(JSON.parse(text || "{}"));
  return { ...config, calendarId: config.calendarId === "primary" && config.expectedEmail ? config.expectedEmail : config.calendarId };
}
export function sourceProfile(config: SourceConfig): string {
  if (!config.profilePath.trim()) throw new Error("Set profilePath in the sources setting to your configured Claude profile.");
  return resolve(config.profilePath.startsWith("~/") ? `${homedir()}/${config.profilePath.slice(2)}` : config.profilePath);
}
