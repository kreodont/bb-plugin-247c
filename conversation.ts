import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { extractionSchema, type Dossier, type Extraction, type Session, type Transcript } from "./contracts.js";
import type { ProposalEvidence } from "./core/types.js";
import { PolicyError } from "./core/errors.js";
import { parseProposalDraft, validateEvidence } from "./core/validation.js";
import { digest } from "./repository.js";

const normalize = (text: string) => text.trim().replace(/\s+/g, " ").toLocaleLowerCase();
// Formatting differences around an explicitly labelled next step do not change
// its words. Never strip arbitrary prefixes, especially negation.
const instructionWords = (text: string) => normalize(text).replace(/^(?:next step|следующий шаг)\s*[:—-]\s*/u, "").replace(/[.!?…]+$/u, "");
type TimelineRow = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["timeline"]>>["rows"][number];

export async function readConversation(bb: BbPluginApi, session: Session): Promise<Transcript> {
  if (!session.workerThreadId) throw new PolicyError("The session chat has not been created yet.");
  const messages = new Map<string, Transcript["messages"][number]>();
  const warnings = new Set<string>();
  let bytes = 0;
  function add(row: TimelineRow, role: "user" | "assistant" | "context", text: string, suffix = "") {
    if (!text.trim()) return;
    const ref = `message:${row.sourceSeqStart}:${digest(row.id).slice(0, 12)}${suffix}`;
    if (messages.has(ref)) return;
    bytes += Buffer.byteLength(text);
    if (bytes > 512 * 1024 || messages.size >= 4000) throw new PolicyError("The conversation exceeds the review limit of 512 KiB. The transcript is preserved in the chat; automatic review does not truncate it.");
    messages.set(ref, { ref, role, text, sequence: row.sourceSeqStart });
  }
  function visit(row: TimelineRow) {
    if (row.kind === "turn") {
      if (row.children === null && row.summaryCount > 0) throw new PolicyError("BB returned a collapsed conversation segment without messages. Update BB and retry the review.");
      row.children?.forEach(visit);
    } else if (row.kind === "conversation") {
      if (row.role === "user" && row.turnRequest.status !== "accepted") return;
      const role = row.role === "assistant" ? "assistant" : row.initiator === "user" ? "user" : "context";
      add(row, role, row.text);
      if (row.attachments && (row.attachments.localFiles || row.attachments.localImages || row.attachments.webImages)) warnings.add("The review uses the conversation text. Attachment contents were not independently verified.");
    } else if (row.kind === "work" && row.workKind === "question") {
      row.questions.forEach((question, index) => {
        add(row, "assistant", question.prompt, `:q${index}`);
        const answer = row.answers?.[question.id];
        if (answer) add(row, "user", [...answer.selected.map((value) => question.options?.find((o) => o.value === value)?.label ?? value), answer.freeText ?? ""].filter(Boolean).join("\n"), `:a${index}`);
      });
    }
  }
  let cursor: { anchorId: string; anchorSeq: number } | null = null;
  const seenCursors = new Set<string>();
  for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
    const page = await bb.sdk.threads.timeline({ threadId: session.workerThreadId, segmentLimit: "100", includeNestedRows: "true", summaryOnly: "false", ...(cursor ? { beforeAnchorId: cursor.anchorId, beforeAnchorSeq: String(cursor.anchorSeq) } : {}) });
    page.rows.forEach(visit);
    if (!page.timelinePage.hasOlderRows) {
      const ordered = [...messages.values()].sort((a, b) => a.sequence - b.sequence);
      if (!ordered.length) throw new PolicyError("BB did not return the conversation messages. The transcript is not replaced by the last response; try the review again.");
      return { threadId: session.workerThreadId, capturedAt: new Date().toISOString(), messages: ordered, warnings: [...warnings] };
    }
    cursor = page.timelinePage.olderCursor;
    if (!cursor || seenCursors.has(JSON.stringify(cursor))) throw new PolicyError("Could not read every conversation page. Retry the review.");
    seenCursors.add(JSON.stringify(cursor));
  }
  throw new PolicyError("Too many conversation pages for one review. The full transcript is preserved in BB.");
}

export function acceptedEvidence(dossier: Pick<Dossier, "projection" | "task">): ProposalEvidence[] {
  const evidence: ProposalEvidence[] = [];
  for (const [field, kind] of [["summary", "description"], ["nextStep", "explicit_next_step"], ["openQuestions", "open_question"], ["blockers", "blocker"], ["artifacts", "artifact"]] as const) {
    const current = dossier.projection[field];
    const values = Array.isArray(current) ? current : [current];
    for (const [i, value] of (values.length ? values : [null]).entries()) {
      evidence.push({ ref: `accepted:${field}:${i}`, kind, text: value == null ? `Accepted empty ${field}` : typeof value === "string" ? value : value.label,
        source: `accepted-dossier:${dossier.task.revision}`, sourceRef: value && typeof value === "object" ? value.uri : null });
    }
  }
  return evidence;
}

export function validateExtraction(value: unknown, transcript: Transcript): Extraction {
  const extraction = extractionSchema.parse(value);
  const messages = new Map(transcript.messages.map((m) => [m.ref, m]));
  for (const fact of extraction.facts) {
    for (const citation of fact.citations) {
      const source = messages.get(citation.messageRef);
      if (!source || !source.text.includes(citation.quote)) throw new PolicyError("The review contains a quote missing from the saved conversation.");
      if (["explicit_next_step", "user_instruction"].includes(fact.kind) && source.role !== "user") throw new PolicyError("The next step must come from you, not an assistant suggestion.");
    }
    if (["explicit_next_step", "user_instruction"].includes(fact.kind) && !fact.citations.some((c) => instructionWords(c.quote) === instructionWords(fact.text))) throw new PolicyError("An instruction must preserve the user's words without changing their meaning.");
    // Draft observations may paraphrase or add essential speaker/uncertainty
    // attribution. Lexical overlap is not a factuality check. Quotes are checked
    // against the frozen source; the user reviews meaning before acceptance.
  }
  const factRefs = new Set(extraction.facts.map((_, index) => `fact:${index}`));
  if (extraction.changes?.status) {
    const status = extraction.changes.status;
    const completionFacts = status.evidenceRefs.map((ref) => factRefs.has(ref) ? extraction.facts[Number(ref.slice(5))] : undefined);
    if (!completionFacts.some((fact) => fact && (status.value === "done" ? ["progress", "decision", "user_instruction"] : ["decision", "user_instruction"]).includes(fact.kind) && fact.citations.some((citation) => status.value === "done" ? ["user", "assistant"].includes(messages.get(citation.messageRef)?.role ?? "") : messages.get(citation.messageRef)?.role === "user"))) {
      throw new PolicyError(status.value === "done" ? "A proposal to complete the task must cite a result or decision in this conversation." : "Archiving or reopening a task must cite a user decision in the conversation.");
    }
  }
  for (const field of ["title", "urgent", "important"] as const) {
    const change = extraction.changes?.[field];
    if (change && !change.evidenceRefs.some((ref) => {
      const fact = factRefs.has(ref) ? extraction.facts[Number(ref.slice(5))] : undefined;
      return fact && ["decision", "user_instruction"].includes(fact.kind) && fact.citations.some((c) => messages.get(c.messageRef)?.role === "user");
    })) throw new PolicyError(`${field}: the change must cite a user decision in the conversation.`);
  }
  for (const entry of extraction.knowledge) {
    if (entry.evidenceRefs.some((ref) => !factRefs.has(ref))) throw new PolicyError("The knowledge entry references a missing conversation fact.");
  }
  return extraction;
}

export function extractionEvidence(extraction: Extraction, session: Session, transcript?: Transcript): ProposalEvidence[] {
  return extraction.facts.map((fact, index) => {
    const citation = fact.citations[0];
    const source = transcript?.messages.find((m) => m.ref === citation.messageRef)?.source;
    return { ref: `fact:${index}`, kind: fact.kind, text: fact.text, source: `conversation:${session.id}`, sourceRef: `bb-thread:${source?.threadId ?? session.workerThreadId}#${source?.messageRef ?? citation.messageRef}` };
  });
}

// Preflight the same proposal that the kernel will save. Only failures here
// describe model output; storage, revision and lifecycle errors are not repairs.
export function extractionProposal(extraction: Extraction, session: Session, dossier: Dossier, transcript?: Transcript) {
  const additionalEvidence = [...acceptedEvidence(dossier), ...extractionEvidence(extraction, session, transcript)];
  const changes = extraction.changes ?? { summary: { value: dossier.projection.summary, evidenceRefs: ["accepted:summary:0"] } };
  const output = parseProposalDraft({ rationale: extraction.rationale, confidence: 0.8, changes });
  validateEvidence(output, dossier, additionalEvidence);
  return { output, additionalEvidence };
}

/** Carry prior dialogue forward as source evidence, retaining its real speaker
 * and origin. A recorder's JSON is never turned into a human instruction. */
export function continueTranscript(previous: Transcript, current: Transcript): Transcript {
  const earlier = previous.messages.map((message, sequence) => {
    const source = message.source ?? { threadId: previous.threadId, messageRef: message.ref };
    return { ...message, ref: `prior:${digest(source).slice(0, 32)}`, sequence, source };
  });
  const messages = [...earlier, ...current.messages.map((message, i) => ({ ...message, sequence: earlier.length + i, source: message.source ?? { threadId: current.threadId, messageRef: message.ref } }))];
  if (messages.length > 4000 || messages.reduce((n, m) => n + Buffer.byteLength(m.text), 0) > 512 * 1024) throw new PolicyError("The conversation and previous session together exceed the review limit of 512 KiB. The original transcript is preserved.");
  return { ...current, messages, warnings: [...new Set([...previous.warnings, ...current.warnings])] };
}
