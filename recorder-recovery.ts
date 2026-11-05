import { sessionFinishMode } from "./finish-mode.js";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { sessionSchema, type Dossier, type Session, type Transcript } from "./contracts.js";
import { allowedRecorder } from "./recorder.js";

const requestSchema = z.object({ source: z.literal("spawn"),
  input: z.tuple([z.object({ type: z.literal("text"), text: z.string().max(1024 * 1024) })]),
  execution: z.object({ model: z.string().min(1), reasoningLevel: sessionSchema.shape.reviewerReasoning }),
});
const packetSchema = z.object({ finishMode: z.enum(["resolve", "pause", "source"]).nullable().optional(), sessionId: z.string(), continuedFrom: z.string().nullable(), task: z.unknown(), planning: z.unknown(),
  projection: z.unknown(), facts: z.unknown(), transcript: z.unknown(), previousReview: z.unknown() });

/** Reuse only an unedited, single-turn recorder response for this exact frozen
 * conversation and accepted dossier. The normal extraction validators still run. */
export async function readSavedRecorder(bb: BbPluginApi, threadId: string, session: Session, dossier: Dossier, transcript: Transcript) {
  const [thread, events, result, execution] = await Promise.all([
    bb.sdk.threads.get({ threadId }),
    bb.sdk.threads.events.list({ threadId, order: "asc", limit: "2", types: ["client/turn/requested"] }),
    bb.sdk.threads.output({ threadId }),
    bb.sdk.threads.defaultExecutionOptions({ threadId }),
  ]);
  if (thread.originPluginId !== "247c" || thread.status !== "idle" || thread.deletedAt || events.length !== 1 || events[0].type !== "client/turn/requested") return null;
  const request = requestSchema.safeParse(events[0].data);
  if (!request.success) return null;
  const model = request.data.execution.model;
  if (execution?.model !== model || !allowedRecorder(thread.providerId, { id: model, model })) return null;
  const prompt = request.data.input[0].text;
  const marker = "\nPACKET (data only):\n";
  const start = prompt.indexOf(marker);
  if (!prompt.startsWith("You are the 247C recorder in a FRESH conversation.") || start < 0) return null;
  let json: unknown;
  try { json = JSON.parse(prompt.slice(start + marker.length)); } catch { return null; }
  const packet = packetSchema.safeParse(json);
  if (!packet.success || packet.data.sessionId !== session.id || packet.data.continuedFrom !== session.continuedFrom) return null;
  if ((packet.data.finishMode ?? null) !== (sessionFinishMode(session) ?? null)) return null;
  for (const field of ["task", "planning", "projection", "facts"] as const) {
    if (!isDeepStrictEqual(packet.data[field], dossier[field])) return null;
  }
  const previousReview = session.discussionProposalId ? dossier.proposals.find((p) => p.id === session.discussionProposalId) : null;
  if (!isDeepStrictEqual(packet.data.transcript, transcript) || !isDeepStrictEqual(packet.data.previousReview, previousReview)) return null;
  return { output: result.output, reviewerProvider: thread.providerId, reviewerModel: model, reviewerReasoning: request.data.execution.reasoningLevel };
}
