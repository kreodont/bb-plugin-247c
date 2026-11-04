import { expect, it } from "vitest";
import { validateExtraction } from "./conversation.js";
import { FINISH_PENDING_REF } from "./finish-mode.js";
import type { Transcript } from "./contracts.js";
const transcript: Transcript = { threadId: "thread_test", capturedAt: new Date().toISOString(), messages: [], warnings: [] };
const draft = { rationale: "The task is pending.", facts: [], knowledge: [], reportedTime: null, changes: { status: { value: "waiting", evidenceRefs: [FINISH_PENDING_REF] } } };
it("limits the host finish decision to pending status in resolve mode", () => {
  expect(validateExtraction(draft, transcript, undefined, "open", "resolve").changes?.status?.value).toBe("waiting");
  expect(() => validateExtraction(draft, transcript, undefined, "open")).toThrow(/supports only pending/);
  for (const status of ["done", "archived"] as const) expect(() => validateExtraction(draft, transcript, undefined, status, "resolve")).toThrow(/supports only pending/);
  expect(() => validateExtraction({ ...draft, changes: { status: { value: "done", evidenceRefs: [FINISH_PENDING_REF] } } }, transcript, undefined, "open", "resolve")).toThrow(/supports only pending/);
  expect(() => validateExtraction({ ...draft, changes: { ...draft.changes, nextStep: { value: null, evidenceRefs: [FINISH_PENDING_REF] } } }, transcript, undefined, "open", "resolve")).toThrow(/supports only pending/);
});
it("does not allow an open or archived outcome for Finish and removes status from Pause", () => {
  for (const value of ["open", "archived"]) expect(() => validateExtraction({ ...draft, changes: { status: { value, evidenceRefs: [FINISH_PENDING_REF] } } }, transcript, undefined, "open", "resolve")).toThrow(/choose changes.status/);
  expect(validateExtraction(draft, transcript, undefined, "open", "pause").changes).toBeNull();
  expect(validateExtraction({ ...draft, changes: { status: "I cannot choose a status" } }, transcript, undefined, "open", "pause").changes).toBeNull();
});
