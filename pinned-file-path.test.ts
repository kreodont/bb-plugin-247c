import { afterEach, expect, it, vi } from "vitest";
import * as os from "node:os";
import { resolvePinnedFilePath } from "./pinned-file-path.js";
import { PINNED_FILE_ERRORS } from "./pinned-files-contracts.js";

vi.mock("node:os", async importOriginal => {
  const original = await importOriginal<typeof import("node:os")>();
  return { ...original, release: vi.fn(original.release) };
});
afterEach(() => vi.restoreAllMocks());

it.each(["4.4.0-Microsoft", "6.6.87.2-microsoft-standard-WSL2"])("converts Windows paths on WSL (%s), using its configured mounts", async kernel => {
  vi.mocked(os.release).mockReturnValue(kernel);
  const input = String.raw`C:\Users\example\Project files\notes.json`;
  const run = vi.fn().mockResolvedValue("/windows/c/Users/example/Project files/notes.json\n");
  expect(await resolvePinnedFilePath(input, { platform: "linux", run })).toBe("/windows/c/Users/example/Project files/notes.json");
  expect(run).toHaveBeenCalledExactlyOnceWith("wslpath", ["-u", input]);
});

it.each([
  String.raw`D:\Project files\$(touch sentinel) & notes.json`,
  "D:/Project files/notes.json",
  String.raw`\\server\share\notes.json`,
])("passes a Windows path as a single literal argument: %s", async input => {
  const run = vi.fn().mockResolvedValue("/mount/notes.json\n");
  expect(await resolvePinnedFilePath(input, { platform: "linux", wsl: true, run })).toBe("/mount/notes.json");
  expect(run).toHaveBeenCalledExactlyOnceWith("wslpath", ["-u", input]);
});

it("keeps native Linux, macOS and Windows paths without invoking a converter", async () => {
  const run = vi.fn();
  for (const platform of ["linux", "darwin"] as const) {
    expect(await resolvePinnedFilePath("~/notes/../today.md", { platform, home: "/home/example", wsl: true, run })).toBe("/home/example/today.md");
    expect(await resolvePinnedFilePath("/mnt/c/Users/example/notes.md", { platform, wsl: true, run })).toBe("/mnt/c/Users/example/notes.md");
  }
  for (const input of ["C:/Users/example/notes.md", String.raw`C:\Users\example\notes.md`, String.raw`~\notes.md`, "~/notes.md"]) {
    expect(await resolvePinnedFilePath(input, { platform: "win32", home: String.raw`C:\Users\example`, run })).toBe(String.raw`C:\Users\example\notes.md`);
  }
  expect(await resolvePinnedFilePath(String.raw`\\server\share\notes.md`, { platform: "win32", run })).toBe(String.raw`\\server\share\notes.md`);
  expect(run).not.toHaveBeenCalled();
});

it("rejects relative paths, URLs and Windows paths outside Windows or WSL", async () => {
  const run = vi.fn();
  for (const platform of ["linux", "darwin"] as const) {
    for (const path of ["notes.md", "C:notes.md", "https://example.com/notes.md", "file:///notes.md"]) {
      await expect(resolvePinnedFilePath(path, { platform, wsl: false, run })).rejects.toThrow(PINNED_FILE_ERRORS.absolutePath);
    }
    await expect(resolvePinnedFilePath(String.raw`C:\notes.md`, { platform, wsl: false, run })).rejects.toThrow(PINNED_FILE_ERRORS.windowsPath);
  }
  expect(run).not.toHaveBeenCalled();
});

it.each(["", "relative.md\n", "/notes.md\n/private/output\n", "/bad\u0000path\n", "/" + "x".repeat(4096)])("rejects unusable converter output without exposing it", async output => {
  await expect(resolvePinnedFilePath(String.raw`C:\notes.md`, {
    platform: "linux", wsl: true, run: vi.fn().mockResolvedValue(output),
  })).rejects.toThrow(PINNED_FILE_ERRORS.wslPath);
});

it("sanitizes converter failures without guessing a mount or inspecting the target", async () => {
  const run = vi.fn().mockRejectedValue(new Error("PRIVATE_PATH_AND_SUBPROCESS_OUTPUT"));
  await expect(resolvePinnedFilePath(String.raw`C:\notes.md`, { platform: "linux", wsl: true, run })).rejects.toThrow(new Error(PINNED_FILE_ERRORS.wslPath));
  expect(run).toHaveBeenCalledTimes(1);
});
