import { afterEach, expect, it, vi } from "vitest";
import type { ConnectionAttempt } from "./source-diagnostics.js";
const mock = vi.hoisted(() => ({ jira: Promise.resolve() }));
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
      if (this.source === "jira") { await mock.jira; throw new Error("HTTP 403: Bearer test-secret"); }
    }
    async listTools() {
      const { READ_TOOLS } = await import("./source-connectors.js");
      return { tools: READ_TOOLS[this.source as keyof typeof READ_TOOLS].map(name => ({ name })) };
    }
    async close() {}
  },
}));
import { connectSources } from "./source-connectors.js";
import { parseSourceConfig } from "./source-config.js";
afterEach(() => vi.unstubAllGlobals());

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
