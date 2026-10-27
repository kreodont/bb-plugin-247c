import { posix, win32 } from "node:path";
import { pathToFileURL } from "node:url";
import { PolicyError } from "./core/errors.js";

// Workspaces can belong to a different machine than the plugin server.
export function workspacePaths(root: string) {
  if (!root || root.includes("\0")) return null;
  if (/^[a-z]:[\\/]/i.test(root) || /^[\\/]{2}[^\\/]+[\\/][^\\/]+/.test(root)) return win32;
  return posix.isAbsolute(root) ? posix : null;
}

export function workspaceFileUrl(path: string) {
  return pathToFileURL(path, { windows: workspacePaths(path) === win32 }).href;
}

export function resolveWorkspaceArtifact(root: string, input: string) {
  const paths = workspacePaths(root);
  if (!paths || input.includes("\0") || (paths === posix && input.includes("\\"))) throw new PolicyError("Invalid artifact path.");
  // Drive-relative paths depend on process state; device paths and streams are not ordinary files.
  if (paths === win32 && (/^[a-z]:(?![\\/])/i.test(input) || /^[\\/]{2}[?.][\\/]/.test(input))) throw new PolicyError("Invalid artifact path.");
  const path = paths.resolve(root, input);
  const relative = paths.relative(root, path).replace(/\\/g, "/");
  if (!relative || relative === ".." || relative.startsWith("../") || paths.isAbsolute(relative)) throw new PolicyError("The artifact is outside the session workspace.");
  if (paths === win32 && relative.includes(":")) throw new PolicyError("Invalid artifact path.");
  return { path, relative: paths === win32 ? relative.toLowerCase() : relative, identity: paths === win32 ? path.toLowerCase() : path };
}
