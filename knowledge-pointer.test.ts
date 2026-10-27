import { afterEach, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { publishKnowledgePointer } from "./knowledge-pointer.js";

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rename: vi.fn(actual.rename) };
});
const roots: string[] = [];
afterEach(async () => { vi.mocked(fs.rename).mockClear(); for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "247c-pointer-")); roots.push(root);
  const first = path.join(root, "first"), second = path.join(root, "second");
  await fs.mkdir(first); await fs.mkdir(second);
  await fs.writeFile(path.join(first, "note.md"), "Keep the old generation.");
  return { root, first, second, current: path.join(root, "current") };
}

it.each(["linux", "win32"] as const)("publishes and replaces the current pointer on %s while retaining generations", async platform => {
  const { root, first, second, current } = await setup();
  await publishKnowledgePointer(root, first, platform);
  expect(await fs.realpath(current)).toBe(await fs.realpath(first));
  vi.mocked(fs.rename).mockClear();
  await publishKnowledgePointer(root, first, platform);
  expect(fs.rename).not.toHaveBeenCalled();
  await publishKnowledgePointer(root, second, platform);
  expect(await fs.realpath(current)).toBe(await fs.realpath(second));
  expect(await fs.readFile(path.join(first, "note.md"), "utf8")).toBe("Keep the old generation.");
  expect((await fs.readdir(root)).filter(name => name.startsWith("."))).toEqual([]);
});

it("restores the previous Windows pointer when publishing the replacement fails", async () => {
  const { root, first, second, current } = await setup();
  await publishKnowledgePointer(root, first, "win32");
  const original = (await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")).rename;
  vi.mocked(fs.rename).mockImplementationOnce(original).mockRejectedValueOnce(new Error("Publication failed"));
  await expect(publishKnowledgePointer(root, second, "win32")).rejects.toThrow("Publication failed");
  expect(await fs.realpath(current)).toBe(await fs.realpath(first));
  expect((await fs.readdir(root)).filter(name => name.startsWith("."))).toEqual([]);
});

it("refuses to replace a real directory with a knowledge pointer", async () => {
  const { root, first, current } = await setup();
  await fs.mkdir(current); await fs.writeFile(path.join(current, "keep.md"), "User content");
  await expect(publishKnowledgePointer(root, first, "win32")).rejects.toThrow("not an export symlink");
  expect(await fs.readFile(path.join(current, "keep.md"), "utf8")).toBe("User content");
});
