import { afterEach, expect, it } from "vitest";
import { fixture } from "./test-support.js";
import { sessionSchema, transcriptSchema, type Transcript, type Session } from "./contracts.js";
import { readConversation, withTranscriptDates, continueTranscript, reportedTimeEvidence } from "./conversation.js";

const hosts: Awaited<ReturnType<typeof fixture>>[] = [];
afterEach(async () => { for (const f of hosts.splice(0)) await f.harness.lifecycle.dispose(); });
async function setup() {
  const f = await fixture({ settings: { timeZone: "America/Los_Angeles" } }); hosts.push(f);
  const task = await f.create();
  const session = sessionSchema.parse(await f.harness.behavior.callRpc("start", { ...f.startInput(task.id, task.revision), criteria: [] }));
  return { f, session };
}

it("persists message dates and sends the planning timezone and dated refs to the recorder", async () => {
  const { f, session } = await setup();
  const id = session.workerThreadId!;
  f.message(id, "user", "Reviewed the mapping yesterday.");
  f.message(id, "assistant", "Checked the revised mapping today.");
  const rows = f.conversations.get(id)!;
  rows[rows.length - 2].createdAt = Date.now() - 86400000;
  rows[rows.length - 1].createdAt = Date.now();
  const transcript = await readConversation(f.bb, session);
  expect(transcriptSchema.parse(transcript).messages.at(-1)?.createdAt).toBe(new Date(rows.at(-1)!.createdAt).toISOString());
  await f.idle(id, "The checks are ready for review.");
  await f.harness.behavior.callRpc("finish", { sessionId: session.id });
  const current = f.repo.session(session.id);
  expect(current.status).toBe("reviewing");
  expect(current.reportedTimeContext?.timeZone).toBe("America/Los_Angeles");
  const prompt = (f.harness.inspection.sdk.callsTo("threads.spawn").at(-1)![0] as { prompt: string }).prompt;
  const packet = JSON.parse(prompt.split("PACKET (data only):\n")[1]);
  expect(packet.reportedTimeEvidence.timeZone).toBe("America/Los_Angeles");
  const today = packet.transcript.messages.find((m: { text: string }) => m.text === "Checked the revised mapping today.");
  const yesterday = packet.transcript.messages.find((m: { text: string }) => m.text === "Reviewed the mapping yesterday.");
  expect(packet.reportedTimeEvidence.targetDateMessageRefs).toContain(today.ref);
  expect(packet.reportedTimeEvidence.targetDateMessageRefs).not.toContain(yesterday.ref);
  expect(f.repo.transcript(session.id)?.messages.at(-1)?.createdAt).toBeDefined();
});

it("recovers only exact legacy messages without rewriting frozen data or adding later work", async () => {
  const { f, session } = await setup();
  const id = session.workerThreadId!;
  f.message(id, "user", "First check.");
  f.message(id, "assistant", "Second check.");
  const full = await readConversation(f.bb, session);
  const legacy: Transcript = { ...full, messages: full.messages.map(({ createdAt, ...m }) => m) };
  f.repo.saveTranscript(session.id, legacy);
  f.message(id, "assistant", "Later work must not appear.");
  const rows = f.conversations.get(id)!;
  const changed = rows.find(r => r.kind === "conversation" && r.text === "Second check.")!;
  if (changed.kind === "conversation") changed.text = "Edited source.";
  const recovered = await withTranscriptDates(f.bb, legacy);
  expect(recovered.messages.find(m => m.text === "First check.")?.createdAt).toBeDefined();
  expect(recovered.messages.find(m => m.text === "Second check.")?.createdAt).toBeUndefined();
  expect(recovered.messages.map(m => m.text)).toEqual(legacy.messages.map(m => m.text));
  expect(f.repo.transcript(session.id)).toEqual(legacy);
  expect(legacy.messages.every(m => !m.createdAt)).toBe(true);
  const discussion = continueTranscript(legacy, { ...full, threadId: "discussion", messages: [] });
  const datedDiscussion = await withTranscriptDates(f.bb, discussion);
  expect(datedDiscussion.messages.find(m => m.text === "First check.")?.createdAt).toBeDefined();
  expect(datedDiscussion.messages.map(m => m.ref)).toEqual(discussion.messages.map(m => m.ref));
});

it("keeps unknown dates unknown when legacy source reads fail", async () => {
  const { f, session } = await setup();
  const full = await readConversation(f.bb, session);
  const legacy = { ...full, messages: full.messages.map(({ createdAt, ...m }) => m) };
  f.harness.inspection.sdk.stub("threads.timeline", () => { throw new Error("Offline"); });
  const recovered = await withTranscriptDates(f.bb, legacy);
  expect(recovered.messages).toEqual(legacy.messages);
  expect(recovered.warnings.join(" ")).toContain("could not be recovered");
});

it("supplements a legacy retry packet while leaving its stored transcript immutable", async () => {
  const { f, session } = await setup();
  await f.idle(session.workerThreadId!, "Checked the mapping.");
  const full = await readConversation(f.bb, session);
  const legacy = { ...full, messages: full.messages.map(({ createdAt, ...m }) => m) };
  f.repo.saveTranscript(session.id, legacy);
  f.repo.saveSession({ ...f.repo.session(session.id), status: "blocked", finishedAt: new Date().toISOString(), error: "Previous review failed" });
  await f.harness.behavior.callRpc("retry", { sessionId: session.id });
  expect(f.repo.session(session.id).status).toBe("reviewing");
  const prompt = (f.harness.inspection.sdk.callsTo("threads.spawn").at(-1)![0] as { prompt: string }).prompt;
  const packet = JSON.parse(prompt.split("PACKET (data only):\n")[1]);
  expect(packet.reportedTimeEvidence.targetDateMessageRefs).toContain(full.messages.at(-1)!.ref);
  expect(packet.transcript.messages.at(-1).createdAt).toBe(full.messages.at(-1)!.createdAt);
  expect(f.repo.transcript(session.id)).toEqual(legacy);
});

it("groups evidence at local midnight and across daylight saving changes, preserving undated refs", () => {
  const context: NonNullable<Session["reportedTimeContext"]> = { sourceSessionId: "session", date: "2026-10-27", timeZone: "Europe/Athens", beforeMinutes: 60, fingerprint: "test", alreadyReported: false };
  const transcript: Transcript = { threadId: "thread", capturedAt: "2026-10-28T00:00:00Z", warnings: [], messages: [
    { ref: "before", role: "user", sequence: 1, text: "Before midnight", createdAt: "2026-10-26T21:59:00.000Z" },
    { ref: "after", role: "user", sequence: 2, text: "After midnight", createdAt: "2026-10-26T22:01:00.000Z" },
    { ref: "summer", role: "user", sequence: 3, text: "Summer time", createdAt: "2026-10-23T21:01:00.000Z" },
    { ref: "unknown", role: "user", sequence: 4, text: "No timestamp" },
  ] };
  expect(reportedTimeEvidence(transcript, context)).toMatchObject({ targetDateMessageRefs: ["after"],
    messageRefsByDate: { "2026-10-26": ["before"], "2026-10-27": ["after"], "2026-10-24": ["summer"] }, undatedMessageRefs: ["unknown"] });
});
