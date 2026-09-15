// @vitest-environment jsdom
import { afterEach, beforeAll, expect, it } from "vitest";
import { loadPluginApp, renderSlot, type CapturedPluginApp, type RenderedSlot } from "@get-bb/plugin-sdk/testing/app";
import { randomUUID } from "node:crypto";
import { fixture } from "./test-support.js";
import { rpcContract } from "./contracts.js";
import { DayPlanning } from "./day-planning.js";

let app: CapturedPluginApp;
const hosts: Awaited<ReturnType<typeof fixture>>[] = [], mounts: RenderedSlot[] = [];
beforeAll(async () => { app = await loadPluginApp(() => import("./app.js")); }, 60000);
afterEach(async () => {
  mounts.splice(0).forEach(slot => slot.lifecycle.unmount());
  for (const f of hosts.splice(0)) await f.harness.lifecycle.dispose();
});
async function setup(overrides: Record<string, (input: unknown) => unknown> = {}) {
  const f = await fixture(); hosts.push(f);
  const task = await f.create(), days = new DayPlanning(f.repo);
  days.add({ taskId: task.id, date: days.today(), reportedMinutes: 198, requestId: randomUUID() });
  const rpc = { ...Object.fromEntries(Object.keys(rpcContract).map(name => [name, (input: unknown) => f.harness.behavior.callRpc(name, input)])), ...overrides };
  const component = app.navPanels[0].experimental_sidebarAccessory!;
  const slot = renderSlot({ component }, {}, { rpc }); mounts.push(slot);
  function propose() {
    const dossier = f.repo.detail(task.id);
    return f.repo.propose({ taskId: task.id, revision: task.revision, requestId: randomUUID(), draft: {
      rationale: "Updated context", confidence: 1,
      changes: { summary: { value: "Review the new context", evidenceRefs: [dossier.facts[0].id] } },
    } }, "test");
  }
  return { f, slot, propose };
}

it("puts new Proposals before task count and reported time, and clears the signal after review", async () => {
  const { f, slot, propose } = await setup();
  await slot.findByLabelText("Reported today: 3:18");
  expect(slot.getByTitle("Open tasks: 1").textContent).toBe("1");
  expect(slot.queryByLabelText(/Proposals awaiting/)).toBeNull();
  const proposal = propose();
  await slot.behavior.emitRealtime("desk-changed", {});
  const badge = await slot.findByLabelText("Proposals awaiting a decision: 1");
  // The host clips the trailing edge. The notification must precede both
  // statistics so a growing counter or duration cannot push it out of view.
  expect(badge.parentElement!.firstElementChild).toBe(badge);
  expect(badge.compareDocumentPosition(slot.getByTitle("Open tasks: 1")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(badge.compareDocumentPosition(slot.getByLabelText("Reported today: 3:18")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  f.repo.reject(proposal.id);
  await slot.behavior.emitRealtime("desk-changed", {});
  await slot.findByLabelText("Reported today: 3:18");
  expect(slot.queryByLabelText(/Proposals awaiting/)).toBeNull();
});

it("continues announcing Proposals when reported time cannot be read", async () => {
  const { slot, propose } = await setup({ day: async () => { throw new Error("Time temporarily unavailable"); } });
  await slot.findByLabelText("Reported today: unavailable");
  propose();
  await slot.behavior.emitRealtime("desk-changed", {});
  expect((await slot.findByLabelText("Proposals awaiting a decision: 1")).textContent).toBe("1");
  expect(slot.getByLabelText("Reported today: unavailable")).toBeTruthy();
});

it("keeps a large proposal count compact while exposing the exact count", async () => {
  const { slot } = await setup({ list: () => ({ tasks: [], total: 1234, pendingTotal: 123 }) });
  const badge = await slot.findByLabelText("Proposals awaiting a decision: 123");
  expect(badge.textContent).toBe("9+");
  expect(badge.getAttribute("title")).toBe("Proposals awaiting a decision: 123");
  expect(badge.parentElement!.firstElementChild).toBe(badge);
  await slot.findByLabelText("Reported today: 3:18");
  expect(slot.getByTitle("Open tasks: 1234").textContent).toBe("1234");
});

it("shows proposals for new tasks even when there are no open tasks yet", async () => {
  const { slot } = await setup({ list: () => ({ tasks: [], total: 0, pendingTotal: 2 }) });
  await slot.findByLabelText("Reported today: 3:18");
  expect((await slot.findByLabelText("Proposals awaiting a decision: 2")).textContent).toBe("2");
  expect(slot.queryByTitle(/Open tasks:/)).toBeNull();
});
