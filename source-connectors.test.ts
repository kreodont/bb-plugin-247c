import { afterEach, expect, it, vi } from "vitest";
import type { ConnectionAttempt } from "./source-diagnostics.js";
const mock = vi.hoisted(() => ({ jira: Promise.resolve(), jiraFails: true, jiraModern: false, calls: vi.fn(async () => ({})) }));
vi.mock("./source-pool-auth.js", () => ({ poolAccessToken: vi.fn(async () => "test-secret") }));
vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class { constructor(readonly url: URL, readonly options: { fetch: typeof fetch }) {} },
}));
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    source = "";
    async connect(transport: { url: URL; options: { fetch: typeof fetch } }) {
      this.source = transport.url.pathname.split("_").at(-1)!;
      await transport.options.fetch(transport.url);
      if (this.source === "jira") { await mock.jira; if (mock.jiraFails) throw new Error("HTTP 403: Bearer test-secret"); }
    }
    async listTools() {
      const { READ_TOOLS } = await import("./source-connectors.js");
      const names = [...READ_TOOLS[this.source as keyof typeof READ_TOOLS]];
      if (this.source === "jira" && mock.jiraModern) names.push("listJiraIssueComments");
      return { tools: names.map(name => ({ name, inputSchema: { type: "object", properties: mock.jiraModern ? { view: { enum: ["compact", "full"] } } : {} } })) };
    }
    async close() {}
    callTool = mock.calls;
  },
}));
import { connectSources, selectSourceConnector } from "./source-connectors.js";
import { parseSourceConfig } from "./source-config.js";
afterEach(() => { vi.unstubAllGlobals(); mock.jira = Promise.resolve(); mock.jiraFails = true; mock.jiraModern = false; mock.calls.mockClear(); });

it("publishes usable connections while a different handshake is pending and records each attempt", async () => {
  let release!: () => void;
  mock.jira = new Promise<void>(resolve => { release = resolve; });
  vi.stubGlobal("fetch", vi.fn<typeof fetch>(async url => new Response(String(url).includes("mcp_servers") ? JSON.stringify({ data: [
    { id: "mcpsrv_gmail", display_name: "Gmail" }, { id: "mcpsrv_slack", display_name: "Slack" }, { id: "mcpsrv_jira", display_name: "Atlassian" },
  ] }) : "{}", { status: 200 })));
  const config = parseSourceConfig(JSON.stringify({ expectedEmail: "work@example.com", accountPool: {
    pluginId: "example-pool", accountId: "11111111-1111-4111-8111-111111111111", organizationUuid: "22222222-2222-4222-8222-222222222222",
  } }));
  const ready = vi.fn(), attempts: ConnectionAttempt[] = [];
  const pending = connectSources(new AbortController().signal, config, ready, a => attempts.push(a));
  await vi.waitFor(() => expect(ready.mock.calls.map(c => c[0]).sort()).toEqual(["gmail", "slack"]));
  expect(attempts.filter(a => a.source !== "shared").map(a => a.outcome)).toEqual(["connected", "connected"]);
  release(); const connections = await pending;
  expect(connections.jira).toMatchObject({ error: expect.stringContaining("HTTP 403") });
  expect(attempts).toHaveLength(5);
  expect(attempts.at(-1)).toMatchObject({ source: "jira", attempt: 1, outcome: "failed", failure: "access_denied", status: 403, http: [{ status: 200 }] });
  expect(JSON.stringify(attempts)).not.toContain("test-secret");
});

it("accepts known Jira aliases, prefers the existing connector and skips ineligible entries", () => {
  const old = { id: "mcpsrv_legacy", display_name: "Atlassian", eligible: true };
  const current = { id: "mcpsrv_current", display_name: "Atlassian MCP", eligible: true };
  expect(selectSourceConnector([current], "jira")).toBe(current);
  expect(selectSourceConnector([current, old], "jira")).toBe(old);
  expect(selectSourceConnector([{ ...old, eligible: false }, current], "jira")).toBe(current);
  expect(selectSourceConnector([{ ...old, id: "../other-server" }, current], "jira")).toBe(current);
  expect(selectSourceConnector([{ ...current, eligible: false }, { ...old, display_name: "Atlassian Sandbox" }], "jira")).toBeUndefined();
  expect(selectSourceConnector([current], "gmail")).toBeUndefined();
});

it("connects Atlassian MCP and keeps the read-only site guard", async () => {
  mock.jiraFails = false;
  mock.jiraModern = true;
  vi.stubGlobal("fetch", vi.fn<typeof fetch>(async url => new Response(String(url).includes("mcp_servers") ? JSON.stringify({ data: [
    { id: "mcpsrv_disabled", display_name: "Atlassian", eligible: false },
    { id: "mcpsrv_jira", display_name: "Atlassian MCP", eligible: true },
  ] }) : "{}", { status: 200 })));
  const config = parseSourceConfig(JSON.stringify({ jiraSite: "example.atlassian.net", expectedEmail: "work@example.com", accountPool: {
    pluginId: "example-pool", accountId: "11111111-1111-4111-8111-111111111111", organizationUuid: "22222222-2222-4222-8222-222222222222",
  } }));
  const signal = new AbortController().signal;
  const connections = await connectSources(signal, config);
  if ("error" in connections.jira) throw new Error(connections.jira.error);
  const connector = connections.jira;
  const args = { cloudId: config.jiraSite, issueIdOrKey: "APP-1", updateHistory: false };
  await expect(connector.call("getJiraIssue", args, signal)).resolves.toEqual({});
  expect(mock.calls).toHaveBeenLastCalledWith({ name: "getJiraIssue", arguments: { ...args, view: "full" } }, undefined, expect.any(Object));
  expect(connector.supports?.("listJiraIssueComments")).toBe(true);
  await expect(connector.call("listJiraIssueComments", args, signal)).resolves.toEqual({});
  expect(mock.calls).toHaveBeenLastCalledWith({ name: "listJiraIssueComments", arguments: { ...args, view: "full" } }, undefined, expect.any(Object));
  await expect(connector.call("listJiraIssueComments", { ...args, cloudId: "other.atlassian.net" }, signal)).rejects.toThrow("configured Jira site");
  await expect(connector.call("getJiraIssue", { ...args, cloudId: "other.atlassian.net" }, signal)).rejects.toThrow("configured Jira site");
  await expect(connector.call("getJiraIssue", { ...args, updateHistory: true }, signal)).rejects.toThrow("configured Jira site");
  await expect(connector.call("editJiraIssue", args, signal)).rejects.toThrow("predefined read operations");
  expect(mock.calls).toHaveBeenCalledTimes(2);
  await connector.close();
});
