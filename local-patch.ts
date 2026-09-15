import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import { validateSettings, type LocalSettings, type SettingsHandle } from "./settings.js";

export const PATCH_FILE = "local.patch.json";
export const PATCH_FORMAT = "247c-local-settings-v1";
const MAX_BYTES = 256 * 1024;
export function patchPath(database: string): string | null {
  return isAbsolute(database) ? join(dirname(database), PATCH_FILE) : null;
}
export function readPatch(path: string): Partial<LocalSettings> {
  try {
    if (statSync(path).size > MAX_BYTES) throw new Error();
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (!value || value.format !== PATCH_FORMAT || Object.keys(value).some(key => !["format", "settings"].includes(key))) throw new Error();
    return validateSettings(value.settings);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Invalid local settings patch:")) throw error;
    throw new Error("Cannot read the 247C local settings patch. Check its format, size and file permissions; the file was left unchanged.");
  }
}
export function writePatch(path: string, settings: Partial<LocalSettings>) {
  validateSettings(settings);
  const text = JSON.stringify({ format: PATCH_FORMAT, settings }, null, 2) + "\n";
  if (Buffer.byteLength(text) > MAX_BYTES) throw new Error("The local settings patch is too large.");
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const fd = openSync(temporary, "wx", 0o600);
    try { writeFileSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, path);
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
}

export async function applyLocalPatch(settings: SettingsHandle, database: string, reportError: (message: string) => void) {
  // In-memory databases used by tests have no persistent installation directory.
  const path = patchPath(database);
  if (!path) return;
  if (existsSync(path)) await settings.experimental_set(readPatch(path));
  // Pin the effective settings, including defaults introduced by this release.
  // BB owns the database directory; updates replace code in a different place.
  writePatch(path, await settings.get());
  settings.onChange((next, prev) => {
    try {
      // Preserve unrelated edits made directly to the patch while BB is running.
      // Apply those on reload. Only mirror the keys the user just changed in BB.
      const patch = readPatch(path);
      for (const key of Object.keys(next) as (keyof LocalSettings)[]) {
        if (next[key] !== prev[key]) Object.assign(patch, { [key]: next[key] });
      }
      writePatch(path, patch);
    } catch {
      reportError("Could not save the 247C local settings patch. BB settings were saved, but reload could restore older values. Repair the local patch before updating or reloading.");
    }
  });
}
