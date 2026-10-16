import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SaveController } from "./save-controller.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function setup() {
  let content = "original";
  const write = vi.fn(async (_content: string, _sha: string | null) => ({ outcome: "written" as const, sha256: "next" }));
  const onState = vi.fn();
  const controller = new SaveController({ initialSha256: "original-hash", readContent: () => content, write, onState });
  return { controller, write, onState, edit: (value: string) => { content = value; controller.changed(); } };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it("allows disabling auto-save and saving manually with the loaded hash", async () => {
  const s = setup();
  s.controller.setAutoSave(false);
  s.edit("manual");
  await vi.advanceTimersByTimeAsync(5000);
  expect(s.write).not.toHaveBeenCalled();
  await s.controller.save();
  expect(s.write).toHaveBeenCalledWith("manual", "original-hash");
  expect(s.onState).toHaveBeenLastCalledWith({ kind: "clean" });
});

it("debounces edits and cancels the queued write when switched off", async () => {
  const s = setup();
  s.controller.setAutoSave(true);
  s.edit("first");
  await vi.advanceTimersByTimeAsync(900);
  s.edit("second");
  await vi.advanceTimersByTimeAsync(900);
  expect(s.write).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(100);
  expect(s.write).toHaveBeenCalledExactlyOnceWith("second", "original-hash");
  s.edit("third");
  s.controller.setAutoSave(false);
  await vi.advanceTimersByTimeAsync(5000);
  expect(s.write).toHaveBeenCalledTimes(1);
});

it("serializes saves and preserves edits typed during a write", async () => {
  const s = setup();
  const pending = deferred<{ outcome: "written"; sha256: string }>();
  s.write.mockImplementationOnce(() => pending.promise);
  s.controller.setAutoSave(true);
  s.edit("first");
  await vi.advanceTimersByTimeAsync(1000);
  s.edit("second");
  await s.controller.save();
  await vi.advanceTimersByTimeAsync(5000);
  expect(s.write).toHaveBeenCalledTimes(1);
  pending.resolve({ outcome: "written", sha256: "first-hash" });
  await vi.advanceTimersByTimeAsync(0);
  expect(s.onState).toHaveBeenLastCalledWith({ kind: "dirty" });
  await vi.advanceTimersByTimeAsync(1000);
  expect(s.write).toHaveBeenLastCalledWith("second", "first-hash");
  expect(s.onState).toHaveBeenLastCalledWith({ kind: "clean" });
});

it("keeps newer edits dirty with auto-save off", async () => {
  const s = setup();
  s.controller.setAutoSave(false);
  const pending = deferred<{ outcome: "written"; sha256: string }>();
  s.write.mockImplementationOnce(() => pending.promise);
  s.edit("first");
  const saving = s.controller.save();
  s.edit("second");
  pending.resolve({ outcome: "written", sha256: "first-hash" });
  await saving;
  await vi.advanceTimersByTimeAsync(5000);
  expect(s.write).toHaveBeenCalledTimes(1);
  expect(s.onState).toHaveBeenLastCalledWith({ kind: "dirty" });
});

it("stops auto-save on a conflict until explicit overwrite", async () => {
  let content = "mine";
  const write = vi.fn<(content: string, sha: string | null) => Promise<{ outcome: "conflict"; currentSha256: string } | { outcome: "written"; sha256: string }>>()
    .mockResolvedValueOnce({ outcome: "conflict", currentSha256: "external" })
    .mockResolvedValue({ outcome: "written", sha256: "overwritten" });
  const onState = vi.fn();
  const controller = new SaveController({ initialSha256: "original", readContent: () => content, write, onState });
  controller.setAutoSave(true);
  controller.changed();
  await vi.advanceTimersByTimeAsync(1000);
  content = "mine updated";
  controller.changed();
  await controller.save();
  await vi.advanceTimersByTimeAsync(5000);
  expect(write).toHaveBeenCalledTimes(1);
  expect(onState).toHaveBeenLastCalledWith({ kind: "conflict" });
  await controller.save(true);
  expect(write).toHaveBeenLastCalledWith("mine updated", null);
  expect(onState).toHaveBeenLastCalledWith({ kind: "clean" });
});

it("does not retry failed writes automatically or expose exception contents", async () => {
  const s = setup();
  s.write.mockRejectedValueOnce(new Error("sensitive payload"));
  s.controller.setAutoSave(true);
  s.edit("first");
  await vi.advanceTimersByTimeAsync(1000);
  s.edit("second");
  await vi.advanceTimersByTimeAsync(5000);
  expect(s.write).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(s.onState.mock.calls)).not.toContain("sensitive payload");
  await s.controller.save();
  expect(s.write).toHaveBeenLastCalledWith("second", "original-hash");
  expect(s.onState).toHaveBeenLastCalledWith({ kind: "clean" });
});

it("cancels auto-save while confirming reload and uses the reloaded version", async () => {
  const s = setup();
  s.controller.setAutoSave(true);
  s.edit("first");
  s.controller.setPaused(true);
  await s.controller.save();
  await vi.advanceTimersByTimeAsync(5000);
  expect(s.write).not.toHaveBeenCalled();
  s.controller.acceptDisk("disk-hash");
  s.controller.setPaused(false);
  await vi.advanceTimersByTimeAsync(5000);
  expect(s.write).not.toHaveBeenCalled();
  s.edit("after reload");
  await vi.advanceTimersByTimeAsync(1000);
  expect(s.write).toHaveBeenCalledWith("after reload", "disk-hash");
});

it("cancels pending auto-save when an editor is disposed", async () => {
  const s = setup();
  s.controller.setAutoSave(true);
  s.edit("first");
  s.controller.dispose();
  await vi.advanceTimersByTimeAsync(5000);
  expect(s.write).not.toHaveBeenCalled();
});

it("ignores an in-flight result after disposal without reading the disposed editor", async () => {
  const s = setup();
  const pending = deferred<{ outcome: "written"; sha256: string }>();
  s.write.mockImplementationOnce(() => pending.promise);
  s.controller.setAutoSave(true);
  s.edit("first");
  const saving = s.controller.save();
  s.edit("second");
  s.controller.dispose();
  s.onState.mockClear();
  pending.resolve({ outcome: "written", sha256: "first-hash" });
  await saving;
  await vi.advanceTimersByTimeAsync(5000);
  expect(s.onState).not.toHaveBeenCalled();
  expect(s.write).toHaveBeenCalledTimes(1);
});


it("auto-saves edits by default but never writes an untouched file", async () => {
  const s = setup();
  await vi.advanceTimersByTimeAsync(2000);
  expect(s.write).not.toHaveBeenCalled();
  s.edit("default auto-save");
  await vi.advanceTimersByTimeAsync(999);
  expect(s.write).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(s.write).toHaveBeenCalledExactlyOnceWith("default auto-save", "original-hash");
  expect(s.onState).toHaveBeenLastCalledWith({ kind: "clean" });
});
