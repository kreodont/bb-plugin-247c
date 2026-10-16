import { open } from "node:fs/promises";
import { isAbsolute, dirname, join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { constants, closeSync, fstatSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { PINNED_FILE_ERRORS, pinnedFileInputSchema, pinnedFilesSchema, type PinnedFile } from "./pinned-files-contracts.js";

// Installation-only preferences. Kept outside SQLite, BB's exported settings,
// and local.patch.json, which is included in recovery archives. Never open,
// stat, watch, copy or index a pinned target; only the host editor handles it.
export const PINNED_FILES_NAME = "pinned-files.local.json";
const pinnedSettingsSchema = pinnedFilesSchema.extend({ version: z.literal(1) }).strict();
const MAX_PINNED_BYTES = 256 * 1024;
export class PinnedFilesSettings {
  private readonly file: string | null;
  private memory: PinnedFile[] = [];
  constructor(database: string) { this.file = isAbsolute(database) ? join(dirname(database), PINNED_FILES_NAME) : null; }
  list(): { files: PinnedFile[] } {
    if (!this.file) return { files: structuredClone(this.memory) };
    let fd: number;
    try { fd = openSync(this.file, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { files: [] };
      throw new Error(PINNED_FILE_ERRORS.readSettings);
    }
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > MAX_PINNED_BYTES) throw new Error();
      const body = readFileSync(fd);
      if (body.length > MAX_PINNED_BYTES) throw new Error();
      const { files } = pinnedSettingsSchema.parse(JSON.parse(body.toString("utf8")));
      if (files.some(file => !isAbsolute(file.path)) || new Set(files.map(file => file.id)).size !== files.length) throw new Error();
      return { files };
    } catch { throw new Error(PINNED_FILE_ERRORS.invalidSettings); }
    finally { closeSync(fd); }
  }
  add(input: z.infer<typeof pinnedFileInputSchema>, hostId: string) {
    const value = pinnedFileInputSchema.parse(input);
    const expanded = value.path.startsWith("~/") ? join(homedir(), value.path.slice(2)) : value.path;
    if (!isAbsolute(expanded)) throw new Error(PINNED_FILE_ERRORS.absolutePath);
    const path = resolve(expanded), files = this.list().files;
    const match = files.find(file => file.hostId === hostId && (process.platform === "win32" ? file.path.toLowerCase() === path.toLowerCase() : file.path === path));
    if (match) match.name = value.name;
    else files.push({ id: randomUUID(), name: value.name, path, hostId });
    if (files.length > 24) throw new Error(PINNED_FILE_ERRORS.limit);
    return this.save(files);
  }
  remove(id: string) { return this.save(this.list().files.filter(file => file.id !== id)); }
  private save(files: PinnedFile[]) {
    const value = pinnedSettingsSchema.parse({ version: 1, files });
    if (!this.file) { this.memory = value.files; return { files: value.files }; }
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      const fd = openSync(temporary, "wx", 0o600);
      try { writeFileSync(fd, JSON.stringify(value, null, 2) + "\n"); fsyncSync(fd); }
      finally { closeSync(fd); }
      renameSync(temporary, this.file);
    } catch { throw new Error(PINNED_FILE_ERRORS.saveSettings); }
    finally { try { unlinkSync(temporary); } catch { /* Renamed or not created. */ } }
    return { files: value.files };
  }
}

export const composerDefaultsSchema = z.object({
  providerId: z.enum(["codex", "claude-code", "claude-work"]).nullable().default(null),
  model: z.string().trim().min(1).max(200).nullable().default(null),
}).strict().refine(value => Boolean(value.providerId) === Boolean(value.model), "Set the default account and model together.");

const settingsPatchSchema = z.object({
  version: z.literal(1),
  settings: z.record(z.string(), z.union([z.string(), z.number().finite(), z.boolean(), z.null()])),
}).strict();

// Local values are intentionally absent from the package. Each new plugin
// activation reapplies the same user-owned file through BB's settings validator.
export async function applyLocalSettingsPatch(path: string, allowed: readonly string[],
  apply: (values: Record<string, string | number | boolean | null>) => Promise<unknown>) {
  if (!path.trim()) return null;
  if (!isAbsolute(path)) throw new Error("Local settings patch must use an absolute path.");
  const file = await open(path, "r");
  let body: Buffer;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 65536) throw new Error("Local settings patch must be a regular file of at most 64 KiB.");
    body = await file.readFile();
    if (body.length > 65536) throw new Error("Local settings patch is too large.");
  } finally { await file.close(); }
  let patch: z.infer<typeof settingsPatchSchema>;
  try { patch = settingsPatchSchema.parse(JSON.parse(body.toString("utf8"))); }
  catch { throw new Error("Invalid local settings patch. Expected version 1 with a settings object."); }
  const keys = Object.keys(patch.settings);
  const unknown = keys.filter(key => key === "localSettingsPatch" || !allowed.includes(key));
  if (unknown.length) throw new Error(`Unsupported local settings patch keys: ${unknown.join(", ")}. No settings were changed.`);
  // experimental_set validates the complete update before persisting any key.
  await apply(patch.settings);
  return { sha256: createHash("sha256").update(body).digest("hex"), keys };
}
