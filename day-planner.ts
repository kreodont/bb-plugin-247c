import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { dayPlannerRunSchema, localDay, type DayPlannerState } from "./day-contracts.js";
import { PolicyError } from "./core/errors.js";

type PlannerSettings = { dayPlannerProjectId: string; dayPlannerAutomationId: string };
// Read only the fields needed by Day from the Automations plugin's public RPC.
const automationSchema = z.object({
  id: z.string(), projectId: z.string(), name: z.string(), enabled: z.boolean(),
  nextRunAt: z.number().nullable(),
});
const rawRunSchema = dayPlannerRunSchema.extend({ output: z.string().nullable().optional() });
const runsSchema = z.object({ runs: z.array(rawRunSchema) });
const noticeSchema = z.object({ kind: z.literal("247c-day-planner"), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  outcome: z.enum(["already-planned", "already-running"]) });
function displayRun(raw: z.infer<typeof rawRunSchema>) {
  const run = dayPlannerRunSchema.parse(raw);
  // Only a typed planner outcome becomes UI text. Never expose raw script output.
  if (raw.output && raw.status === "succeeded") {
    try {
      const notice = noticeSchema.parse(JSON.parse(raw.output.trim()));
      run.message = notice.outcome === "already-planned"
        ? `The plan for ${notice.date} already exists. No duplicate tasks were added.`
        : "Day planning is already running. Wait for it to finish.";
    } catch { /* Older scripts report ordinary completion text. */ }
  }
  if (run.status === "skipped" && run.skipReason === "wakeAgent false") {
    run.message = "No new plan was created during this run. See the saved day plan below.";
  }
  return run;
}

export class DayPlanner {
  constructor(private bb: BbPluginApi, private settings: () => Promise<PlannerSettings>, private today: () => string = () => localDay()) {}

  private async target() {
    const settings = await this.settings();
    const projectId = settings.dayPlannerProjectId.trim(), automationId = settings.dayPlannerAutomationId.trim();
    return projectId && automationId ? { projectId, automationId } : null;
  }

  async state(): Promise<DayPlannerState> {
    const input = await this.target();
    if (!input) return { configured: false, today: this.today(), name: null, scheduled: false, nextRunAt: null, run: null };
    const [automation, history] = await Promise.all([
      this.bb.sdk.plugins.callRpc({ pluginId: "automations", method: "automations_get", input, outputSchema: automationSchema }),
      this.bb.sdk.plugins.callRpc({ pluginId: "automations", method: "automations_runs", input: { ...input, limit: 20 }, outputSchema: runsSchema }),
    ]);
    if (automation.id !== input.automationId || automation.projectId !== input.projectId) throw new PolicyError("The configured day planner could not be found.");
    return {
      configured: true, today: this.today(), name: automation.name, scheduled: automation.enabled,
      nextRunAt: automation.nextRunAt,
      run: (() => { const latest = history.runs.find(run => run.status === "running") ?? history.runs[0]; return latest ? displayRun(latest) : null; })(),
    };
  }

  async start({ date, requestId }: { date: string; requestId: string }) {
    if (date !== this.today()) throw new PolicyError("Open Today to create a day plan.");
    const target = await this.target();
    if (!target) throw new PolicyError("Configure the day planner project and automation in 247C settings.");
    const { run } = await this.bb.sdk.plugins.callRpc({
      pluginId: "automations", method: "automations_run",
      input: { ...target, idempotencyKey: `247c-day:${date}:${requestId}` },
      outputSchema: z.object({ run: rawRunSchema }),
    });
    return displayRun(run);
  }
}
