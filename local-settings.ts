import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";

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
