import { defaultSourceConfig, sourceProfile, type SourceConfig } from "./source-config.js";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { NativeSyncSource as SyncSource } from "./contracts.js";
import { establishSourceConnection } from "./source-connection.js";
import { sourceError } from "./source-error-text.js";
import { poolAccessToken } from "./source-pool-auth.js";
import { sourceThrownFailure } from "./source-errors.js";
import { connectionFetch, connectionFailure, type ConnectionAttempt, type ConnectionHttp } from "./source-diagnostics.js";
export { sourceError } from "./source-error-text.js";

const execute = promisify(execFile);
export const READ_TOOLS: Record<SyncSource, readonly string[]> = {
  gmail: ["search_threads", "get_thread", "get_message"],
  slack: ["slack_search_public_and_private", "slack_read_channel", "slack_read_thread"],
  jira: ["searchJiraIssuesUsingJql", "getJiraIssue"],
};
export interface SourceConnector {
  call(tool: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
  close(): Promise<void>;
  supports?(tool: string): boolean;
}
export type SourceConnections = Record<SyncSource, SourceConnector | { error: string }>;
export type SourceReady = (source: SyncSource, connection: SourceConnections[SyncSource]) => void;
export const WORK_CALENDAR = "primary";

export type SourceCatalogEntry = { id: string; display_name: string; eligible?: boolean; eligibility_reason?: string };
const SOURCE_CONNECTOR_NAMES: Record<SyncSource, readonly string[]> = {
  gmail: ["Gmail"], slack: ["Slack"], jira: ["Atlassian", "Atlassian MCP"],
};
export function selectSourceConnector(catalog: SourceCatalogEntry[], source: SyncSource): SourceCatalogEntry | undefined {
  // Keep the existing connector when both are available. Only known aliases in
  // the configured account are eligible; never try another account after failure.
  for (const name of SOURCE_CONNECTOR_NAMES[source]) {
    const server = catalog.find(s => s.display_name === name && s.eligible !== false && /^mcpsrv_[A-Za-z0-9]+$/.test(s.id));
    if (server) return server;
  }
}

type Credential = { accessToken?: string; expiresAt?: number; scopes?: string[] };
async function credential(profile: string): Promise<Credential> {
  let raw: string;
  if (process.platform === "darwin") {
    const service = `Claude Code-credentials-${createHash("sha256").update(profile.normalize("NFC")).digest("hex").slice(0, 8)}`;
    try { raw = (await execute("/usr/bin/security", ["find-generic-password", "-a", userInfo().username, "-w", "-s", service], { timeout: 8000, maxBuffer: 1024 * 1024 })).stdout; }
    catch { throw new Error("Could not read the configured Claude login from Keychain. Open the configured Claude profile and check the login."); }
  } else {
    try { raw = await readFile(join(profile, ".credentials.json"), "utf8"); }
    catch { throw new Error("No saved configured Claude login on the BB server."); }
  }
  try { return JSON.parse(raw).claudeAiOauth ?? {}; }
  catch { throw new Error("Could not read configured Claude login data."); }
}

async function accessToken(config: SourceConfig, signal: AbortSignal): Promise<string> {
  const expectedEmail = config.expectedEmail;
  if (!expectedEmail) throw new Error("Set expectedEmail in the sources setting before connecting sources.");
  // An explicitly configured owner has no fallback to a native login or Keychain.
  if (config.accountPool) return poolAccessToken(config.accountPool, expectedEmail, signal);
  const profile = sourceProfile(config);
  // Stay on the configured account identity. The token never leaves this module,
  // its issuing service and the issuer's MCP proxy; it is never given to a model.
  const identity = JSON.parse(await readFile(join(profile, ".claude.json"), "utf8")).oauthAccount?.emailAddress;
  if (identity?.toLowerCase() !== expectedEmail.toLowerCase()) throw new Error("The source profile account does not match expectedEmail in 247C settings.");
  let auth = await credential(profile);
  if (auth.expiresAt && auth.expiresAt < Date.now() + 60000) {
    // Let Claude own token rotation and its credential store. This command only
    // checks one connector; it makes no inference request and consumes no model tokens.
    try { await execute("claude", ["mcp", "get", "claude.ai Gmail"], {
      env: { ...process.env, CLAUDE_CONFIG_DIR: profile }, timeout: 25000, maxBuffer: 1024 * 1024, signal,
    }); } catch { /* Read the store again; the native refresh may have succeeded. */ }
    auth = await credential(profile);
  }
  if (!auth.accessToken || !auth.scopes?.includes("user:mcp_servers")) throw new Error("The configured Claude login does not grant connector access. Sign in again using the configured profile.");
  if (auth.expiresAt && auth.expiresAt <= Date.now()) throw new Error("The configured Claude login expired. Open the configured profile and sign in again.");
  signal.throwIfAborted();
  return auth.accessToken;
}

export async function connectSources(signal: AbortSignal, config: SourceConfig = defaultSourceConfig, onReady?: SourceReady,
  onAttempt?: (attempt: ConnectionAttempt) => void): Promise<SourceConnections> {
  const unavailable = (error: unknown): SourceConnections => Object.fromEntries(["gmail", "slack", "jira"].map(s => [s, { error: sourceError(error) }])) as SourceConnections;
  let token: string;
  let catalog: SourceCatalogEntry[];
  let phase: ConnectionAttempt["stage"] = "authentication";
  let startedAt = new Date().toISOString(), started = performance.now();
  const http: ConnectionHttp[] = [];
  const sharedReport = (cause?: unknown) => {
    const failure = cause === undefined ? null : sourceThrownFailure(cause);
    onAttempt?.({ source: "shared", attempt: 1, startedAt, elapsedMs: Math.round(performance.now() - started), stage: phase,
      outcome: signal.aborted ? "cancelled" : failure ? "failed" : "connected", http: http.map(h => ({ ...h })),
      rateLimited: failure?.rateLimited ?? false, retryable: failure?.retryable ?? false, ...(failure?.status ? { status: failure.status } : {}),
      ...(failure ? { failure: connectionFailure(failure) } : {}),
    });
  };
  try {
    if (!config.expectedEmail) throw new Error("Set expectedEmail in the sources setting before connecting sources.");
    token = await accessToken(config, signal);
    sharedReport();
    phase = "catalog"; startedAt = new Date().toISOString(); started = performance.now();
    const response = await connectionFetch(() => phase, event => { if (http.length < 32) http.push(event); })("https://api.anthropic.com/v1/mcp_servers?limit=1000", {
      headers: { Authorization: `Bearer ${token}`, "anthropic-version": "2023-06-01", "anthropic-beta": "mcp-servers-2025-12-04" },
      signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]), redirect: "error",
    });
    if (!response.ok) throw new Error(`Connector catalog: HTTP ${response.status}. Check the configured Claude login.`);
    const data = await response.json() as { data?: typeof catalog };
    if (!Array.isArray(data.data)) throw new Error("The connector catalog returned an unrecognized format.");
    catalog = data.data;
    sharedReport();
  } catch (error) { sharedReport(error); return unavailable(error); }
  return Object.fromEntries(await Promise.all((Object.keys(SOURCE_CONNECTOR_NAMES) as SyncSource[]).map(async source => {
    const ready = (connection: SourceConnections[SyncSource]) => { onReady?.(source, connection); return [source, connection] as const; };
    const server = selectSourceConnector(catalog, source);
    if (!server) {
      onAttempt?.({ source, attempt: 1, startedAt: new Date().toISOString(), elapsedMs: 0, stage: "availability", outcome: "failed", http: [], rateLimited: false, retryable: false });
      return ready({ error: `Connector ${SOURCE_CONNECTOR_NAMES[source].join(" / ")} is unavailable in the configured Claude profile.` });
    }
    try {
      const { client, availableTools, fullViewTools } = await establishSourceConnection(() => {
        const http: ConnectionHttp[] = [];
        const availableTools = new Set<string>(), fullViewTools = new Set<string>();
        let phase: ConnectionHttp["stage"] = "initialization", recording = true;
        const client = new Client({ name: "247c-source-reader", version: "1.0.0" }, { capabilities: {} });
        const transport = new StreamableHTTPClientTransport(new URL(`https://mcp-proxy.anthropic.com/v1/mcp/${server.id}`), {
          requestInit: { redirect: "error", headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "mcp-servers-2025-12-04", "anthropic-version": "2023-06-01", "X-Mcp-Client-Session-Id": randomUUID() } },
          fetch: connectionFetch(() => phase, event => { if (recording && http.length < 32) http.push(event); }),
        });
        return { client, http, availableTools, fullViewTools, stopDiagnostics: () => { recording = false; },
          connect: (signal: AbortSignal) => client.connect(transport, { signal, timeout: 20000 }),
          listTools: async (signal: AbortSignal) => {
            phase = "tool discovery";
            const tools = (await client.listTools({}, { signal, timeout: 20000 })).tools;
            for (const tool of tools) {
              availableTools.add(tool.name);
              const view = tool.inputSchema?.properties?.view as { enum?: unknown[] } | undefined;
              if (view?.enum?.includes("full")) fullViewTools.add(tool.name);
            }
            return tools.map(t => t.name);
          },
          close: () => client.close(),
        };
      }, READ_TOOLS[source], signal, { onAttempt: attempt => onAttempt?.({ source, ...attempt }) });
      return ready({
        async call(tool: string, args: Record<string, unknown>, signal: AbortSignal) {
          if (!READ_TOOLS[source].includes(tool) && !(source === "jira" && tool === "listJiraIssueComments" && availableTools.has(tool))) throw new Error("The collector allows only predefined read operations.");
          if (source === "jira" && (!config.jiraSite || args.cloudId !== config.jiraSite || args.updateHistory === true)) throw new Error("Only reads from the configured Jira site without history changes are allowed.");
          // Current Jira tools default to compact views, which can omit content.
          // Older tools do not accept this option; use the advertised schema.
          const completeView = source === "jira" && (tool === "getJiraIssue" || tool === "listJiraIssueComments") && fullViewTools.has(tool);
          return client.callTool({ name: tool, arguments: completeView ? { ...args, view: "full" } : args }, undefined, { signal, timeout: 20000 });
        },
        supports: (tool: string) => availableTools.has(tool),
        close: () => client.close(),
      } satisfies SourceConnector);
    } catch (error) { return ready({ error: sourceError(error) }); }
  }))) as SourceConnections;
}

export async function connectCalendar(signal: AbortSignal, config: SourceConfig = defaultSourceConfig): Promise<SourceConnector> {
  const token = await accessToken(config, signal);
  const response = await fetch("https://api.anthropic.com/v1/mcp_servers?limit=1000", {
    headers: { Authorization: `Bearer ${token}`, "anthropic-version": "2023-06-01", "anthropic-beta": "mcp-servers-2025-12-04" },
    signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]), redirect: "error",
  });
  if (!response.ok) throw new Error(`Calendar catalog: HTTP ${response.status}. Check the configured Claude login.`);
  const catalog = await response.json() as { data?: { id: string; display_name: string; eligible?: boolean }[] };
  const server = catalog.data?.find(s => s.display_name === "Google Calendar" && s.eligible !== false);
  if (!server || !/^mcpsrv_[A-Za-z0-9]+$/.test(server.id)) throw new Error("Connect your work Google Calendar in the configured Claude profile.");
  const client = new Client({ name: "247c-calendar-reader", version: "1.0.0" }, { capabilities: {} });
  const allowed = ["list_calendars", "list_events", "get_event"];
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`https://mcp-proxy.anthropic.com/v1/mcp/${server.id}`), {
      requestInit: { redirect: "error", headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "mcp-servers-2025-12-04", "anthropic-version": "2023-06-01", "X-Mcp-Client-Session-Id": randomUUID() } },
    }), { signal, timeout: 20000 });
    const tools = await client.listTools({}, { signal, timeout: 20000 });
    if (!allowed.every(name => tools.tools.some(t => t.name === name))) throw new Error("The Google Calendar interface changed. The collector needs updating.");
    return {
      call(tool, args, signal) {
        if (!allowed.includes(tool) || tool !== "list_calendars" && args.calendarId !== config.calendarId) throw new Error("Only reads from the work calendar are allowed.");
        return client.callTool({ name: tool, arguments: args }, undefined, { signal, timeout: 20000 });
      }, close: () => client.close(),
    };
  } catch (error) { await client.close().catch(() => {}); throw error; }
}
