import { z } from "zod";

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
