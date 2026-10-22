import { expect, it, vi } from "vitest";
import { poolAccessToken } from "./source-pool-auth.js";
import { parseSourceConfig } from "./source-config.js";

const pool = { pluginId: "example-pool", accountId: "11111111-1111-4111-8111-111111111111", organizationUuid: "22222222-2222-4222-8222-222222222222" };
const signal = new AbortController().signal;
const prepared = { credentialFile: "/private/pool/account.json", accountEmail: "work@example.com", organizationUuid: pool.organizationUuid, expiresAt: 999999 };
const dependencies = () => ({ prepare: vi.fn(async () => prepared), readCredential: vi.fn(async () => JSON.stringify({ kind: "oauth", accessToken: "test-secret", expiresAt: 999999 })), now: () => 1000 });

it("reads only the explicitly prepared independent credential and does not rotate it", async () => {
  const d = dependencies();
  expect(await poolAccessToken(pool, "work@example.com", signal, d)).toBe("test-secret");
  expect(d.prepare).toHaveBeenCalledExactlyOnceWith(pool, "work@example.com", signal);
  expect(d.readCredential).toHaveBeenCalledExactlyOnceWith(prepared.credentialFile);
  expect(parseSourceConfig(JSON.stringify({ expectedEmail: "work@example.com", accountPool: pool })).accountPool).toEqual(pool);
  expect(parseSourceConfig("{}").accountPool).toBeNull();
});

it("refuses wrong identity, organization, relative path and expired preparation before reading credentials", async () => {
  for (const change of [{ accountEmail: "personal@example.com" }, { organizationUuid: "33333333-3333-4333-8333-333333333333" }, { credentialFile: "relative.json" }, { expiresAt: 1 }]) {
    const d = dependencies();
    d.prepare.mockResolvedValue({ ...prepared, ...change });
    await expect(poolAccessToken(pool, "work@example.com", signal, d)).rejects.toThrow();
    expect(d.readCredential).not.toHaveBeenCalled();
  }
});

it("fails once without another login or leaking credential contents", async () => {
  const d = dependencies();
  d.prepare.mockRejectedValue(new Error("Pool unavailable"));
  await expect(poolAccessToken(pool, "work@example.com", signal, d)).rejects.toThrow("Pool unavailable");
  expect(d.prepare).toHaveBeenCalledTimes(1);
  expect(d.readCredential).not.toHaveBeenCalled();
  const corrupt = dependencies();
  corrupt.readCredential.mockResolvedValue("sensitive-corrupt-credential");
  await expect(poolAccessToken(pool, "work@example.com", signal, corrupt)).rejects.toThrow(/^The source account pool credential file is unavailable or invalid\.$/);
  const expired = dependencies();
  expired.readCredential.mockResolvedValue(JSON.stringify({ kind: "oauth", accessToken: "test-secret", expiresAt: 1 }));
  await expect(poolAccessToken(pool, "work@example.com", signal, expired)).rejects.toThrow("expired");
});
