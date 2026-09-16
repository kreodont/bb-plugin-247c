import { afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { fixture } from "./test-support.js";
import { sessionSchema, syncStartSchema, type SyncRun } from "./contracts.js";
import { ThreadRouting } from "./thread-routing.js";
import { SourceSyncStore } from "./source-sync.js";
import * as collector from "./source-collector.js";
import { reportsFor } from "./source-sync-test-support.js";
import { UPDATE_SCHEDULE } from "./source-schedule.js";

const hosts: Awaited<ReturnType<typeof fixture>>[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.useRealTimers(); for (const f of hosts.splice(0)) await f.harness.lifecycle.dispose(); });
const target = { projectId: "proj_tasks", environment: { type: "host", hostId: "host_tasks", workspace: { type: "unmanaged", path: null } } };
async function setup() {
  const f = await fixture(); hosts.push(f);
  f.harness.inspection.sdk.stub("projects.get", ({ projectId }) => ({ id: projectId, kind: "standard", sources: [{ id: "source_tasks", type: "local_path", hostId: "host_tasks", path: "/work/tasks", isDefault: true }] }));
  await f.harness.behavior.setSettings({ threadProjectId: target.projectId });
  return f;
}
const spawns = (f: Awaited<ReturnType<typeof fixture>>) => f.harness.inspection.sdk.callsTo("threads.spawn").map(call => call[0]);

it("routes conversations and their personal-model recorders to the configured project", async () => {
  const f = await setup(), task = await f.create();
  const input = { ...f.startInput(task.id, task.revision), criteria: [] };
  const session = sessionSchema.parse(await f.harness.behavior.callRpc("start", input));
  expect(spawns(f)[0]).toMatchObject({ ...target, providerId: input.request.providerId, model: input.request.model, permissionMode: input.request.permissionMode, visibility: "visible" });
  expect(f.repo.sessionRequest(session.id)).toMatchObject({ request: target });
  await f.idle(session.workerThreadId!, "Discussed the next step.");
  await f.harness.behavior.callRpc("finish", { sessionId: session.id });
  expect(spawns(f)[1]).toMatchObject({ ...target, providerId: "claude-code", visibility: "hidden", permissionMode: "accept-edits" });
  await f.harness.behavior.setSettings({ threadProjectId: "another_project" });
  expect(sessionSchema.parse(await f.harness.behavior.callRpc("start", input)).id).toBe(session.id);
  expect(spawns(f)).toHaveLength(2);
});

it("routes legacy verification workers without changing their model or visibility", async () => {
  const f = await setup(), task = await f.create();
  const session = await f.start(task.id, task.revision);
  await f.idle(session.workerThreadId!, { summary: "A three-step plan is ready.", artifacts: [] });
  expect(spawns(f)).toHaveLength(2);
  expect(spawns(f)[1]).toMatchObject({ ...target, providerId: "claude-code", visibility: "hidden", model: session.reviewerModel });
});

function bundle(run: SyncRun): collector.SourceExport {
  const calls: collector.SourceExport["calls"] = [
    { source: "gmail" as const, tool: "gmail.search_threads", args: { query: "is:unread in:inbox" }, output: '{"threads":[]}' },
    { source: "gmail" as const, tool: "gmail.search_threads", args: { query: "after:1234" }, output: '{"threads":[]}' },
    { source: "slack" as const, tool: "slack.slack_search_public_and_private", args: { query: "is:dm" }, output: '{"results":[],"has_more":false}' },
    { source: "jira" as const, tool: "jira.searchJiraIssuesUsingJql", args: { jql: "updated >= -1d" }, output: '{"issues":[],"isLast":true}' },
  ].map((call, i) => ({ ...call, ref: `export:${run.id}:${i}`, completed: true, truncated: false, read: false }));
  const doc = { ref: `export:${run.id}:thread`, source: "gmail" as const, tool: "gmail.get_thread", args: { threadId: "thread1" }, content: "A new request needs analysis." };
  calls.push({ ...doc, output: doc.content, completed: true, truncated: false, read: true });
  return { version: 1, runId: run.id, startedAt: run.startedAt, finishedAt: run.until, elapsedMs: 1, calls, reports: reportsFor(calls), documents: [doc] };
}

it("routes source checks from an old saved workspace and keeps replay idempotent", async () => {
  const f = await setup();
  vi.spyOn(collector, "collectSources").mockImplementation(async run => bundle(run));
  const input = { requestId: randomUUID(), since: null, request: f.startInput("unused", 0).request };
  const first = await f.harness.behavior.callRpc("syncStart", input);
  const store = new SourceSyncStore(f.repo);
  await vi.waitFor(() => expect(store.run(input.requestId).status).toBe("working"));
  expect(spawns(f)).toHaveLength(1);
  expect(spawns(f)[0]).toMatchObject({ ...target, providerId: input.request.providerId, model: input.request.model });
  expect(store.request(input.requestId).input!.request).toMatchObject(target);
  await f.harness.behavior.setSettings({ threadProjectId: "another_project" });
  expect(await f.harness.behavior.callRpc("syncStart", input)).toMatchObject({ id: (first as SyncRun).id });
  expect(spawns(f)).toHaveLength(1);
});

it("fails before starting work when the configured project is missing", async () => {
  const f = await setup(), task = await f.create();
  f.harness.inspection.sdk.stub("projects.get", () => { throw new Error("Not found"); });
  await expect(f.start(task.id, task.revision)).rejects.toThrow(/thread project is unavailable/);
  expect(f.repo.sessions(task.id)).toHaveLength(0);
  expect(spawns(f)).toHaveLength(0);
});

it("uses the configured project for scheduled checks saved before routing was enabled", async () => {
  const f = await setup();
  const store = new SourceSyncStore(f.repo);
  const previous = store.insert(syncStartSchema.parse({ requestId: randomUUID(), since: null, request: f.startInput("unused", 0).request }));
  store.save({ ...previous, status: "completed", finishedAt: previous.startedAt });
  vi.spyOn(collector, "collectSources").mockImplementation(async run => bundle(run));
  await f.harness.behavior.setSettings({ hourlyUpdates: true });
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-09-11T05:00:00Z"));
  await f.harness.behavior.runSchedule(UPDATE_SCHEDULE);
  await vi.waitFor(() => expect(spawns(f)).toHaveLength(1));
  expect(spawns(f)[0]).toMatchObject(target);
  expect(f.repo.list(true).total).toBe(0);
});

it("rejects a project without a default local folder", async () => {
  const f = await setup();
  f.harness.inspection.sdk.stub("projects.get", () => ({ id: target.projectId, kind: "standard", sources: [] }));
  const routing = new ThreadRouting(f.bb, async () => target.projectId);
  const input = syncStartSchema.parse({ requestId: randomUUID(), since: null, request: f.startInput("unused", 0).request });
  await expect(routing.request(input.request)).rejects.toThrow(/default local folder/);
  expect(spawns(f)).toHaveLength(0);
});

it("retains legacy workspace behavior when project routing is unset", async () => {
  const f = await setup();
  const routing = new ThreadRouting(f.bb, async () => "");
  const input = syncStartSchema.parse({ requestId: randomUUID(), since: null, request: f.startInput("unused", 0).request }).request;
  expect(await routing.request(input)).toBe(input);
  expect(await routing.review("host_original")).toEqual({ projectId: "proj_personal", environment: { type: "host", hostId: "host_original", workspace: { type: "personal" } } });
});
