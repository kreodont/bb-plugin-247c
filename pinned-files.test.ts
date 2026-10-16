import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile, symlink, stat } from "node:fs/promises";
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { PinnedFilesSettings, PINNED_FILES_NAME } from "./local-settings.js";
import { fixture } from "./test-support.js";
import { resolvePinnedFilePath } from "./pinned-file-path.js";
import { PINNED_FILE_ERRORS } from "./pinned-files-contracts.js";

vi.mock("./pinned-file-path.js", async importOriginal => {
  const original = await importOriginal<typeof import("./pinned-file-path.js")>();
  return { resolvePinnedFilePath: vi.fn(original.resolvePinnedFilePath) };
});
vi.mock("node:fs", async importOriginal => {
  const original = await importOriginal<typeof import("node:fs")>();
  return { ...original, openSync: vi.fn(original.openSync), readFileSync: vi.fn(original.readFileSync) };
});
const folders: string[] = [], hosts: Awaited<ReturnType<typeof fixture>>[] = [];
afterEach(async () => { for (const f of hosts.splice(0)) await f.harness.lifecycle.dispose(); await Promise.all(folders.splice(0).map(folder => rm(folder, { recursive: true, force: true }))); vi.clearAllMocks(); });
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "pinned-files-")); folders.push(dir);
  return { dir, store: new PinnedFilesSettings(join(dir, "data.db")), settings: join(dir, PINNED_FILES_NAME) };
}

it("persists only local shortcuts, survives reload and never opens their targets", async () => {
  const { dir, store, settings } = await setup();
  const target = join(dir, "private-config.json"), token = "SENTINEL_FILE_CONTENT_NOT_FOR_247C";
  await writeFile(target, JSON.stringify({ token }));
  expect(store.list()).toEqual({ files: [] });
  const first = store.add({ name: "Config", path: target }, "host_local");
  const renamed = store.add({ name: "Private config", path: target }, "host_local");
  expect(renamed.files).toHaveLength(1);
  expect(renamed.files[0].id).toBe(first.files[0].id);
  const reloaded = new PinnedFilesSettings(join(dir, "data.db"));
  expect(reloaded.list()).toEqual(renamed);
  expect(await readFile(settings, "utf8")).not.toContain(token);
  if (process.platform !== "win32") expect((await stat(settings)).mode & 0o777).toBe(0o600);
  expect(fs.openSync).not.toHaveBeenCalledWith(target, expect.anything());
  expect(vi.mocked(fs.readFileSync).mock.calls.every(([file]) => typeof file === "number")).toBe(true);
  expect(store.remove(first.files[0].id)).toEqual({ files: [] });
  expect(await readFile(target, "utf8")).toContain(token);
});

it("normalizes home paths without inspecting targets and rejects non-file destinations", async () => {
  const { store } = await setup();
  expect(store.add({ name: "Notes", path: "~/notes.md" }, "host_local").files[0].path).toBe(join(homedir(), "notes.md"));
  for (const path of ["relative.md", "https://example.com/file", "file:///private/file", "bad\npath"]) expect(() => store.add({ name: "Notes", path }, "host_local")).toThrow();
  expect(store.list().files).toHaveLength(1);
});

it("does not overwrite malformed or symlinked local settings and sanitizes errors", async () => {
  const { dir, store, settings } = await setup();
  const body = "UNEXPECTED_PRIVATE_CONTENT";
  await writeFile(settings, body);
  expect(() => store.add({ name: "Notes", path: "/notes.md" }, "host_local")).toThrow("Invalid pinned-file settings");
  expect(await readFile(settings, "utf8")).toBe(body);
  await rm(settings);
  const target = join(dir, "outside.json"); await writeFile(target, body); await symlink(target, settings);
  expect(() => store.list()).toThrow("Could not read pinned-file settings");
  expect(await readFile(target, "utf8")).toBe(body);
});

it("RPCs are task-independent, use an explicit machine and do not expose a file-reading tool", async () => {
  const f = await fixture(); hosts.push(f);
  f.harness.inspection.sdk.stub("system.config", () => ({ primaryHostId: "host_local" }));
  const before = f.repo.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
  const value = await f.harness.behavior.callRpc("pinFile", { name: "Notes", path: "/private/notes.md" }) as { files: { id: string }[] };
  expect(await f.harness.behavior.callRpc("pinnedFiles", {})).toMatchObject({ files: [{ hostId: "host_local", path: "/private/notes.md" }] });
  expect(f.harness.inspection.sdk.callsTo("files.read")).toHaveLength(0);
  expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
  expect(f.repo.list().tasks).toHaveLength(0);
  expect(f.repo.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).toEqual(before);
  f.harness.inspection.sdk.stub("threads.get", () => ({ environmentId: "env_pinned" }));
  f.harness.inspection.sdk.stub("environments.get", () => ({ hostId: "host_other" }));
  await expect(f.harness.behavior.callRpc("pinnedFileTarget", { id: value.files[0].id, threadId: "thr_other" })).rejects.toThrow("file's machine");
  f.harness.inspection.sdk.stub("environments.get", () => ({ hostId: "host_local" }));
  expect(await f.harness.behavior.callRpc("pinnedFileTarget", { id: value.files[0].id, threadId: "thr_local" })).toMatchObject({ path: "/private/notes.md", hostId: "host_local" });
  expect(f.harness.inspection.sdk.callsTo("files.read")).toHaveLength(0);
  expect(await f.harness.behavior.callRpc("unpinFile", { id: value.files[0].id })).toEqual({ files: [] });
});

it("saves and opens the converted WSL path, deduplicates its Linux alias and leaves settings intact after conversion failure", async () => {
  const f = await fixture(); hosts.push(f);
  const initialLogs = [...f.harness.inspection.logEntries];
  f.harness.inspection.sdk.stub("system.config", () => ({ primaryHostId: "host_local" }));
  const windowsPath = String.raw`C:\Users\example\private-config.json`, linuxPath = "/windows/c/Users/example/private-config.json";
  vi.mocked(resolvePinnedFilePath).mockResolvedValueOnce(linuxPath);
  const first = await f.harness.behavior.callRpc("pinFile", { name: "Config", path: windowsPath }) as { files: { id: string }[] };
  expect(resolvePinnedFilePath).toHaveBeenCalledWith(windowsPath);
  expect(first).toMatchObject({ files: [{ hostId: "host_local", path: linuxPath }] });
  const renamed = await f.harness.behavior.callRpc("pinFile", { name: "Private config", path: linuxPath });
  expect(renamed).toEqual({ files: [{ id: first.files[0].id, name: "Private config", hostId: "host_local", path: linuxPath }] });
  f.harness.inspection.sdk.stub("threads.get", () => ({ environmentId: "env_local" }));
  f.harness.inspection.sdk.stub("environments.get", () => ({ hostId: "host_local" }));
  expect(await f.harness.behavior.callRpc("pinnedFileTarget", { id: first.files[0].id, threadId: "thr_local" })).toMatchObject({ path: linuxPath });
  vi.mocked(resolvePinnedFilePath).mockRejectedValueOnce(new Error(PINNED_FILE_ERRORS.wslPath));
  await expect(f.harness.behavior.callRpc("pinFile", { name: "Other", path: "D:/other.json" })).rejects.toThrow(PINNED_FILE_ERRORS.wslPath);
  expect(await f.harness.behavior.callRpc("pinnedFiles", {})).toEqual(renamed);
  expect(f.harness.inspection.sdk.callsTo("files.read")).toHaveLength(0);
  expect(fs.openSync).not.toHaveBeenCalledWith(windowsPath, expect.anything());
  expect(fs.openSync).not.toHaveBeenCalledWith(linuxPath, expect.anything());
  expect(f.harness.inspection.logEntries).toEqual(initialLogs);
});
