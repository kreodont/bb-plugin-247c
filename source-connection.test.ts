import { expect, it, vi } from "vitest";
import { establishSourceConnection } from "./source-connection.js";

const signal = () => new AbortController().signal;
const timeout = () => new Error("MCP error -32001: Request timed out");
const session = () => ({ connect: vi.fn(async (_signal: AbortSignal) => {}),
  listTools: vi.fn(async (_signal: AbortSignal) => ["read"]), close: vi.fn(async () => {}) });
const waitForAbort = (signal: AbortSignal) => new Promise<never>((_resolve, reject) => {
  if (signal.aborted) reject(signal.reason);
  else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
});

it.each(["initialization", "tool discovery"])("recovers %s with a fresh session and closes the failed one first", async stage => {
  const first = session(), second = session();
  if (stage === "initialization") first.connect.mockRejectedValue(timeout());
  else first.listTools.mockRejectedValue(timeout());
  const create = vi.fn().mockReturnValueOnce(first).mockImplementationOnce(() => {
    expect(first.close).toHaveBeenCalledTimes(1); return second;
  });
  expect(await establishSourceConnection(create, ["read"], signal(), { retryDelayMs: 0 })).toBe(second);
  expect(create).toHaveBeenCalledTimes(2);
  expect(second.close).not.toHaveBeenCalled();
  if (stage === "initialization") expect(first.listTools).not.toHaveBeenCalled();
});

it("bounds repeated setup failures and names the stage without claiming any reads", async () => {
  const attempts: ReturnType<typeof session>[] = [];
  const create = () => { const s = session(); s.listTools.mockRejectedValue(timeout()); attempts.push(s); return s; };
  await expect(establishSourceConnection(create, ["read"], signal(), { retryDelayMs: 0 }))
    .rejects.toThrow("Source connection failed during tool discovery after 2 attempts: MCP error -32001: Request timed out. No source data was read.");
  expect(attempts).toHaveLength(2);
  for (const s of attempts) expect(s.close).toHaveBeenCalledTimes(1);
});

it.each([401, 403, 404])("does not retry permanent HTTP %i even if its diagnostic mentions a timeout", async status => {
  const s = session(); s.connect.mockRejectedValue(new Error(`HTTP ${status}: Request timed out for this account.`));
  const create = vi.fn(() => s);
  await expect(establishSourceConnection(create, ["read"], signal(), { retryDelayMs: 0 })).rejects.toThrow(`HTTP ${status}`);
  expect(create).toHaveBeenCalledTimes(1); expect(s.close).toHaveBeenCalledTimes(1);
});

it("rejects a changed tool catalog without repeated initialization", async () => {
  const s = session(); s.listTools.mockResolvedValue(["write"]);
  const create = vi.fn(() => s);
  await expect(establishSourceConnection(create, ["read"], signal())).rejects.toThrow("source tool set changed");
  expect(create).toHaveBeenCalledTimes(1); expect(s.close).toHaveBeenCalledTimes(1);
});

it("does not start setup after cancellation", async () => {
  const parent = new AbortController(); parent.abort(); const create = vi.fn(session);
  await expect(establishSourceConnection(create, ["read"], parent.signal)).rejects.toThrow("check was stopped");
  expect(create).not.toHaveBeenCalled();
});

it("closes the pending session and does not retry cancellation", async () => {
  const parent = new AbortController(), s = session();
  s.connect.mockImplementation(async () => { parent.abort(); throw timeout(); });
  const create = vi.fn(() => s);
  await expect(establishSourceConnection(create, ["read"], parent.signal)).rejects.toThrow("check was stopped");
  expect(create).toHaveBeenCalledTimes(1); expect(s.close).toHaveBeenCalledTimes(1);
});

it("honors cancellation between attempts", async () => {
  const parent = new AbortController(), s = session(); s.connect.mockRejectedValue(timeout());
  s.close.mockImplementation(async () => { parent.abort(); });
  const create = vi.fn(() => s);
  await expect(establishSourceConnection(create, ["read"], parent.signal)).rejects.toThrow("check was stopped");
  expect(create).toHaveBeenCalledTimes(1);
});

it("bounds the total setup time, including a hanging tool discovery", async () => {
  const s = session(); s.listTools.mockImplementation(waitForAbort); const create = vi.fn(() => s);
  await expect(establishSourceConnection(create, ["read"], signal(), { budgetMs: 10 })).rejects.toThrow("setup timed out after 0.01 seconds during tool discovery");
  expect(create).toHaveBeenCalledTimes(1); expect(s.close).toHaveBeenCalledTimes(1);
});

it("preserves a useful redacted diagnostic when cleanup also fails", async () => {
  const s = session(); s.connect.mockRejectedValue(new Error("HTTP 403: Bearer secret-token"));
  s.close.mockRejectedValue(new Error("Cleanup failed"));
  await expect(establishSourceConnection(() => s, ["read"], signal())).rejects.toThrow("HTTP 403: Bearer [redacted]");
});
