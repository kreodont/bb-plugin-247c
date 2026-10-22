import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import type { SourceConfig } from "./source-config.js";

const execute = promisify(execFile);
const preparedSchema = z.object({ credentialFile: z.string().refine(isAbsolute), accountEmail: z.email(), organizationUuid: z.string().uuid(), expiresAt: z.number().positive() }).strict();
const credentialSchema = z.object({ kind: z.literal("oauth"), accessToken: z.string().min(1), expiresAt: z.number().positive() });
type Pool = NonNullable<SourceConfig["accountPool"]>;

async function prepare(pool: Pool, expectedEmail: string, signal: AbortSignal): Promise<unknown> {
  const directory = await mkdtemp(join(tmpdir(), "247c-source-auth-"));
  try {
    const input = join(directory, "request.json");
    await writeFile(input, JSON.stringify({ accountId: pool.accountId, organizationUuid: pool.organizationUuid, expectedEmail }), { mode: 0o600 });
    const result = await execute(process.env.BB_CLI || "bb", ["plugin", "rpc", "call", pool.pluginId, "source-auth.v1.prepare", "--input-file", input, "--json"], { timeout: 30000, maxBuffer: 64 * 1024, signal });
    return JSON.parse(result.stdout);
  } catch { throw new Error("The configured source account pool could not prepare its login. Check its account and organization; no other login was used."); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

async function readCredential(path: string) {
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 64 * 1024 || (process.platform !== "win32" && (stat.mode & 0o077) !== 0)) throw Error();
    return await file.readFile("utf8");
  } finally { await file.close(); }
}

export async function poolAccessToken(pool: Pool, expectedEmail: string, signal: AbortSignal, dependencies = { prepare, readCredential, now: Date.now }): Promise<string> {
  signal.throwIfAborted();
  const response = await dependencies.prepare(pool, expectedEmail, signal);
  const prepared = preparedSchema.safeParse(response);
  if (!prepared.success || prepared.data.accountEmail.toLowerCase() !== expectedEmail.toLowerCase() || prepared.data.organizationUuid !== pool.organizationUuid) throw new Error("The source account pool returned a different or invalid account identity.");
  if (prepared.data.expiresAt <= dependencies.now() + 60000) throw new Error("The source account pool login expired. Check the configured pool account.");
  let auth: z.infer<typeof credentialSchema>;
  try { auth = credentialSchema.parse(JSON.parse(await dependencies.readCredential(prepared.data.credentialFile))); }
  catch { throw new Error("The source account pool credential file is unavailable or invalid."); }
  // A concurrent owner refresh can replace the file. Never refresh or copy it here.
  if (auth.expiresAt <= dependencies.now() + 60000) throw new Error("The source account pool credential expired.");
  signal.throwIfAborted();
  return auth.accessToken;
}
