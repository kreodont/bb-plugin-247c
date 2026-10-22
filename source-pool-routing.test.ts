import { expect, it, vi } from "vitest";
vi.mock("./source-pool-auth.js", () => ({ poolAccessToken: vi.fn(async () => { throw new Error("Selected pool is unavailable"); }) }));
import { poolAccessToken } from "./source-pool-auth.js";
import { connectSources, connectCalendar } from "./source-connectors.js";
import { parseSourceConfig } from "./source-config.js";

it("source and calendar checks stop on a configured pool failure without trying a profile", async () => {
  const config = parseSourceConfig(JSON.stringify({ expectedEmail: "work@example.com", accountPool: { pluginId: "example-pool", accountId: "11111111-1111-4111-8111-111111111111", organizationUuid: "22222222-2222-4222-8222-222222222222" } }));
  const signal = new AbortController().signal;
  const result = await connectSources(signal, config);
  for (const source of Object.values(result)) expect(source).toEqual({ error: "Selected pool is unavailable" });
  await expect(connectCalendar(signal, config)).rejects.toThrow("Selected pool is unavailable");
  expect(poolAccessToken).toHaveBeenCalledTimes(2);
});
