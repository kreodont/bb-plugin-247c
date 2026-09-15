import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyLocalPatch, PATCH_FORMAT, patchPath, readPatch, writePatch } from "./local-patch.js";
import { settingDescriptors, type LocalSettings, type SettingsHandle } from "./settings.js";

const directories: string[] = [];
afterEach(() => { directories.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })); });
function setup() {
  const directory = mkdtempSync(join(tmpdir(), "247c-local-patch-")); directories.push(directory);
  const database = join(directory, "data.db"), path = patchPath(database)!;
  const values = Object.fromEntries(Object.entries(settingDescriptors).map(([key, descriptor]) => [key, descriptor.default])) as LocalSettings;
  Object.assign(values, { threadProjectId: "project_local" });
  const listeners: ((next: LocalSettings, prev: LocalSettings) => void)[] = [];
  const settings: SettingsHandle = { get: async () => ({ ...values }), onChange: listener => { listeners.push(listener); }, experimental_set: vi.fn(async patch => {
    const prev = { ...values }; Object.assign(values, patch); listeners.forEach(listener => listener({ ...values }, prev)); return { ...values };
  }) };
  return { database, path, values, settings };
}

it("captures effective local settings outside the code directory and reapplies them before services load", async () => {
  const f = setup();
  await applyLocalPatch(f.settings, f.database, vi.fn());
  expect(readPatch(f.path).threadProjectId).toBe("project_local");
  if (process.platform !== "win32") expect(statSync(f.path).mode & 0o777).toBe(0o600);
  Object.assign(f.values, { threadProjectId: "project_changed_by_update" });
  await applyLocalPatch(f.settings, f.database, vi.fn());
  expect(f.values.threadProjectId).toBe("project_local");
  expect(patchPath(":memory:")).toBeNull();
});

it("mirrors explicit BB edits while preserving unrelated file edits for the next reload", async () => {
  const f = setup(); await applyLocalPatch(f.settings, f.database, vi.fn());
  writePatch(f.path, { ...readPatch(f.path), workModel: "local-model" });
  await f.settings.experimental_set({ hourlyUpdates: true });
  expect(readPatch(f.path)).toMatchObject({ hourlyUpdates: true, workModel: "local-model" });
  expect(f.values.workModel).toBe("");
  await applyLocalPatch(f.settings, f.database, vi.fn());
  expect(f.values.workModel).toBe("local-model");
});

it.each([
  { format: "future", settings: {} },
  { format: PATCH_FORMAT, settings: { threadProjectId: "private-value", unknown: "private-value" } },
  { format: PATCH_FORMAT, settings: { threadProjectId: "private-value", timeZone: "private-value" } },
  { format: PATCH_FORMAT, settings: { hourlyUpdates: "true" } },
  { format: PATCH_FORMAT, settings: { localSettingsPatch: "/another/file" } },
  { format: PATCH_FORMAT, settings: { updateStartHour: 24 } },
  { format: PATCH_FORMAT, settings: { sources: "private-value" } },
  { format: PATCH_FORMAT, settings: { excludedReviewModels: '[{"providerId":"test","model":"x","command":"private-value"}]' } },
])("rejects the entire invalid patch without writes or disclosing values: %#", async value => {
  const f = setup(); const raw = JSON.stringify(value); writeFileSync(f.path, raw);
  try { await applyLocalPatch(f.settings, f.database, vi.fn()); throw new Error("Expected rejection"); }
  catch (error) { expect(String(error)).not.toContain("private-value"); expect(String(error)).toMatch(/patch/i); }
  expect(f.settings.experimental_set).not.toHaveBeenCalled();
  expect(readFileSync(f.path, "utf8")).toBe(raw);
});

it("preserves malformed and oversized files, and reports a failed mirror without exposing settings", async () => {
  const f = setup(), report = vi.fn(); await applyLocalPatch(f.settings, f.database, report);
  writeFileSync(f.path, "broken private-value");
  await f.settings.experimental_set({ hourlyUpdates: true });
  expect(report).toHaveBeenCalledOnce(); expect(report.mock.calls[0][0]).not.toContain("private-value");
  expect(readFileSync(f.path, "utf8")).toBe("broken private-value");
  writeFileSync(f.path, " ".repeat(256 * 1024 + 1));
  await expect(applyLocalPatch(f.settings, f.database, vi.fn())).rejects.toThrow(/patch/);
});
