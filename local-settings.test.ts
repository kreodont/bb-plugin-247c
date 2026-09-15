import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { z } from "zod";
import { applyLocalSettingsPatch } from "./local-settings.js";
import { fixture } from "./test-support.js";

const folders: string[] = [], hosts: Awaited<ReturnType<typeof fixture>>[] = [];
afterEach(async () => {
  for (const f of hosts.splice(0)) await f.harness.lifecycle.dispose();
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
});
async function patch(settings: Record<string, unknown>) {
  const folder = await mkdtemp(join(tmpdir(), "247c-local-settings-")); folders.push(folder);
  const path = join(folder, "settings.patch.json");
  await writeFile(path, JSON.stringify({ version: 1, settings }));
  return path;
}

it("reapplies a private patch on each activation while preserving unlisted settings and task data", async () => {
  const path = await patch({ threadProjectId: "proj_local", composerDefaults: JSON.stringify({ providerId: "claude-work", model: "claude-opus-5[1m]" }) });
  const f = await fixture({ settings: { localSettingsPatch: path, sessionMinutes: 12 } }); hosts.push(f);
  const task = await f.create(), before = await f.detail(task.id);
  expect(await f.harness.behavior.callRpc("threadProject", {})).toMatchObject({ projectId: "proj_local", providerId: "claude-work", model: "claude-opus-5[1m]" });
  await f.harness.behavior.setSettings({ threadProjectId: "proj_temporary", composerDefaults: "{}", sessionMinutes: 18 });
  await f.reload();
  expect(await f.harness.behavior.callRpc("threadProject", {})).toMatchObject({ projectId: "proj_local", providerId: "claude-work", model: "claude-opus-5[1m]" });
  expect(await f.harness.behavior.callRpc("list", {})).toMatchObject({ settings: { sessionMinutes: 18 } });
  expect(await f.detail(task.id)).toEqual(before);
  expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
  await writeFile(path, JSON.stringify({ version: 1, settings: { threadProjectId: null, composerDefaults: null } }));
  await f.reload();
  expect(await f.harness.behavior.callRpc("threadProject", {})).toMatchObject({ projectId: null, providerId: null, model: null });
  await f.harness.behavior.setSettings({ localSettingsPatch: "", threadProjectId: "proj_saved" });
  await rm(path);
  await f.reload();
  expect(await f.harness.behavior.callRpc("threadProject", {})).toMatchObject({ projectId: "proj_saved" });
});

it("rejects an incompatible patch through BB validation without partially changing valid settings", async () => {
  const host = createFakePluginHost({ pluginId: "247c-settings-test" });
  const settings = host.bb.settings.define({
    project: { type: "string", label: "Project", default: "original" },
    timeout: { type: "number", label: "Timeout", default: 20, experimental_schema: z.number().int().min(1).max(60) },
  });
  try {
    const path = await patch({ project: "changed", timeout: 999 });
    await expect(applyLocalSettingsPatch(path, ["project", "timeout"], values => settings.experimental_set(values))).rejects.toThrow();
    expect(await settings.get()).toEqual({ project: "original", timeout: 20 });
  } finally { await host.harness.lifecycle.dispose(); }
});

it("rejects missing, malformed, oversized and unknown configuration before any write", async () => {
  const apply = vi.fn(), path = await patch({ localSettingsPatch: "/another/file" });
  await expect(applyLocalSettingsPatch(path, ["localSettingsPatch"], apply)).rejects.toThrow(/Unsupported/);
  await writeFile(path, JSON.stringify({ version: 1, settings: { removedSetting: true } }));
  await expect(applyLocalSettingsPatch(path, ["threadProjectId"], apply)).rejects.toThrow(/Unsupported/);
  await writeFile(path, "{bad json");
  await expect(applyLocalSettingsPatch(path, [], apply)).rejects.toThrow(/Invalid local/);
  await writeFile(path, " ".repeat(65537));
  await expect(applyLocalSettingsPatch(path, [], apply)).rejects.toThrow(/64 KiB/);
  await rm(path);
  await expect(applyLocalSettingsPatch(path, [], apply)).rejects.toThrow();
  await expect(applyLocalSettingsPatch("relative.json", [], apply)).rejects.toThrow(/absolute/);
  expect(await applyLocalSettingsPatch("", [], apply)).toBeNull();
  expect(apply).not.toHaveBeenCalled();
});

it("validates account/model defaults as a pair without requiring any account on a fresh installation", async () => {
  const f = await fixture(); hosts.push(f);
  expect(await f.harness.behavior.callRpc("threadProject", {})).toMatchObject({ projectId: null, providerId: null, model: null });
  for (const value of [{ providerId: "claude-work" }, { model: "example" }, { providerId: "unknown", model: "example" }]) {
    await expect(f.harness.behavior.setSettings({ composerDefaults: JSON.stringify(value) })).rejects.toThrow();
  }
  expect(await f.harness.behavior.callRpc("threadProject", {})).toMatchObject({ projectId: null, providerId: null, model: null });
});

it("reports drift from an external null/default override without printing private values", async () => {
  const path = await patch({ threadProjectId: null });
  const f = await fixture({ settings: { localSettingsPatch: path } }); hosts.push(f);
  await f.harness.behavior.setSettings({ threadProjectId: "proj_private_override" });
  const result = await f.harness.behavior.runCli(["local-patch", "--json"]);
  expect(JSON.parse(result.stdout!)).toMatchObject({ mode: "external", matchesSettings: false });
  expect(result.stdout).not.toContain("proj_private_override");
});
