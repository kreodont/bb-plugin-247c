import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const sourceSchema = z
  .object({
    kind: z.enum(["workspace", "host", "thread-storage"]),
    threadId: z.string().nullable(),
    environmentId: z.string().nullable(),
    projectId: z.string().nullable(),
    experimental_hostId: z.string().optional(),
  })
  .strict();

export const fileSchema = z
  .object({ path: z.string().min(1), source: sourceSchema })
  .strict();

export const editorRpcContract = defineRpcContract({
  editorAssets: {
    input: z.null(),
    output: z.object({ baseUrl: z.string(), expiresAtMs: z.number() }),
  },
  editorRead: {
    input: fileSchema,
    output: z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("text"),
        content: z.string(),
        sha256: z.string(),
        absolutePath: z.string(),
        relativePath: z.string(),
      }),
      z.object({ kind: z.literal("unsupported"), reason: z.string() }),
    ]),
  },
  editorTree: {
    input: z.object({ source: sourceSchema }).strict(),
    output: z.object({
      root: z.string(),
      entries: z.array(
        z.object({
          path: z.string(),
          kind: z.enum(["file", "directory"]),
        }),
      ),
      truncated: z.boolean(),
    }),
  },
  editorReveal: { input: fileSchema, output: z.object({ opened: z.literal(true) }) },
  editorWrite: {
    input: fileSchema.extend({
      content: z.string(),
      expectedSha256: z.string().nullable(),
    }),
    output: z.discriminatedUnion("outcome", [
      z.object({ outcome: z.literal("written"), sha256: z.string() }),
      z.object({
        outcome: z.literal("conflict"),
        currentSha256: z.string().nullable(),
      }),
    ]),
  },
});
