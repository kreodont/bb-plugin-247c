import { z } from "zod";

// Only these fixed messages may cross the private-file UI error boundary.
export const PINNED_FILE_ERRORS = {
  absolutePath: "Use an absolute file path or a path starting with ~/.",
  windowsPath: "Use a path on the machine running BB. Windows paths require Windows or WSL.",
  wslPath: "Could not convert the Windows path in WSL. Enter its Linux path, or check that wslpath is available and the drive is mounted.",
  readSettings: "Could not read pinned-file settings. Check the local settings file permissions.",
  invalidSettings: "Invalid pinned-file settings. The existing file has been left unchanged.",
  saveSettings: "Could not save pinned-file settings. Check the local settings file permissions. No file contents were changed.",
  limit: "You can pin up to 24 files. Remove one before adding another.",
  unavailable: "The local machine is unavailable. Reconnect it before pinning a file.",
} as const;

export function pinnedFileSaveError(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return Object.values(PINNED_FILE_ERRORS).find(known => message.includes(known))
    ?? "Could not save pinned files. Check the local settings and try again.";
}

const singleLine = (max: number) => z.string().trim().min(1).max(max).refine(value => !/[\u0000-\u001f\u007f]/u.test(value), "Use a single line.");
export const pinnedFileInputSchema = z.object({ name: singleLine(120), path: singleLine(4096) }).strict();
export const pinnedFileSchema = pinnedFileInputSchema.extend({ id: z.uuid(), hostId: singleLine(200) });
export const pinnedFilesSchema = z.object({ files: z.array(pinnedFileSchema).max(24) }).strict();
export type PinnedFile = z.infer<typeof pinnedFileSchema>;
export const pinnedFilesRpcContract = {
  pinnedFiles: { input: z.object({}).strict(), output: pinnedFilesSchema },
  pinnedFileTarget: { input: z.object({ id: z.uuid(), threadId: singleLine(120) }).strict(), output: pinnedFileSchema },
  pinFile: { input: pinnedFileInputSchema, output: pinnedFilesSchema },
  unpinFile: { input: z.object({ id: z.uuid() }).strict(), output: pinnedFilesSchema },
};
