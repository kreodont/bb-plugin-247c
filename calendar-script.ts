import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { calendarEventSchema, dayDateSchema, type DayItem } from "./day-contracts.js";

export const calendarCommandSchema = z.array(z.string().min(1).max(4096)).max(20)
  .refine(args => !args.length || isAbsolute(args[0]!), "Use an absolute calendar reader executable.");
const resultSchema = z.object({ events: z.array(calendarEventSchema).max(3000), readCount: z.number().int().min(0) }).strict();

// The executable is configured locally by the user. Source records cannot
// select commands or arguments. The reader receives one bounded JSON request.
export async function readScriptCalendar(command: string[], input: { from: string; through: string; known: DayItem[]; signal: AbortSignal }) {
  const argv = calendarCommandSchema.parse(command);
  if (!argv.length) throw new Error("The calendar reader command is empty.");
  const request = { from: dayDateSchema.parse(input.from), through: dayDateSchema.parse(input.through),
    known: input.known.map(item => item.calendar).filter(Boolean) };
  const body = JSON.stringify(request);
  if (Buffer.byteLength(body) > 8 * 1024 * 1024) throw new Error("Too many previous meetings for one calendar check.");
  input.signal.throwIfAborted();
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(300_000)]);
  return new Promise<z.infer<typeof resultSchema>>((resolve, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), { shell: false, stdio: ["pipe", "pipe", "pipe"], signal });
    const output: Buffer[] = [], errors: Buffer[] = [];
    let bytes = 0, errorBytes = 0, overflow = false;
    child.stdout.on("data", (data: Buffer) => {
      bytes += data.length;
      if (bytes > 8 * 1024 * 1024) { overflow = true; child.kill("SIGKILL"); }
      else output.push(data);
    });
    child.stderr.on("data", (data: Buffer) => { if (errorBytes < 8192) errors.push(data); errorBytes += data.length; });
    child.on("error", reject);
    child.stdin.on("error", error => { if (!child.killed) reject(error); });
    child.on("close", code => {
      try {
        signal.throwIfAborted();
        if (overflow) throw new Error("Calendar reader output is too large.");
        if (code !== 0) throw new Error(`Calendar reader failed: ${Buffer.concat(errors).toString("utf8").slice(0, 1000) || `exit ${code}`}`);
        const result = resultSchema.parse(JSON.parse(Buffer.concat(output).toString("utf8")));
        if (new Set(result.events.map(event => event.key)).size !== result.events.length) throw new Error("The calendar reader returned duplicate meetings.");
        if (result.events.some(event => event.url && new URL(event.url).protocol !== "https:")) throw new Error("Meeting links must use HTTPS.");
        resolve(result);
      } catch (error) { reject(error); }
    });
    child.stdin.end(body);
  });
}
