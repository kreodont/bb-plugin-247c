import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { revealFile } from "./reveal-file.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "247c-reveal-"));
  roots.push(root);
  const file = path.join(root, "notes ' $(example) é.txt");
  await writeFile(file, "fixture");
  return { path: file, rootPath: root };
}
const signal = () => new AbortController().signal;

it("reveals the exact file in Finder using arguments without shell interpolation", async () => {
  const input = await fixture(), run = vi.fn().mockResolvedValue("");
  await revealFile(input, signal(), { platform: "darwin", run });
  expect(run).toHaveBeenCalledExactlyOnceWith("/usr/bin/open", ["-R", expect.stringContaining(path.basename(input.path))], expect.any(AbortSignal));
});

it("converts WSL paths before selecting the file in Windows Explorer", async () => {
  const input = await fixture(), run = vi.fn().mockResolvedValueOnce("C:\\Work\\notes.txt\n").mockResolvedValueOnce("");
  await revealFile(input, signal(), { platform: "linux", wsl: true, run });
  expect(run.mock.calls[0][0]).toBe("wslpath");
  expect(run.mock.calls[1].slice(0, 2)).toEqual(["explorer.exe", ["/select,C:\\Work\\notes.txt"]]);
});

it("requests Linux file selection and falls back to the containing folder", async () => {
  const input = await fixture(), run = vi.fn().mockRejectedValueOnce(new Error("No file-manager service")).mockResolvedValueOnce("");
  await revealFile(input, signal(), { platform: "linux", wsl: false, run });
  expect(run.mock.calls[0][0]).toBe("gdbus");
  const uris = JSON.parse(run.mock.calls[0][1].at(-2));
  expect(decodeURIComponent(new URL(uris[0]).pathname)).toContain(path.basename(input.path));
  expect(run.mock.calls[1].slice(0, 2)).toEqual(["xdg-open", [expect.stringContaining(path.basename(input.rootPath))]]);
});

it("reports an unavailable desktop without claiming success", async () => {
  const run = vi.fn().mockRejectedValue(new Error("No desktop"));
  await expect(revealFile(await fixture(), signal(), { platform: "linux", wsl: false, run })).rejects.toThrow(/active desktop session/);
});

it("rejects missing files, directories and symlinks outside the root without launching anything", async () => {
  const input = await fixture(), run = vi.fn();
  const workspace = path.join(input.rootPath, "workspace"); await mkdir(workspace);
  const link = path.join(workspace, "outside.txt"); await symlink(input.path, link);
  await expect(revealFile({ path: link, rootPath: workspace }, signal(), { run })).rejects.toThrow(/outside/);
  await expect(revealFile({ path: workspace, rootPath: workspace }, signal(), { run })).rejects.toThrow(/not a file/);
  await expect(revealFile({ ...input, path: path.join(workspace, "missing") }, signal(), { run })).rejects.toThrow();
  expect(run).not.toHaveBeenCalled();
});

it("does not launch after cancellation", async () => {
  const run = vi.fn(), controller = new AbortController(); controller.abort();
  await expect(revealFile(await fixture(), controller.signal, { run })).rejects.toThrow();
  expect(run).not.toHaveBeenCalled();
});
