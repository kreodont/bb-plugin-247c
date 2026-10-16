import { statSync } from "node:fs";
import path from "node:path";

const ASSETS = ["editor.js", "editor.css", "editor.worker.js"];

export function monacoAssetDirectory(moduleDir: string): string {
  // Git installs do not preserve build timestamps and omit build dependencies.
  // Both source-relative and dist-relative module URLs must use shipped assets.
  for (const directory of [path.join(moduleDir, "monaco"), path.join(moduleDir, "dist", "monaco"), path.join(moduleDir, "..", "dist", "monaco")]) {
    if (ASSETS.every(name => statSync(path.join(directory, name), { throwIfNoEntry: false })?.isFile())) return directory;
  }
  throw new Error("File Editor assets are missing or incomplete. Reinstall the plugin; in a development checkout, run npm run build.");
}
