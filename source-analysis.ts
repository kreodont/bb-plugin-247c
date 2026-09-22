import { z } from "zod";
import { digest } from "./repository.js";
import type { SourceExport } from "./source-collector.js";
import { sourceLinks } from "./source-collector.js";
import { pullRequestReferences } from "./source-links.js";
import type { TaskDossier } from "./core/types.js";

// Bump the version when analysis policy changes enough to require a fresh pass.
export const sourceAnalysisSchema = z.object({
  version: z.literal(1), contextKey: z.string(),
  doneFollowUpPolicy: z.literal(1).optional(),
  documents: z.record(z.string(), z.string()), selectedRefs: z.array(z.string()),
  tasks: z.record(z.string(), z.object({ key: z.string(), anchors: z.array(z.string()) })),
  dayWork: z.record(z.string(), z.string()), dayComplete: z.boolean(),
  reviewItemIds: z.array(z.string()),
  reason: z.enum(["manual", "baseline", "context", "changes"]),
}).strict();
export type SourceAnalysis = z.infer<typeof sourceAnalysisSchema>;
export type AnalysisWork = { dayWork: Record<string, string>; dayComplete: boolean; policy: string };

function stamp(document: SourceExport["documents"][number]) {
  // Ref identifies this run's receipt, not the underlying thread/issue.
  const args = { ...document.args };
  // Slack bounds each read by this run's end. A moving upper bound is not a
  // different thread; replies and edits are still detected by the content hash.
  if (document.source === "slack" && /(?:^|\.)slack_read_thread$/.test(document.tool)) delete args.latest;
  return { key: digest({ source: document.source, tool: document.tool, args }), value: digest(document.content) };
}

export function rekeyAnalysisDocuments(plan: SourceAnalysis, bundle: SourceExport): SourceAnalysis {
  const documents = { ...plan.documents };
  for (const doc of bundle.documents) {
    const oldKey = digest({ source: doc.source, tool: doc.tool, args: doc.args }), current = stamp(doc);
    // Only migrate content already represented by this completed analysis.
    // Reuse its saved receipts without manufacturing a new analyzed baseline.
    if (oldKey !== current.key && documents[oldKey] === current.value) {
      delete documents[oldKey]; documents[current.key] = current.value;
    }
  }
  return { ...plan, documents };
}

export function planSourceAnalysis(bundle: SourceExport, contextKey: string, work: AnalysisWork, incremental: boolean, baseline?: SourceAnalysis, dossiers: TaskDossier[] = []): SourceAnalysis {
  let reason: SourceAnalysis["reason"] = !incremental ? "manual" : !baseline ? "baseline" : baseline.contextKey !== contextKey ? "context" : "changes";
  const tasks = Object.fromEntries(dossiers.map(dossier => {
    const text = JSON.stringify(dossier), links = sourceLinks(text);
    const anchors = [...links.gmail, ...links.jira, ...links.slack.flatMap(link => [link.ts, link.ts.replace(".", "")]), ...pullRequestReferences(text)];
    return [dossier.task.id, { key: digest(dossier), anchors }];
  }));
  const changedAnchors: string[] = [];
  // Revisit only completed-task sources once when adopting the follow-up rule.
  // Unrelated unchanged documents keep their existing incremental baseline.
  if (reason === "changes" && baseline?.doneFollowUpPolicy !== 1) {
    changedAnchors.push(...dossiers.filter(d => d.task.status === "done").flatMap(d => tasks[d.task.id].anchors).map(anchor => anchor.toLocaleLowerCase()));
  }
  if (reason === "changes") for (const id of new Set([...Object.keys(tasks), ...Object.keys(baseline!.tasks)])) {
    if (tasks[id]?.key === baseline!.tasks[id]?.key) continue;
    const anchors = [...(tasks[id]?.anchors ?? []), ...(baseline!.tasks[id]?.anchors ?? [])];
    // Revisit only this task's linked context. Without a stable link/key, a
    // full pass is safer than guessing a topic match and missing its sources.
    if (!anchors.length) reason = "context";
    changedAnchors.push(...anchors.map(anchor => anchor.toLocaleLowerCase()));
  }
  const documents: Record<string, string> = {}, selectedRefs: string[] = [];
  for (const doc of bundle.documents) {
    const { key, value } = stamp(doc); documents[key] = value;
    const text = JSON.stringify([doc.args, doc.content]).toLocaleLowerCase();
    if (reason !== "changes" || baseline?.documents[key] !== value || changedAnchors.some(anchor => text.includes(anchor))) selectedRefs.push(doc.ref);
  }
  const reviewItemIds = Object.keys(work.dayWork).filter(id => reason === "manual" || !baseline || contextKey !== baseline.contextKey || !work.dayComplete || !baseline.dayComplete || baseline.dayWork[id] !== work.dayWork[id]);
  return { version: 1, doneFollowUpPolicy: 1, contextKey, tasks, documents, selectedRefs, dayWork: work.dayWork, dayComplete: work.dayComplete, reviewItemIds, reason };
}

export function needsDayAnalysis(plan: SourceAnalysis, baseline?: SourceAnalysis) {
  if (!plan.dayComplete) return true; // Failed measurement must not hide work.
  return plan.reviewItemIds.length > 0;
}

export function analysisExport(bundle: SourceExport, plan?: SourceAnalysis): SourceExport {
  if (!plan) return bundle; // Runs created before incremental analysis.
  const refs = new Set(plan.selectedRefs);
  return { ...bundle, documents: bundle.documents.filter(doc => refs.has(doc.ref)) };
}
