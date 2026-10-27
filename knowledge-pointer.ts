import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";

// Windows directory junctions work without Developer Mode or administrator
// privileges. Unlike POSIX symlinks, they cannot replace an existing directory
// with one rename. Readers inside 247C use immutable generation paths directly.
export async function publishKnowledgePointer(root: string, directory: string, platform = process.platform) {
  const current = path.join(root, "current");
  let exists = false;
  try {
    if (!(await fs.lstat(current)).isSymbolicLink()) throw new Error("The knowledge current pointer is not an export symlink.");
    exists = true;
    if (await fs.realpath(current) === await fs.realpath(directory)) return;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const pointer = path.join(root, `.current-${randomUUID()}`);
  const previous = path.join(root, `.previous-${randomUUID()}`);
  let movedPrevious = false;
  let published = false;
  try {
    await fs.symlink(platform === "win32" ? path.resolve(directory) : path.relative(root, directory), pointer,
      platform === "win32" ? "junction" : "dir");
    if (platform === "win32" && exists) {
      await fs.rename(current, previous);
      movedPrevious = true;
    }
    try { await fs.rename(pointer, current); published = true; }
    catch (error) {
      if (movedPrevious) await fs.rename(previous, current);
      throw error;
    }
  } finally {
    await fs.rm(pointer, { force: true });
    if (published && movedPrevious) await fs.rm(previous, { force: true });
  }
}
