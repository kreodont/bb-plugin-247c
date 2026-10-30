import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { release } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { windowsRevealArgs } from "./windows-reveal.js";

const execute = promisify(execFile);
type Run = (command: string, args: string[], signal: AbortSignal) => Promise<string>;
const run: Run = async (command, args, signal) => {
  const result = await execute(command, args, { signal, timeout: 10000, maxBuffer: 65536, windowsHide: true });
  return result.stdout;
};

export async function revealFile(
  input: { path: string; rootPath: string },
  signal: AbortSignal,
  options: { platform?: NodeJS.Platform; wsl?: boolean; run?: Run } = {},
): Promise<void> {
  if (!path.isAbsolute(input.path) || !path.isAbsolute(input.rootPath)) throw new Error("File location must be absolute.");
  const [file, root] = await Promise.all([realpath(input.path), realpath(input.rootPath)]);
  const relative = path.relative(root, file);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("File location is outside its workspace.");
  if (!(await stat(file)).isFile()) throw new Error("This location is not a file.");
  signal.throwIfAborted();
  const launch = options.run ?? run;
  const platform = options.platform ?? process.platform;
  try {
    if (platform === "darwin") {
      await launch("/usr/bin/open", ["-R", file], signal);
    } else if (platform === "win32") {
      await launch("powershell.exe", windowsRevealArgs(file), signal);
    } else if (platform === "linux" && (options.wsl ?? /microsoft/i.test(release()))) {
      const windowsPath = (await launch("wslpath", ["-w", file], signal)).trim();
      if (!windowsPath) throw new Error("Could not resolve the Windows file location.");
      await launch("powershell.exe", windowsRevealArgs(windowsPath), signal);
    } else if (platform === "linux") {
      try {
        await launch("gdbus", ["call", "--session", "--dest", "org.freedesktop.FileManager1", "--object-path", "/org/freedesktop/FileManager1", "--method", "org.freedesktop.FileManager1.ShowItems", JSON.stringify([pathToFileURL(file).href]), ""], signal);
      } catch {
        signal.throwIfAborted();
        await launch("xdg-open", [path.dirname(file)], signal);
      }
    } else {
      throw new Error("Unsupported operating system.");
    }
  } catch (error) {
    if (signal.aborted) throw error;
    throw new Error("Could not open the file manager on the file’s machine. Check that it has an active desktop session.");
  }
}
