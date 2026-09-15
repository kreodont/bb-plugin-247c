import { createHash, randomUUID } from "node:crypto";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "./server.js";
import { Repository } from "./repository.js";
import { dossierSchema, sessionSchema, taskSchema, type Session } from "./contracts.js";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
export type TimelineRow = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["timeline"]>>["rows"][number];

export async function fixture(options: { deferEnvironment?: boolean; settings?: Record<string, string | number | boolean | null> } = {}) {
  const threads = new Map<string, ReturnType<typeof makeThreadResponse>>();
  const outputs = new Map<string, string>();
  const models = new Map<string, string>();
  const files = new Map<string, string>();
  const conversations = new Map<string, TimelineRow[]>();
  function message(threadId: string, role: "user" | "assistant", text: string): TimelineRow {
    const rows = conversations.get(threadId) ?? [];
    const seq = rows.length + 1;
    const row = { id: `row_${seq}`, createdAt: Date.now(), sourceSeqStart: seq, sourceSeqEnd: seq, startedAt: Date.now(), threadId, turnId: null, kind: "conversation" as const, role, text, attachments: null,
      ...(role === "user" ? { initiator: "user" as const, mentions: [], senderThreadId: null, systemMessageKind: "unlabeled" as const, systemMessageSubject: null, turnRequest: { isGrouped: false, kind: "message" as const, status: "accepted" as const } } : { turnRequest: null }) } as TimelineRow;
    conversations.set(threadId, [...rows, row]);
    return row;
  }
  let n = 0;
  const host = createFakePluginHost({ pluginId: "247c", settings: { calendarMeetings: false, excludedReviewModels: JSON.stringify([{ providerId: "claude-work", model: "claude-fable-5-1" }]), ...options.settings }, sdk: {
    providers: {
      list: () => [{ id: "codex", available: true }, { id: "claude-code", available: true }, { id: "claude-work", available: true }],
      models: ({ providerId } = {}) => ({ modelLoadError: null, models: (providerId === "codex" ? ["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.3-codex-spark"] : ["claude-opus-5[1m]", "claude-fable-5-1", "claude-sonnet-5", "claude-haiku-4-5-20251001"]).map((model) => ({ id: model, model, displayName: model, defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "medium" }] })) }),
    },
    projects: { list: () => [{ id: "proj_personal", kind: "personal" }] },
    environments: { get: ({ environmentId }) => ({ id: environmentId, path: "/work", hostId: "host_test", managed: false, isWorktree: false }) },
    files: { read: ({ path, rootPath }) => {
      if (rootPath !== "/work") throw new Error("File access must be confined to the work root");
      const content = files.get(path);
      if (content === undefined) throw new Error(`File missing: ${path}`);
      return { content, contentEncoding: "utf8", sha256: createHash("sha256").update(content).digest("hex"), sizeBytes: Buffer.byteLength(content) };
    } },
    threads: {
      spawn: async (args) => {
        const thread = makeThreadResponse({ id: `thread_${++n}`, title: args.title ?? null, providerId: args.providerId ?? "codex", originPluginId: "247c", status: "active", environmentId: options.deferEnvironment && n === 1 ? null : "env_test", visibility: args.visibility ?? "visible" });
        threads.set(thread.id, thread);
        models.set(thread.id, args.model ?? "gpt-5.6-sol");
        const visible = args.input?.filter((i) => i.type === "text" && i.visibility !== "agent-only").map((i) => i.type === "text" ? i.text : "").join("\n") ?? args.prompt;
        if (visible) message(thread.id, "user", visible);
        await currentHost.harness.behavior.emitThreadEvent("thread.created", { thread });
        return thread;
      },
      list: () => [...threads.values()],
      get: ({ threadId }) => { const row = threads.get(threadId); if (!row) throw new Error("Missing thread"); return row; },
      update: ({ threadId, title }) => {
        const row = threads.get(threadId); if (!row) throw new Error("Missing thread");
        const updated = { ...row, ...(title !== undefined ? { title } : {}) };
        threads.set(threadId, updated);
        return updated;
      },
      defaultExecutionOptions: ({ threadId }) => ({ model: models.get(threadId) }),
      output: ({ threadId }) => ({ output: outputs.get(threadId) ?? null }),
      stop: ({ threadId }) => { const thread = threads.get(threadId); if (thread && thread.status !== "error") threads.set(threadId, { ...thread, status: "idle" }); return { ok: true }; },
      archive: ({ threadId }) => { const thread = threads.get(threadId); if (thread) threads.set(threadId, { ...thread, archivedAt: Date.now() }); return {}; },
      send: ({ threadId }) => { const thread = threads.get(threadId)!; threads.set(threadId, { ...thread, status: "active" }); return {}; },
      interactions: { list: () => [] },
      events: { list: ({ threadId, afterSeq, limit }) => (conversations.get(threadId) ?? [])
        .filter((r) => r.kind === "work" && r.workKind === "tool" && r.sourceSeqEnd > Number(afterSeq ?? 0))
        .slice(0, Number(limit ?? 20)).map((r) => {
          if (r.kind !== "work" || r.workKind !== "tool") throw new Error("Expected tool row");
          return { id: r.id, threadId, seq: r.sourceSeqEnd, createdAt: r.createdAt, scope: { kind: "thread" as const }, type: "item/completed" as const,
            data: { item: { type: "toolCall" as const, id: r.callId, tool: r.toolName, arguments: r.toolArgs ?? {}, result: r.output,
              status: r.status === "error" ? "failed" as const : r.status,
              ...(r.outputPreview ? { truncation: { result: { originalLength: r.outputPreview.totalChars, retainedHeadLength: r.output.length, retainedTailLength: 0, truncatedAt: Date.now() } } } : {}) } } };
        }) },
      timeline: ({ threadId }) => ({ rows: conversations.get(threadId) ?? [], maxSeq: conversations.get(threadId)?.length ?? 0, timelinePage: { hasOlderRows: false, olderCursor: null, kind: "latest", returnedSegmentCount: 1, segmentLimit: 100 } }),
    },
  } });
  let currentHost = host;
  await plugin(host.bb);
  let repo = new Repository(host.bb.storage.database(), () => {});
  async function reload() {
    currentHost = await currentHost.harness.lifecycle.reload(plugin);
    repo = new Repository(currentHost.bb.storage.database(), () => {});
  }
  async function create(description = "Нужен короткий план из трёх этапов.") {
    return taskSchema.parse(await currentHost.harness.behavior.callRpc("create", { title: "Подготовить план", description, requestId: randomUUID() }));
  }
  function startInput(taskId: string, revision: number) {
    return { taskId, revision, requestId: randomUUID(), criteria: ["План содержит три этапа."], request: {
      projectId: "proj_personal", providerId: "codex", model: "gpt-5.6-sol", reasoningLevel: "medium", permissionMode: "accept-edits",
      executionInputSources: { providerId: "explicit", model: "explicit", reasoningLevel: "explicit", permissionMode: "explicit" }, environment: { type: "host", hostId: "host_test", workspace: { type: "personal" } },
      input: [{ type: "text", text: "Подготовь короткий план из трёх этапов.", mentions: [] }],
    } };
  }
  async function start(taskId: string, revision: number) {
    return sessionSchema.parse(await currentHost.harness.behavior.callRpc("start", startInput(taskId, revision)));
  }
  async function idle(threadId: string, output: unknown) {
    outputs.set(threadId, typeof output === "string" ? output : JSON.stringify(output));
    message(threadId, "assistant", outputs.get(threadId)!);
    const thread = { ...threads.get(threadId)!, status: "idle" as const };
    threads.set(threadId, thread);
    const result = await currentHost.harness.behavior.emitThreadEvent("thread.idle", { thread, lastAssistantText: outputs.get(threadId)! });
    if (result.errors.length) throw result.errors[0];
  }
  function pass(session: Session) {
    return { verdict: "pass", findings: [], criteria: session.criteria.map((_, index) => ({ index, passed: true, reason: "В ответе есть все три этапа.", evidenceRefs: [session.artifacts.length ? "artifact:0" : "answer"] })) };
  }
  async function detail(taskId: string) { return dossierSchema.parse(await currentHost.harness.behavior.callRpc("detail", { id: taskId })); }
  return { get bb() { return currentHost.bb; }, get harness() { return currentHost.harness; }, get repo() { return repo; }, reload, threads, models, outputs, files, conversations, message, create, startInput, start, idle, pass, detail };
}
