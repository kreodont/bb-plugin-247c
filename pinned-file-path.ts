import { execFile } from "node:child_process";
import { homedir, release } from "node:os";
import { posix, win32 } from "node:path";
import { promisify } from "node:util";
import { PINNED_FILE_ERRORS } from "./pinned-files-contracts.js";

const execute = promisify(execFile);
type Run = (command: string, args: string[]) => Promise<string>;
const run: Run = async (command, args) => (await execute(command, args, {
  timeout: 10000, maxBuffer: 65536, windowsHide: true,
})).stdout;

// Convert path syntax only. Never open, stat or read the pinned target.
export async function resolvePinnedFilePath(input: string, options: {
  platform?: NodeJS.Platform; home?: string; wsl?: boolean; run?: Run;
} = {}): Promise<string> {
  const platform = options.platform ?? process.platform;
  const paths = platform === "win32" ? win32 : posix;
  const homePath = input.startsWith("~/") || (platform === "win32" && input.startsWith("~\\"));
  const path = homePath ? paths.join(options.home ?? homedir(), input.slice(2)) : input;
  if (platform === "win32") {
    if (!win32.isAbsolute(path)) throw new Error(PINNED_FILE_ERRORS.absolutePath);
    return win32.normalize(path);
  }
  const windowsPath = /^[a-z]:[\\/]/iu.test(path) || /^\\\\[^\\/]+[\\/][^\\/]+(?:[\\/]|$)/u.test(path);
  if (windowsPath) {
    if (platform !== "linux" || !(options.wsl ?? /microsoft/iu.test(release()))) {
      throw new Error(PINNED_FILE_ERRORS.windowsPath);
    }
    try {
      // One literal argument, no shell; wslpath honors custom mount locations.
      const converted = (await (options.run ?? run)("wslpath", ["-u", path])).replace(/\r?\n$/u, "");
      if (!posix.isAbsolute(converted) || converted.length > 4096 || /[\u0000-\u001f\u007f]/u.test(converted)) throw new Error();
      return posix.normalize(converted);
    } catch {
      // Subprocess errors can contain private paths and output.
      throw new Error(PINNED_FILE_ERRORS.wslPath);
    }
  }
  if (!posix.isAbsolute(path)) throw new Error(PINNED_FILE_ERRORS.absolutePath);
  return posix.normalize(path);
}
