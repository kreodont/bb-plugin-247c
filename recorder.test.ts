import { describe, expect, it } from "vitest";
import { allowedRecorder, selectRecorder, type RecorderCatalog, type RecorderModel } from "./recorder.js";

function catalog(providerId: string, names: string[]): RecorderCatalog {
  return { providerId, models: names.map((model): RecorderModel => ({ id: model, model, displayName: model, description: "", isDefault: false, defaultReasoningEffort: "high", supportedReasoningEfforts: [{ reasoningEffort: "low", description: "" }, { reasoningEffort: "high", description: "" }] })) };
}

describe("Automatic recorder selection", () => {
  const catalogs = [catalog("claude-code", ["claude-fable-5-1", "claude-opus-5[1m]", "claude-sonnet-5", "claude-haiku-4-5-20251001"]), catalog("codex", ["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.3-codex-spark"])];

  it.each(["claude-code", "claude-work"].flatMap((providerId) => ["claude-sonnet-5", "claude-opus-5[1m]", "claude-fable-5-1"].map((model) => ({ providerId, model }))))("chooses Sol after $providerId / $model", (worker) => {
    expect(selectRecorder(catalogs, worker)).toMatchObject({ reviewerProvider: "codex", reviewerModel: "gpt-5.6-sol", reviewerReasoning: "low" });
  });

  it.each(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-6-astra"])("chooses personal Sonnet after Codex %s", (model) => {
    expect(selectRecorder(catalogs, { providerId: "codex", model })).toMatchObject({ reviewerProvider: "claude-code", reviewerModel: "claude-sonnet-5", reviewerReasoning: "low" });
  });

  it("treats two Claude accounts, aliases and context suffixes as the same model", () => {
    const personal = catalog("claude-code", ["claude-sonnet-5-20260909"]);
    const corp = catalog("claude-work", ["claude-sonnet-5[1m]"]);
    corp.models[0].id = "sonnet";
    expect(selectRecorder([personal, corp], { providerId: "claude-work", model: "sonnet" }).selectionReason).toContain("новая сессия той же модели");
    expect(selectRecorder([personal, corp, catalogs[1]], { providerId: "claude-work", model: "sonnet" })).toMatchObject({ reviewerProvider: "codex", reviewerModel: "gpt-5.6-sol", reviewerReasoning: "low" });
  });

  it("tries Sonnet after failed Sol and Sol after failed Sonnet before other models", () => {
    expect(selectRecorder(catalogs, { providerId: "claude-code", model: "claude-fable-5-1" }, { providerId: "codex", model: "gpt-5.6-sol" }).reviewerModel).toBe("claude-sonnet-5");
    expect(selectRecorder(catalogs, { providerId: "codex", model: "gpt-6-astra" }, { providerId: "claude-code", model: "claude-sonnet-5" }).reviewerModel).toBe("gpt-5.6-sol");
    expect(() => selectRecorder([catalog("codex", ["gpt-5.6-luna"]), catalog("claude-code", ["claude-haiku-4-5-20251001"])], { providerId: "codex", model: "gpt-5.6-sol" })).toThrow(/Нет доступной модели/);
    const alias = catalog("codex", ["gpt-5.6-luna"]);
    alias.models[0].id = "default";
    expect(() => selectRecorder([alias], { providerId: "claude-code", model: "claude-sonnet-5" })).toThrow(/Нет доступной модели/);
  });

  it.each(["gpt-5.3-codex-spark", "gpt-5.6-luna", "claude-haiku-4-5-20251001", "gpt-5.6-mini", "gpt-5.6-future", "gpt-5.6-sol-preview"])("excludes %s, including aliases, instead of silently admitting catalog additions", (model) => {
    const item = catalog("codex", [model]).models[0];
    expect(allowedRecorder("codex", item)).toBe(false);
    expect(allowedRecorder("codex", { ...item, id: "gpt-5.6-sol" })).toBe(false);
    if (/spark|luna|haiku|mini/.test(model)) expect(allowedRecorder("codex", { ...item, model: "gpt-5.6-sol" })).toBe(false);
    expect(() => selectRecorder([{ providerId: "codex", models: [item] }], { providerId: "claude-code", model: "claude-sonnet-5" })).toThrow(/Нет доступной модели/);
  });

  it("uses Terra only when the primary pair cannot provide a fresh alternative", () => {
    expect(selectRecorder([catalogs[1]], { providerId: "claude-work", model: "claude-opus-5[1m]" }, { providerId: "codex", model: "gpt-5.6-sol" }).reviewerModel).toBe("gpt-5.6-terra");
  });

  it("reuses a balanced model before spending flagship capacity just to change families", () => {
    const chosen = selectRecorder([catalog("claude-code", ["claude-sonnet-5"]), catalog("codex", ["gpt-6-astra", "gpt-5.6-luna"])], { providerId: "claude-code", model: "claude-sonnet-5" });
    expect(chosen.reviewerModel).toBe("claude-sonnet-5");
    expect(chosen.selectionReason).toContain("новая сессия той же модели");
  });

  it("excludes corporate Fable even when it is advertised as the default model", () => {
    const corp = catalog("claude-work", ["claude-fable-5-1"]);
    corp.models[0].isDefault = true;
    expect(() => selectRecorder([corp], { providerId: "claude-work", model: "claude-sonnet-5" })).toThrow(/Нет доступной модели/);
  });

  it("uses a flagship only when no allowed balanced model is available", () => {
    expect(selectRecorder([catalog("claude-code", ["claude-fable-5-1"])], { providerId: "codex", model: "gpt-5.6-sol" }).reviewerModel).toBe("claude-fable-5-1");
  });
});
