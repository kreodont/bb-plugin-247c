import { z } from "zod";

export const searchInputSchema = z.object({
  query: z.string().trim().max(300).default(""),
  scope: z.enum(["all", "tasks", "history", "messages"]).default("all"),
  status: z.enum(["all", "unfinished", "closed"]).default("all"),
  offset: z.number().int().min(0).max(100000).default(0),
}).strict();
export const searchHitSchema = z.object({
  id: z.string(), taskId: z.string(), taskTitle: z.string(), taskStatus: z.string(),
  kind: z.enum(["task", "fact", "message", "review"]), label: z.string(),
  snippet: z.string(), titleMatch: z.string(), at: z.string().nullable(),
  threadId: z.string().nullable(), sequence: z.number().nullable(), sessionId: z.string().nullable(),
});
export const searchStateSchema = z.object({
  documents: z.number(), pending: z.number(), threads: z.number(), indexedThreads: z.number(),
  unavailableThreads: z.number(), lastIndexedAt: z.string().nullable(),
});
export const searchResultSchema = z.object({ hits: z.array(searchHitSchema), total: z.number(), nextOffset: z.number().nullable(), state: searchStateSchema });
export const searchRpcContract = {
  search: { input: searchInputSchema, output: searchResultSchema },
  searchRetry: { input: z.object({}).strict(), output: searchStateSchema },
};
export type SearchInput = z.infer<typeof searchInputSchema>;
export type SearchResult = z.infer<typeof searchResultSchema>;
export type SearchHit = z.infer<typeof searchHitSchema>;
