import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { PolicyError } from "./core/errors.js";

export type RecorderModel = Awaited<ReturnType<BbPluginApi["sdk"]["providers"]["models"]>>["models"][number];
export type RecorderCatalog = { providerId: string; models: RecorderModel[] };
export type ReviewExclusion = { providerId: string; model: string };
type Execution = { providerId: string; model: string };

// Context-window suffixes, dated snapshots and provider aliases do not make an
// independent model. Resolve catalog aliases before comparing across accounts.
export function modelIdentity(model: string): string {
  return model.toLowerCase().replace(/\[[^\]]+\]/g, "").replace(/-(?:\d{8}|\d{4}-\d{2}-\d{2}|latest)$/, "").replace(/^claude-/, "");
}

export function allowedRecorder(providerId: string, model: Pick<RecorderModel, "model" | "id" | "routeProviderId">, exclusions: ReviewExclusion[] = []): boolean {
  const names = [model.model, model.id].map(modelIdentity);
  // New catalog entries must not silently become fallbacks. In particular,
  // alphabetic ordering previously promoted Spark after a failed Sol run.
  const supported = /^(?:gpt-\d+(?:\.\d+)?-(?:sol|terra|astra)|(?:sonnet|opus|fable)(?:-\d+)*)$/;
  return supported.test(modelIdentity(model.model))
    && !names.some((name) => /(?:^|-)(?:luna|haiku|spark|mini|nano)(?:-|$)/.test(name))
    && !exclusions.some(rule => rule.providerId === providerId && names.includes(modelIdentity(rule.model)))
    && (!model.routeProviderId || model.routeProviderId === providerId);
}

function family(providerId: string, identity: string): string {
  if (/^claude(?:-|$)/.test(providerId) || /(?:^|-)(?:sonnet|opus|fable|haiku)(?:-|$)/.test(identity)) return "claude";
  if (providerId === "codex" || /^gpt-/.test(identity)) return "codex";
  return providerId;
}

export function recorderReasoning(model: RecorderModel): RecorderModel["defaultReasoningEffort"] {
  const supported = model.supportedReasoningEfforts.map((effort) => effort.reasoningEffort);
  return (["low", "medium", "none", "high", "xhigh", "max"] as const).find((effort) => supported.includes(effort)) ?? model.defaultReasoningEffort;
}

export function selectRecorder(catalogs: RecorderCatalog[], worker: Execution, failed?: Execution, exclusions: ReviewExclusion[] = []) {
  const resolve = (execution: Execution) => {
    const model = catalogs.find((catalog) => catalog.providerId === execution.providerId)?.models.find((m) => m.id === execution.model || m.model === execution.model);
    return modelIdentity(model?.model ?? execution.model);
  };
  const workerIdentity = resolve(worker);
  const workerFamily = family(worker.providerId, workerIdentity);
  const preferredModel = workerFamily === "claude" ? "sol" : "sonnet";
  const failedIdentity = failed && resolve(failed);
  const candidates = catalogs.flatMap(({ providerId, models }, providerIndex) => models
    .filter((model) => allowedRecorder(providerId, model, exclusions))
    .map((model) => {
      const identity = modelIdentity(model.model);
      const sameModel = identity === workerIdentity;
      const sameFamily = family(providerId, identity) === workerFamily;
      // Every Claude worker (including Opus and Fable) goes to Sol; every
      // Codex worker goes to Sonnet. Keep both ahead of fallback models even
      // when that means reusing the worker's family in a fresh conversation.
      const preference = identity.split("-").includes(preferredModel) ? 0 : /(?:^|-)(?:sol|sonnet)(?:-|$)/.test(identity) ? 1 : /(?:^|-)terra(?:-|$)/.test(identity) ? 2 : 3;
      const band = sameModel ? 2 : Number(sameFamily);
      const repeatFailure = failed?.providerId === providerId && failedIdentity === identity;
      return { providerId, model, sameModel, sameFamily, score: Number(repeatFailure) * 10000 + preference * 1000 + band * 100 + providerIndex };
    }));
  candidates.sort((a, b) => a.score - b.score || Number(b.model.isDefault) - Number(a.model.isDefault) || a.model.model.localeCompare(b.model.model, "en", { numeric: true }));
  const chosen = candidates[0];
  if (!chosen) throw new PolicyError("No review model is available. Check the Codex or personal Claude connection and retry finishing the session.");
  return {
    reviewerProvider: chosen.providerId,
    reviewerModel: chosen.model.model,
    reviewerReasoning: recorderReasoning(chosen.model),
    selectionReason: `Automatic review: ${chosen.model.displayName || chosen.model.model} (${chosen.providerId}). ${chosen.sameModel ? "No other suitable mid-tier model is available; using a fresh session with the same model." : chosen.sameFamily ? "Fallback: another model in the same family." : "A different model family was selected; Sonnet and Sol are preferred."}`,
  };
}
