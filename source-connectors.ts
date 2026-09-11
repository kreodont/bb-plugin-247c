import { defaultSourceConfig, sourceProfile, type SourceConfig } from "./source-config.js";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { SyncSource } from "./contracts.js";

const execute = promisify(execFile);
export const SOURCE_PROFILE = join(homedir(), ".claude-work");
export const READ_TOOLS: Record<SyncSource, readonly string[]> = {
  gmail: ["search_threads", "get_thread"],
  slack: ["slack_search_public_and_private", "slack_read_channel", "slack_read_thread"],
  jira: ["searchJiraIssuesUsingJql", "getJiraIssue"],
};
export interface SourceConnector {
  call(tool: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
  close(): Promise<void>;
}
export type SourceConnections = Record<SyncSource, SourceConnector | { error: string }>;
export const WORK_CALENDAR = "primary";
export function sourceError(error: unknown): string {
  return String(error instanceof Error ? error.message : error)
    .replace(/Bearer\s+[^\s"'<>]+/gi, "Bearer [redacted]").replace(/sk-ant-[A-Za-z0-9_-]+/g, "[redacted]").slice(0, 1000);
}

type Credential = { accessToken?: string; expiresAt?: number; scopes?: string[] };
async function credential(profile: string): Promise<Credential> {
  let raw: string;
  if (process.platform === "darwin") {
    const service = `Claude Code-credentials-${createHash("sha256").update(profile.normalize("NFC")).digest("hex").slice(0, 8)}`;
    try { raw = (await execute("/usr/bin/security", ["find-generic-password", "-a", userInfo().username, "-w", "-s", service], { timeout: 8000, maxBuffer: 1024 * 1024 })).stdout; }
    catch { throw new Error("Не удалось прочитать вход Claude Work из Связки ключей. Открой Claude Work и проверь вход."); }
  } else {
    try { raw = await readFile(join(profile, ".credentials.json"), "utf8"); }
    catch { throw new Error("Нет сохранённого входа Claude Work на сервере BB."); }
  }
  try { return JSON.parse(raw).claudeAiOauth ?? {}; }
  catch { throw new Error("Не удалось прочитать данные входа Claude Work."); }
}

async function accessToken(profile: string, signal: AbortSignal, expectedEmail: string): Promise<string> {
  if (!expectedEmail) throw new Error("Укажи expectedEmail в настройке sources перед подключением источников.");
  // Stay on the intended corporate identity. The token never leaves this module,
  // its issuing service and the issuer's MCP proxy; it is never given to a model.
  const identity = JSON.parse(await readFile(join(profile, ".claude.json"), "utf8")).oauthAccount?.emailAddress;
  if (identity?.toLowerCase() !== expectedEmail.toLowerCase()) throw new Error("Аккаунт профиля источников не совпадает с expectedEmail в настройках 247C.");
  let auth = await credential(profile);
  if (auth.expiresAt && auth.expiresAt < Date.now() + 60000) {
    // Let Claude own token rotation and its credential store. This command only
    // checks one connector; it makes no inference request and consumes no model tokens.
    try { await execute("claude", ["mcp", "get", "claude.ai Gmail"], {
      env: { ...process.env, CLAUDE_CONFIG_DIR: profile }, timeout: 25000, maxBuffer: 1024 * 1024, signal,
    }); } catch { /* Read the store again; the native refresh may have succeeded. */ }
    auth = await credential(profile);
  }
  if (!auth.accessToken || !auth.scopes?.includes("user:mcp_servers")) throw new Error("Вход Claude Work не даёт доступа к коннекторам. Повтори вход в корпоративном профиле.");
  if (auth.expiresAt && auth.expiresAt <= Date.now()) throw new Error("Вход Claude Work истёк. Открой корпоративный профиль и повтори вход.");
  signal.throwIfAborted();
  return auth.accessToken;
}

export async function connectSources(signal: AbortSignal, config: SourceConfig = defaultSourceConfig): Promise<SourceConnections> {
  const profile = sourceProfile(config);
  const unavailable = (error: unknown): SourceConnections => Object.fromEntries(["gmail", "slack", "jira"].map(s => [s, { error: sourceError(error) }])) as SourceConnections;
  let token: string;
  let catalog: { id: string; display_name: string; eligible?: boolean; eligibility_reason?: string }[];
  try {
    token = await accessToken(profile, signal, config.expectedEmail);
    const response = await fetch("https://api.anthropic.com/v1/mcp_servers?limit=1000", {
      headers: { Authorization: `Bearer ${token}`, "anthropic-version": "2023-06-01", "anthropic-beta": "mcp-servers-2025-12-04" },
      signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]), redirect: "error",
    });
    if (!response.ok) throw new Error(`Каталог корпоративных коннекторов: HTTP ${response.status}. Проверь вход Claude Work.`);
    const data = await response.json() as { data?: typeof catalog };
    if (!Array.isArray(data.data)) throw new Error("Корпоративный каталог вернул неизвестный формат.");
    catalog = data.data;
  } catch (error) { return unavailable(error); }
  const names: Record<SyncSource, string> = { gmail: "Gmail", slack: "Slack", jira: "Atlassian" };
  return Object.fromEntries(await Promise.all((Object.keys(names) as SyncSource[]).map(async source => {
    const server = catalog.find(s => s.display_name === names[source]);
    if (!server || server.eligible === false || !/^mcpsrv_[A-Za-z0-9]+$/.test(server.id)) return [source, { error: `Коннектор ${names[source]} недоступен в Claude Work.` }];
    const client = new Client({ name: "247c-source-reader", version: "1.0.0" }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(`https://mcp-proxy.anthropic.com/v1/mcp/${server.id}`), {
      requestInit: { redirect: "error", headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "mcp-servers-2025-12-04", "anthropic-version": "2023-06-01", "X-Mcp-Client-Session-Id": randomUUID() } },
    });
    try {
      await client.connect(transport, { signal, timeout: 20000 });
      const tools = await client.listTools({}, { signal, timeout: 20000 });
      if (!READ_TOOLS[source].every(name => tools.tools.some(t => t.name === name))) throw new Error(`Изменился набор инструментов ${names[source]}; требуется обновление сборщика.`);
      return [source, {
        async call(tool: string, args: Record<string, unknown>, signal: AbortSignal) {
          if (!READ_TOOLS[source].includes(tool)) throw new Error("Сборщик разрешает только фиксированные операции чтения.");
          if (source === "jira" && (!config.jiraSite || args.cloudId !== config.jiraSite || args.updateHistory === true)) throw new Error("Разрешено только чтение настроенного Jira без изменения истории.");
          return client.callTool({ name: tool, arguments: args }, undefined, { signal, timeout: 20000 });
        },
        close: () => client.close(),
      } satisfies SourceConnector];
    } catch (error) { await client.close().catch(() => {}); return [source, { error: sourceError(error) }]; }
  }))) as SourceConnections;
}

export async function connectCalendar(signal: AbortSignal, config: SourceConfig = defaultSourceConfig): Promise<SourceConnector> {
  const token = await accessToken(sourceProfile(config), signal, config.expectedEmail);
  const response = await fetch("https://api.anthropic.com/v1/mcp_servers?limit=1000", {
    headers: { Authorization: `Bearer ${token}`, "anthropic-version": "2023-06-01", "anthropic-beta": "mcp-servers-2025-12-04" },
    signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]), redirect: "error",
  });
  if (!response.ok) throw new Error(`Каталог календаря: HTTP ${response.status}. Проверь вход Claude Work.`);
  const catalog = await response.json() as { data?: { id: string; display_name: string; eligible?: boolean }[] };
  const server = catalog.data?.find(s => s.display_name === "Google Calendar" && s.eligible !== false);
  if (!server || !/^mcpsrv_[A-Za-z0-9]+$/.test(server.id)) throw new Error("Подключи рабочий Google Calendar в корпоративном Claude.");
  const client = new Client({ name: "247c-calendar-reader", version: "1.0.0" }, { capabilities: {} });
  const allowed = ["list_calendars", "list_events", "get_event"];
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`https://mcp-proxy.anthropic.com/v1/mcp/${server.id}`), {
      requestInit: { redirect: "error", headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "mcp-servers-2025-12-04", "anthropic-version": "2023-06-01", "X-Mcp-Client-Session-Id": randomUUID() } },
    }), { signal, timeout: 20000 });
    const tools = await client.listTools({}, { signal, timeout: 20000 });
    if (!allowed.every(name => tools.tools.some(t => t.name === name))) throw new Error("Изменился интерфейс Google Calendar. Требуется обновление сборщика.");
    return {
      call(tool, args, signal) {
        if (!allowed.includes(tool) || tool !== "list_calendars" && args.calendarId !== config.calendarId) throw new Error("Разрешено только чтение рабочего календаря.");
        return client.callTool({ name: tool, arguments: args }, undefined, { signal, timeout: 20000 });
      }, close: () => client.close(),
    };
  } catch (error) { await client.close().catch(() => {}); throw error; }
}
