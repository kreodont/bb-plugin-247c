import { afterEach, expect, it } from "vitest";
import { fixture } from "./test-support.js";
import { sessionSchema } from "./contracts.js";

const hosts: Awaited<ReturnType<typeof fixture>>[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.harness.lifecycle.dispose();
});

it.each([
  { environmentProviderId: "personal-workspace", inputs: null },
  { environmentProviderId: "project-checkout", inputs: { path: "/work/project", branch: { kind: "existing", name: "main" } } },
  { environmentProviderId: "git-worktree", inputs: { branch: { kind: "named", name: "develop" } } },
])("starts a conversation in $environmentProviderId on the composer's selected machine", async ({ environmentProviderId, inputs }) => {
  const f = await fixture();
  hosts.push(f);
  const task = await f.create();
  const start = f.startInput(task.id, task.revision);
  const environment = { type: "provider", environmentProviderId, machine: { type: "existing", hostId: "host_selected" }, inputs };
  const session = sessionSchema.parse(await f.harness.behavior.callRpc("start", {
    ...start,
    criteria: [],
    request: { ...start.request, environment },
  }));

  expect(session.status).toBe("working");
  expect(session.mode).toBe("conversation");
  expect(f.harness.inspection.sdk.callsTo("providers.list")).toEqual([[{ hostId: "host_selected" }]]);
  for (const [lookup] of f.harness.inspection.sdk.callsTo("providers.models")) {
    expect(lookup).toMatchObject({ hostId: "host_selected", providerId: "codex" });
  }
  expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
  expect(f.harness.inspection.sdk.callsTo("threads.spawn")[0][0]).toMatchObject({ environment });
});

it.each([
  { type: "provider", environmentProviderId: "personal-workspace", machine: { type: "existing" }, inputs: null },
  { type: "provider", environmentProviderId: "personal-workspace", machine: { type: "existing", hostId: "host_selected", permissionMode: "full" }, inputs: null },
  { type: "provider", environmentProviderId: "personal-workspace", machine: { type: "existing", hostId: "host_selected" }, inputs: null, originPluginId: "another-plugin" },
])("rejects malformed or additional authority in a provider environment", async (environment) => {
  const f = await fixture();
  hosts.push(f);
  const task = await f.create();
  const start = f.startInput(task.id, task.revision);
  await expect(f.harness.behavior.callRpc("start", {
    ...start,
    request: { ...start.request, environment },
  })).rejects.toThrow(/input validation failed/);
  expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
  expect(f.repo.active()).toHaveLength(0);
});
