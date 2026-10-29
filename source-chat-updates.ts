import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { syncCandidateSchema, type SyncCandidate } from "./contracts.js";
import type { Repository } from "./repository.js";
import type { SessionRuntime } from "./runtime.js";

type Delivery = NonNullable<SyncCandidate["chatDelivery"]>;

// The durable intent is committed with the approval. Never repeat an ambiguous
// send: BB may have accepted it even when the response or plugin process was lost.
export class SourceChatUpdates {
  private running: Promise<void> | undefined;
  constructor(readonly bb: BbPluginApi, readonly repo: Repository,
    readonly runtime: Pick<SessionRuntime, "openChat">,
    readonly defaults: () => { projectId: string; providerId: string; model: string }) {}

  flush() {
    if (this.running) return this.running;
    const operation = this.drain();
    this.running = operation;
    void operation.finally(() => { if (this.running === operation) this.running = undefined; }).catch(() => {});
    return operation;
  }

  private save(candidate: SyncCandidate, delivery: Delivery) {
    this.repo.db.prepare("UPDATE source_sync_candidates SET value_json=? WHERE id=? AND status='applied'")
      .run(JSON.stringify({ ...candidate, chatDelivery: delivery }), candidate.id);
    this.repo.changed();
  }

  private async confirmed(candidate: SyncCandidate, delivery: Delivery): Promise<"sent" | "queued" | null> {
    const threadId = delivery.threadId!;
    const marker = `[247C update ${candidate.id}]`;
    const queued = await this.bb.sdk.threads.queuedMessages.list({ threadId });
    if (queued.some(message => message.content.some(part => part.type === "text" && part.text.includes(marker)))) return "queued";
    const page = await this.bb.sdk.threads.timeline({ threadId, segmentLimit: "100", includeNestedRows: "false", summaryOnly: "false", deferContent: "false" });
    if (page.rows.some(row => row.kind === "conversation" && row.role === "user" && row.text?.includes(marker))) return "sent";
    return null;
  }

  private async drain() {
    const rows = this.repo.db.prepare(`SELECT value_json FROM source_sync_candidates WHERE status='applied'
      AND json_extract(value_json,'$.chatDelivery.state') IN ('pending','sending')
      ORDER BY json_extract(value_json,'$.resolvedAt'),id LIMIT 50`).all() as { value_json: string }[];
    for (const row of rows) {
      const candidate = syncCandidateSchema.parse(JSON.parse(row.value_json));
      let delivery = candidate.chatDelivery!;
      if (delivery.state === "sending") {
        let confirmed: "sent" | "queued" | null = null;
        try { confirmed = await this.confirmed(candidate, delivery); } catch { /* Keep ambiguous delivery visible. */ }
        this.save(candidate, { ...delivery, state: confirmed ?? "uncertain", error: confirmed ? null : "Delivery could not be confirmed. Check the chat before sending this update again." });
        continue;
      }
      try {
        const taskId = candidate.resultTaskId!;
        // Do not inject an update into a bounded recorder or interrupt review.
        const active = this.repo.active().find(session => session.taskId === taskId);
        if (active && (active.mode !== "conversation" || !["starting", "working"].includes(active.status))) continue;
        const session = await this.runtime.openChat({ taskId, requestId: delivery.requestId }, this.defaults());
        if (session.mode !== "conversation" || session.status !== "working" || !session.workerThreadId) continue;
        delivery = { ...delivery, state: "sending", threadId: session.workerThreadId };
        this.save(candidate, delivery);
        const result = await this.bb.sdk.threads.send({ threadId: session.workerThreadId, mode: "queue-if-active", input: [{ type: "text", text: delivery.message, mentions: [] }] });
        this.save(candidate, { ...delivery, state: result.delivery === "queued" ? "queued" : "sent", error: null });
      } catch (error) {
        if (delivery.state === "sending") {
          let confirmed: "sent" | "queued" | null = null;
          try { confirmed = await this.confirmed(candidate, delivery); } catch { /* No blind resend. */ }
          this.save(candidate, { ...delivery, state: confirmed ?? "uncertain", error: confirmed ? null : "Delivery could not be confirmed. Check the chat before sending this update again." });
        } else {
          this.save(candidate, { ...delivery, state: "failed", error: `The task update was accepted, but the chat could not be opened: ${error instanceof Error ? error.message : String(error)}` });
        }
      }
    }
  }
}
