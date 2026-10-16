import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

const filePath = z.string().min(1).max(16384).refine(value => !value.includes("\0"), "Invalid file path");
export const editorHostContract = defineRpcContract({
  revealFile: {
    input: z.object({ path: filePath, rootPath: filePath }).strict(),
    output: z.object({ opened: z.literal(true) }).strict(),
  },
});
