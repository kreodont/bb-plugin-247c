import { sessionFinishMode } from "./finish-mode.js";
import { isLiveTask } from "./task-status.js";
import { randomUUID } from "node:crypto";
import { workspacePaths, resolveWorkspaceArtifact, workspaceFileUrl } from "./workspace-path.js";
import { setTimeout as delay } from "node:timers/promises";
import { ZodError } from "zod";
import type { BbPluginApi, MessageDispatchHookContext } from "@get-bb/plugin-sdk";
import { nativeRequest, requestSchema, resultSchema, reviewSchema, type Extraction, type ObservedArtifact, type Review, type Session, type SettingsView, type StartInput, type WorkerResult, type PartDecision } from "./contracts.js";
import { ACTIVE, Repository, digest } from "./repository.js";
import { PolicyError } from "./core/errors.js";
import type { ProposalEvidence, StewardChanges, TaskRecord } from "./core/types.js";
import { workerInstructions, reviewInstructions, repairInstructions, extractionInstructions } from "./prompts.js";
import { continueTranscript, extractionProposal, readConversation, withTranscriptDates, validateExtraction } from "./conversation.js";
import { parseExcludedReviewModels } from "./settings.js";
import { allowedRecorder, selectRecorder } from "./recorder.js";
import { readSavedRecorder } from "./recorder-recovery.js";
import { ThreadRouting } from "./thread-routing.js";
import { acceptedWorkerContext, sameWorkerContext } from "./worker-context.js";

const FAILED = new Set(["error", "failed", "archived", "deleted"]);
const forbiddenPath = new Set([".git", ".bb", ".codex", ".claude", ".agents", ".ssh", ".env", ".npmrc", "node_modules", ".247c"]);

// BB requires a first input to create a pending thread. Hold this exact bootstrap
// in message.dispatch and remove its queued row before exposing the empty chat.
export function emptyChatBootstrap(id: string) {
  return `247C empty-chat bootstrap ${id}. No work is requested. Wait for the user's first message.`;
}

export function parseJsonResult(text: string | null, maximumLength = 50000): unknown {
  if (!text || text.length > maximumLength) throw new PolicyError("The agent did not return a result in the required format.");
  const clean = text.trim().replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
  try { return JSON.parse(clean); } catch { throw new PolicyError("The agent did not return result JSON. Its response is preserved in the chat."); }
}

export function validateReview(value: unknown, session: Session): Review {
  const review = reviewSchema.parse(value);
  if (review.criteria.length !== session.criteria.length || new Set(review.criteria.map((c) => c.index)).size !== session.criteria.length || review.criteria.some((c) => c.index >= session.criteria.length)) {
    throw new PolicyError("The reviewer skipped or duplicated an acceptance criterion.");
  }
  const refs = new Set(["answer", ...session.artifacts.map((a) => a.ref)]);
  if (review.criteria.some((c) => c.evidenceRefs.some((r) => !refs.has(r)) || (c.passed && c.evidenceRefs.length === 0))) throw new PolicyError("The reviewer referenced missing evidence.");
  if (review.verdict === "pass" && (review.findings.length > 0 || review.criteria.some((c) => !c.passed))) throw new PolicyError("The verdict contradicts the verification results.");
  if (review.verdict !== "pass" && review.findings.length === 0) throw new PolicyError("The reviewer did not explain what prevents acceptance.");
  return review;
}

export class SessionRuntime {
  private readonly processing = new Set<string>();
  private readonly archiving = new Set<string>();
  private readonly unavailableMonitors = new Set<string>();
  private disposed = false;
  private readonly openingChats = new Map<string, Promise<Session>>();
  private readonly refreshingWorkers = new Map<string, Promise<void>>();
  private readonly refreshRetryAt = new Map<string, number>();
  private readonly pendingWorkerReads = new Map<string, { snapshot: string; nextCursor: string }>();
  constructor(readonly bb: BbPluginApi, readonly repo: Repository, readonly settings: () => Promise<SettingsView>, readonly threadRouting = new ThreadRouting(bb, async () => "")) {}

  private requiresOpenTask(session: Session) {
    return !session.continuedFrom && !(session.mode === "conversation" && (session.closedTaskConversation || session.finishMode === "source"));
  }

  private current(id: string): Session {
    const session = this.repo.session(id);
    if (this.disposed || !ACTIVE.has(session.status)) throw new PolicyError("The session has already stopped.");
    if (session.mode === "conversation" && ["starting", "working", "collecting"].includes(session.status) && !(session.status === "collecting" && session.extractionRepair)) {
      if (this.requiresOpenTask(session) && !isLiveTask(this.repo.kernel.getTask(session.taskId).status)) throw new PolicyError("The task is already closed.");
    } else this.repo.assertCurrent(session.taskId, session.baseRevision, this.requiresOpenTask(session));
    return session;
  }

  async created(thread: { id: string; title: string | null; originPluginId: string | null; environmentId: string | null }) {
    if (thread.originPluginId !== this.bb.pluginId || !thread.title) return;
    const match = /^247C · (worker|verification \d+|review \d+|исполнитель|проверка \d+|разбор \d+) · ([a-f0-9-]{36})$/.exec(thread.title);
    if (!match) return;
    let session: Session;
    try { session = this.repo.session(match[2]); } catch { return; }
    const reviewer = !["worker", "исполнитель"].includes(match[1]);
    if (reviewer && Number(match[1].split(" ")[1]) !== session.round) return;
    session = this.repo.saveSession({ ...session, ...(reviewer ? { reviewerThreadId: thread.id } : { workerThreadId: thread.id, environmentId: thread.environmentId }) });
    if (!ACTIVE.has(session.status)) await this.stopThread(thread.id, reviewer);
  }

  openChat(input: { taskId: string; requestId: string }, defaults: { projectId: string; providerId: string; model: string }): Promise<Session> {
    const existing = this.repo.db.prepare("SELECT id FROM sessions WHERE id=?").get(input.requestId);
    if (existing) {
      const session = this.repo.session(input.requestId);
      const saved = this.repo.sessionRequest(input.requestId) as { emptyChat?: boolean };
      if (session.taskId !== input.taskId || !saved.emptyChat) return Promise.reject(new PolicyError("The chat request key belongs to a different session."));
      return this.openingChats.get(input.taskId) ?? this.readyChat(session);
    }
    const pending = this.openingChats.get(input.taskId);
    if (pending) return pending;
    const active = this.repo.active().find(s => s.taskId === input.taskId);
    if (active) return this.readyChat(active);
    const create = async () => {
      const task = this.repo.kernel.getTask(input.taskId);
      this.repo.assertCurrent(task.id, task.revision, false);
      const projectId = defaults.projectId || (await this.bb.sdk.projects.list({ includePersonal: true })).find(p => p.kind === "personal")?.id;
      if (!projectId) throw new PolicyError("No BB project is available for the chat.");
      const remembered = defaults.providerId && defaults.model ? null : await this.bb.sdk.projects.defaultExecutionOptions({ projectId });
      const providerId = defaults.providerId || remembered?.providerId || "codex";
      const route = await this.threadRouting.request({ projectId, environment: { type: "project-default" as const } });
      const environment = route.environment as StartInput["request"]["environment"];
      const routing = environment.type === "host" && environment.hostId ? { hostId: environment.hostId } : {};
      let model = defaults.model || (remembered?.providerId === providerId ? remembered.model : "");
      if (!model) {
        const catalog = await this.bb.sdk.providers.models({ ...routing, providerId });
        model = catalog.models.find(m => m.isDefault)?.model || "";
        if (catalog.modelLoadError || !model) throw new PolicyError("Choose a default work account and model in 247C settings before opening a chat.");
      }
      // Validate all execution choices; only this explicit shortcut may omit the first message.
      const request = requestSchema.parse({ ...route, providerId, model, reasoningLevel: "medium", permissionMode: "accept-edits",
        executionInputSources: { providerId: "explicit", model: "explicit", reasoningLevel: "explicit", permissionMode: "explicit" }, input: [{ type: "text", text: "New chat" }] });
      return this.readyChat(await this.start({ ...input, revision: task.revision, criteria: [], request: { ...request, input: [] } }, true));
    };
    const promise = create(); this.openingChats.set(input.taskId, promise);
    void promise.finally(() => { if (this.openingChats.get(input.taskId) === promise) this.openingChats.delete(input.taskId); }).catch(() => {});
    return promise;
  }

  private async readyChat(session: Session): Promise<Session> {
    if (session.status === "starting" && !this.processing.has(session.id)) await this.tick(session.id);
    session = this.repo.session(session.id);
    if (session.status === "starting" || !ACTIVE.has(session.status) || !session.workerThreadId) throw new PolicyError(session.error || "The chat is still being prepared. Try opening it again in a moment.");
    return session;
  }

  private async clearEmptyChatBootstrap(session: Session) {
    if (!(this.repo.sessionRequest(session.id) as { emptyChat?: boolean }).emptyChat || !session.workerThreadId) return;
    const queued = await this.bb.sdk.threads.queuedMessages.list({ threadId: session.workerThreadId });
    for (const row of queued) {
      if (row.content.length === 1 && row.content[0].type === "text" && row.content[0].visibility === "agent-only" && row.content[0].text === emptyChatBootstrap(session.id)) {
        // The held launch options disappear with the queued row. Preserve them
        // as native thread defaults before the user writes the first message.
        await this.bb.sdk.threads.update({ threadId: session.workerThreadId, model: session.workerModel, reasoningLevel: session.reviewerReasoning });
        await this.bb.sdk.threads.queuedMessages.delete({ threadId: session.workerThreadId, queuedMessageId: row.id });
      }
    }
  }

  bootstrapDispatch(context: MessageDispatchHookContext) {
    if (context.thread.originPluginId !== this.bb.pluginId) return null;
    // Inspect each block, so a queued bootstrap stays held even in a grouped drain.
    for (const block of context.input.blocks) {
      if (block.type !== "text" || block.visibility !== "agent-only") continue;
      const match = /^247C empty-chat bootstrap ([a-f0-9-]{36})\./.exec(block.text);
      if (!match || block.text !== emptyChatBootstrap(match[1])) continue;
      try {
        const session = this.repo.session(match[1]);
        if (!(this.repo.sessionRequest(session.id) as { emptyChat?: boolean }).emptyChat) continue;
        if (session.workerThreadId === context.thread.id || context.thread.title === `247C · worker · ${session.id}`) {
          return { action: "wait" as const, reason: "Preparing an empty 247C chat." };
        }
      } catch { /* Unrelated input is not a bootstrap owned by this plugin. */ }
    }
    return null;
  }

  async start(input: StartInput, emptyChat = false): Promise<Session> {
    const existing = this.repo.db.prepare("SELECT id FROM sessions WHERE id=?").get(input.requestId);
    if (existing) {
      const original = this.repo.sessionRequest(input.requestId) as { startFingerprint?: string };
      if (original.startFingerprint !== digest(input)) throw new PolicyError("The launch key has already been used for a different assignment.");
      return this.repo.session(input.requestId);
    }
    const task = this.repo.assertCurrent(input.taskId, input.revision, !input.continueSessionId && !emptyChat);
    const closedTaskConversation = emptyChat && !isLiveTask(task.status);
    const discussion = this.discussionSource(input);
    if (this.repo.active().some((s) => s.taskId === input.taskId)) throw new PolicyError("This task already has a worker.");
    if (input.request.input.some((i) => i.type !== "text")) throw new PolicyError("This version requires text input. Reference any necessary files within the selected workspace in the task description.");
    if (emptyChat && (input.criteria.length || input.continueSessionId || input.request.input.length)) throw new PolicyError("An empty chat must be a new ordinary conversation.");
    const objective = emptyChat ? "Conversation opened by the user; the first message will define the work." : input.request.input.filter((i) => i.type === "text").map((i) => i.text).join("\n").trim();
    if (!objective) throw new PolicyError("Describe what should be done in this session.");
    const options = await this.settings();
    const mode = input.criteria.length ? "result" : "conversation";
    const reviewerProvider = mode === "conversation" ? input.request.providerId : input.request.providerId === "codex" ? "claude-code" : "codex";
    const reviewerModel = mode === "conversation" ? input.request.model : reviewerProvider === "codex" ? options.codexReviewer : options.claudeReviewer;
    const routed = await this.threadRouting.request(input.request);
    const request = nativeRequest(routed);
    const environment = routed.environment;
    const routing = environment.type === "reuse"
      ? { environmentId: environment.environmentId }
      : environment.type === "provider"
        ? { hostId: environment.machine.hostId }
        : environment.type === "host" && environment.hostId
          ? { hostId: environment.hostId }
          : {};
    const [providers, reviewerCatalog, workerCatalog] = await Promise.all([
      this.bb.sdk.providers.list(routing),
      // Conversations choose their recorder on Finish, not when the chat opens.
      mode === "result" ? this.bb.sdk.providers.models({ ...routing, providerId: reviewerProvider }) : null,
      // Empty chats persist native thread defaults before removing the bootstrap.
      // BB requires a catalog entry for that update, even when the CLI accepts
      // unlisted IDs on a normal launch with a first message.
      emptyChat || input.request.providerId === "codex" ? this.bb.sdk.providers.models({ ...routing, providerId: input.request.providerId }) : null,
    ]);
    if (![input.request.providerId, reviewerProvider].every((id) => providers.some((p) => p.id === id && p.available))) throw new PolicyError(mode === "conversation" ? "The selected account is unavailable on this machine." : "Both Codex and Claude Code must be available on the selected machine to start.");
    if (reviewerCatalog && (reviewerCatalog.modelLoadError || !reviewerCatalog.models.some((m) => m.model === reviewerModel || m.id === reviewerModel))) throw new PolicyError(`Verification model ${reviewerModel} is unavailable. Another model will not be substituted automatically.`);
    if (workerCatalog && (workerCatalog.modelLoadError || !workerCatalog.models.some((m) => m.model === input.request.model || !emptyChat && m.id === input.request.model))) throw new PolicyError(emptyChat
      ? `The selected worker model ${input.request.model} is missing from the ${input.request.providerId} BB model catalog or the catalog could not be loaded. Register the model with that provider before opening an empty chat. No model was substituted.`
      : "The selected worker model is unavailable.");
    const timestamp = new Date().toISOString();
    let session: Session = { id: input.requestId, taskId: input.taskId, baseRevision: input.revision, status: "starting", objective, criteria: input.criteria, mode, finishedAt: null, extraction: null, extractionRepair: null,
      ...(mode === "conversation" ? { workerContext: acceptedWorkerContext(this.repo, input.taskId) } : {}),
      ...(closedTaskConversation ? { closedTaskConversation: true } : {}),
      ...(discussion && sessionFinishMode(discussion.session) ? { finishMode: sessionFinishMode(discussion.session) } : {}),
      continuedFrom: discussion?.session.id ?? null, discussionProposalId: discussion?.proposal?.id ?? null,
      workerThreadId: null, reviewerThreadId: null, environmentId: null, hostId: null, workerProvider: input.request.providerId, workerModel: input.request.model,
      reviewerProvider, reviewerModel, reviewerReasoning: input.request.reasoningLevel, round: 0, maximumRepairs: options.maximumRepairs, createdAt: timestamp, updatedAt: timestamp,
      deadlineAt: Date.now() + options.sessionMinutes * 60000, error: null, result: null, artifacts: [], review: null, proposalId: null };
    this.repo.store.transaction(() => {
      this.repo.assertCurrent(input.taskId, input.revision, !input.continueSessionId && !closedTaskConversation);
      const latest = this.discussionSource(input);
      if (latest?.proposal?.id !== discussion?.proposal?.id || latest?.proposal?.status !== discussion?.proposal?.status) throw new PolicyError("The review changed. Refresh the dossier before discussing it.");
      if (this.repo.active().some((s) => s.taskId === input.taskId)) throw new PolicyError("This task already has a worker.");
      this.repo.insertSession(session, { request, startFingerprint: digest(input), ...(emptyChat ? { emptyChat: true } : {}) });
      this.repo.sessionEvent(session.id, "contract", mode === "conversation" ? "Task conversation started; the user ends it with the finish button." : "The assignment and acceptance criteria were saved.", input);
    });
    this.processing.add(session.id);
    try {
      const thread = await this.bb.sdk.threads.spawn({ ...request,
        title: `247C · worker · ${session.id}`, visibility: "visible",
        input: emptyChat ? [{ type: "text", text: emptyChatBootstrap(session.id), mentions: [], visibility: "agent-only" }] : [...request.input, { type: "text", text: workerInstructions(session, this.repo.detail(session.taskId), discussion, options.automaticProcessing), mentions: [], visibility: "agent-only" }],
      });
      session = this.repo.saveSession({ ...this.repo.session(session.id), workerThreadId: thread.id, environmentId: thread.environmentId });
      if (!ACTIVE.has(session.status) || this.disposed) { await this.stopThread(thread.id, false); return session; }
      if (emptyChat) await this.clearEmptyChatBootstrap(session);
      session = this.repo.saveSession({ ...session, status: "working" });
      this.repo.sessionEvent(session.id, "worker-started", emptyChat ? "Empty BB chat opened; awaiting the first user message." : "Worker started in BB.", { threadId: thread.id });
      await this.nameWorkerThread(session, thread);
      // BB may return the new environment while its directory is still being
      // provisioned. Resolve the path when the worker finishes, not at spawn.
      return this.repo.session(session.id);
    } catch (error) {
      // A spawn transport failure is ambiguous: locate any already-created worker
      // by the unique title before deciding that launch failed. Never auto-respawn.
      const found = await this.findThread(session, "worker").catch(() => undefined);
      if (found) {
        session = this.repo.saveSession({ ...this.repo.session(session.id), workerThreadId: found.id, environmentId: found.environmentId });
        await this.nameWorkerThread(session, found);
        if (emptyChat && ACTIVE.has(session.status)) {
          // Keep the held bootstrap recoverable; never respawn after an ambiguous response.
          return this.repo.saveSession({ ...session, status: "starting", error: String(error).slice(0, 4000) });
        }
      }
      return await this.block(session.id, error);
    } finally { this.processing.delete(session.id); }
  }

  private discussionSource(input: StartInput) {
    if (!input.continueSessionId) return undefined;
    const session = this.repo.session(input.continueSessionId);
    if (input.criteria.length || session.taskId !== input.taskId || session.mode !== "conversation" || !session.finishedAt || ACTIVE.has(session.status)) throw new PolicyError("You can discuss a finished conversation belonging to this task.");
    const transcript = this.repo.transcript(session.id);
    if (!transcript) throw new PolicyError("Retry the original session's review first to save its transcript.");
    const proposal = session.proposalId ? this.repo.kernel.getProposal(session.proposalId) : null;
    return { session, transcript, proposal };
  }

  private async findThread(session: Session, role: string) {
    // Once bound, the persisted thread ID survives display-title changes.
    // The unique launch title is only needed before that binding is saved.
    const workerThreadId = role === "worker" ? this.repo.session(session.id).workerThreadId : null;
    if (workerThreadId) {
      const thread = await this.bb.sdk.threads.get({ threadId: workerThreadId });
      return thread.originPluginId === this.bb.pluginId ? thread : undefined;
    }
    const title = role === "verification" || role === "review" ? `247C · ${role} ${session.round} · ${session.id}` : `247C · ${role} · ${session.id}`;
    const legacyRole = ({ worker: "исполнитель", verification: "проверка", review: "разбор" } as Record<string, string>)[role];
    const legacyTitle = legacyRole && (role === "worker" ? `247C · ${legacyRole} · ${session.id}` : `247C · ${legacyRole} ${session.round} · ${session.id}`);
    for (let offset = 0; offset < 2000; offset += 100) {
      const page = await this.bb.sdk.threads.list({ originPluginId: this.bb.pluginId, includeHidden: true, limit: 100, offset });
      const found = page.find((t) => t.title === title || t.title === legacyTitle);
      if (found) return found;
      if (page.length < 100) return undefined;
    }
    throw new PolicyError("Too many threads to safely recover the launch.");
  }

  private async nameWorkerThread(session: Session, thread: { id: string; title: string | null; originPluginId: string | null }) {
    if (this.disposed || thread.originPluginId !== this.bb.pluginId || session.workerThreadId !== thread.id || ![`247C · worker · ${session.id}`, `247C · исполнитель · ${session.id}`].includes(thread.title ?? "")) return;
    try {
      const title = `247C · ${this.repo.kernel.getTask(session.taskId).title}`;
      await this.bb.sdk.threads.update({ threadId: thread.id, title });
    } catch (error) {
      // A cosmetic update must not stop work. Active-session ticks retry it;
      // a title edited by the user is never replaced.
      this.bb.log.warn(`Could not name worker thread ${thread.id}: ${String(error)}`);
    }
  }

  private async bindEnvironment(session: Session) {
    // A provisioned workspace can be assigned after spawn/thread.created.
    // Resolve the live worker before using the cached session, including retries.
    const worker = session.workerThreadId ? await this.bb.sdk.threads.get({ threadId: session.workerThreadId }) : null;
    const environmentId = worker ? worker.environmentId : session.environmentId;
    if (!environmentId) throw new PolicyError("BB has not prepared the session workspace yet. Retry finishing when the chat is ready.");
    const env = await this.bb.sdk.environments.get({ environmentId });
    if (!env.hostId || !env.path || !workspacePaths(env.path)) throw new PolicyError("An available workspace with an absolute path is required.");
    this.repo.saveSession({ ...this.repo.session(session.id), environmentId, hostId: env.hostId });
    return env;
  }

  async submit(threadId: string, result: WorkerResult) {
    const session = this.repo.forThread(threadId);
    if (!session || session.workerThreadId !== threadId || session.status !== "working") throw new PolicyError("This thread is not the task's current worker.");
    if (session.mode === "conversation") throw new PolicyError("This is an ordinary conversation. The user ends it with Finish session.");
    this.repo.assertCurrent(session.taskId, session.baseRevision);
    this.repo.saveSession({ ...session, result: resultSchema.parse(result) });
    this.repo.sessionEvent(session.id, "worker-result", "The worker submitted a result; verification will start after the turn ends.", result);
    return { saved: true, canonicalTaskChanged: false };
  }

  async observeArtifacts(session: Session): Promise<ObservedArtifact[]> {
    const env = await this.bindEnvironment(session);
    const root = env.path!;
    const artifacts: ObservedArtifact[] = [];
    let total = 0;
    const seen = new Set<string>();
    for (const item of session.result?.artifacts ?? []) {
      const { path, relative, identity } = resolveWorkspaceArtifact(root, item.path);
      if (relative.split("/").some((part) => forbiddenPath.has(part) || part.startsWith(".env.") || /\.(pem|key|p12|pfx)$/i.test(part))) throw new PolicyError("This file is not suitable for verification.");
      if (seen.has(identity)) throw new PolicyError("The artifact is listed twice.");
      seen.add(identity);
      const file = await this.bb.sdk.files.read({ hostId: env.hostId, rootPath: root, path });
      total += file.sizeBytes;
      if (file.contentEncoding !== "utf8" || file.content.includes("\0")) throw new PolicyError("This version verifies text files and code. This artifact requires a separate visual check.");
      if (file.sizeBytes > 128 * 1024 || total > 256 * 1024) throw new PolicyError("Artifacts exceed the verification limit: 128 KiB per file, 256 KiB per session.");
      artifacts.push({ ref: `artifact:${artifacts.length}`, path, label: item.label, sha256: file.sha256, text: file.content, bytes: file.sizeBytes });
    }
    return artifacts;
  }

  async assertArtifacts(session: Session) {
    if (!session.artifacts.length) return;
    const observed = await this.observeArtifacts(session);
    if (observed.length !== session.artifacts.length || observed.some((a, i) => a.path !== session.artifacts[i]?.path || a.sha256 !== session.artifacts[i]?.sha256)) throw new PolicyError("Files changed after verification. Start a new session for the updated files.");
  }

  async tick(id: string) {
    if (this.disposed || this.processing.has(id)) return;
    this.processing.add(id);
    try {
      let session = this.repo.session(id);
      if (!ACTIVE.has(session.status)) return;
      if (session.mode === "conversation") { await this.tickConversation(session); return; }
      this.repo.assertCurrent(session.taskId, session.baseRevision);
      if (Date.now() > session.deadlineAt) throw new PolicyError("The work session timed out. Results are preserved in the chats.");
      if (session.status === "starting" || session.status === "review_starting") {
        const role = session.status === "starting" ? "worker" : "verification";
        const found = await this.findThread(session, role);
        if (!found) {
          if (Date.now() - Date.parse(session.updatedAt) > 60000) throw new PolicyError("The launch was not confirmed. An automatic retry could create a second agent.");
          return;
        }
        session = this.repo.saveSession({ ...session, ...(role === "worker" ? { workerThreadId: found.id, environmentId: found.environmentId, status: "working" as const } : { reviewerThreadId: found.id, status: "reviewing" as const }) });
      }
      if (session.status === "collecting") { await this.beginReview(session); return; }
      if (session.status === "repair_starting") throw new PolicyError("The repair request was interrupted. Check the chat; it will not be retried automatically.");
      if (session.status === "working" && session.workerThreadId) {
        const thread = await this.bb.sdk.threads.get({ threadId: session.workerThreadId });
        await this.nameWorkerThread(session, thread);
        if (FAILED.has(thread.status) || thread.archivedAt || thread.deletedAt) throw new PolicyError("The worker stopped with an error. See its chat for details.");
        if (thread.status !== "idle") return;
        if ((await this.bb.sdk.threads.interactions.list({ threadId: thread.id })).length) return;
        const execution = await this.bb.sdk.threads.defaultExecutionOptions({ threadId: thread.id });
        if (thread.providerId !== session.workerProvider || execution?.model !== session.workerModel) throw new PolicyError("The worker model changed or was not confirmed. Start a new session with the selected model.");
        const output = await this.bb.sdk.threads.output({ threadId: session.workerThreadId });
        this.current(id);
        if (thread.environmentId && session.environmentId !== thread.environmentId) session = this.repo.saveSession({ ...session, environmentId: thread.environmentId });
        const result = session.result ?? resultSchema.parse(parseJsonResult(output.output));
        session = this.repo.saveSession({ ...session, status: "collecting", result });
        this.repo.sessionEvent(id, "worker-finished", "Worker response received; the dossier is unchanged.", { output: output.output, result });
        await this.stopRuntime(session.workerThreadId!, () => this.current(id));
        await this.beginReview(session);
      } else if (session.status === "reviewing" && session.reviewerThreadId) {
        const thread = await this.bb.sdk.threads.get({ threadId: session.reviewerThreadId });
        if (FAILED.has(thread.status) || thread.archivedAt || thread.deletedAt) throw new PolicyError("Independent verification stopped with an error. The result was not accepted.");
        if (thread.status !== "idle") return;
        const execution = await this.bb.sdk.threads.defaultExecutionOptions({ threadId: thread.id });
        if (thread.providerId !== session.reviewerProvider || execution?.model !== session.reviewerModel) throw new PolicyError("The verification model changed or was not confirmed. The result was not accepted.");
        const output = await this.bb.sdk.threads.output({ threadId: thread.id });
        let review: Review;
        try {
          review = validateReview(parseJsonResult(output.output), session);
          this.repo.sessionEvent(id, "review", "Independent verification completed.", { reviewerThreadId: thread.id, review, artifacts: session.artifacts });
        } finally { await this.stopThread(thread.id, true); }
        this.current(id);
        session = this.repo.saveSession({ ...session, review });
        if (review.verdict === "pass") {
          await this.assertArtifacts(session);
          this.current(id);
          this.makeProposal(session);
        } else if (review.verdict === "repair" && session.round < session.maximumRepairs) {
          session = this.repo.saveSession({ ...session, status: "repair_starting", round: session.round + 1, result: null, artifacts: [], reviewerThreadId: null });
          await this.bb.sdk.threads.send({ threadId: session.workerThreadId!, mode: "auto", input: [{ type: "text", text: repairInstructions(session, review), mentions: [] }] });
          this.repo.saveSession({ ...this.current(id), status: "working" });
        } else await this.block(id, new PolicyError(review.findings.join("\n")));
      }
    } catch (error) { if (!this.disposed) await this.block(id, error); }
    finally { this.processing.delete(id); }
  }

  private async chooseRecorder(session: Session, choice: "auto" | "same" | "personal-claude", options: SettingsView) {
    const environment = await this.bindEnvironment(session);
    const execution = await this.bb.sdk.threads.defaultExecutionOptions({ threadId: session.workerThreadId! });
    const workerModel = execution?.model ?? session.workerModel;
    const routing = { environmentId: environment.id };
    if (choice === "auto") {
      const providers = await this.bb.sdk.providers.list(routing);
      // Personal conversations must not be sent to the corporate account.
      const permitted = ["claude-code", "codex", ...(session.workerProvider === "claude-work" ? ["claude-work"] : [])];
      const catalogs = await Promise.all(permitted.filter((id) => providers.some((p) => p.id === id && p.available)).map(async (providerId) => {
        try {
          const catalog = await this.bb.sdk.providers.models({ ...routing, providerId });
          return { providerId, models: catalog.modelLoadError ? [] : catalog.models };
        } catch { return { providerId, models: [] }; }
      }));
      const failed = ["blocked", "rejected"].includes(session.status) && session.reviewerThreadId ? { providerId: session.reviewerProvider, model: session.reviewerModel } : undefined;
      return { workerModel, ...selectRecorder(catalogs, { providerId: session.workerProvider, model: workerModel }, failed, parseExcludedReviewModels(options.excludedReviewModels)) };
    }
    // Compatibility for already-open clients using the former manual selector.
    const reviewerProvider = choice === "personal-claude" ? "claude-code" : session.workerProvider;
    const reviewerModel = choice === "personal-claude" ? options.claudeReviewer : workerModel;
    const [providers, catalog] = await Promise.all([this.bb.sdk.providers.list(routing), this.bb.sdk.providers.models({ ...routing, providerId: reviewerProvider })]);
    const model = catalog.models.find((m) => m.id === reviewerModel || m.model === reviewerModel);
    if (!providers.some((p) => p.id === reviewerProvider && p.available) || catalog.modelLoadError || !model) throw new PolicyError(`Review model unavailable: ${reviewerModel}. Choose another account or model.`);
    if (!allowedRecorder(reviewerProvider, model, parseExcludedReviewModels(options.excludedReviewModels))) throw new PolicyError(`Model ${reviewerModel} is excluded from review. Retry finishing with automatic model selection.`);
    const desired = choice === "personal-claude" ? "medium" : execution?.reasoningLevel ?? "medium";
    const reviewerReasoning = model.supportedReasoningEfforts?.length && !model.supportedReasoningEfforts.some((e) => e.reasoningEffort === desired) ? model.defaultReasoningEffort : desired;
    return { workerModel, reviewerProvider, reviewerModel, reviewerReasoning, selectionReason: `Review model selected manually: ${reviewerModel} (${reviewerProvider}).` };
  }

  async finish(id: string, recorder: "auto" | "same" | "personal-claude" = "auto", readyCheck?: () => Promise<boolean>, sourceResolution?: { apply: () => void; automatic: boolean }) {
    let session = this.repo.session(id);
    if (session.mode !== "conversation") throw new PolicyError("This session was created with acceptance criteria and uses the earlier verification workflow.");
    if (session.finishedAt || !ACTIVE.has(session.status)) return session;
    if (session.status !== "working" || !session.workerThreadId || this.processing.has(id)) throw new PolicyError("The chat is still starting. You will be able to finish it in a few seconds.");
    const options = await this.settings();
    const { selectionReason, ...selection } = await this.chooseRecorder(session, recorder, options);
    session = this.repo.session(id);
    if (session.finishedAt || !ACTIVE.has(session.status)) return session;
    if (readyCheck && !await readyCheck()) return this.repo.session(id);
    session = this.repo.session(id);
    if (session.status !== "working" || session.finishedAt) return session;
    // Freeze dispatch before awaiting anything that can deliver an idle event.
    this.repo.store.transaction(() => {
      session = this.repo.saveSession({ ...this.current(id), ...selection, status: "collecting", finishedAt: new Date().toISOString(), deadlineAt: Date.now() + options.sessionMinutes * 60000,
        ...(sourceResolution ? { finishMode: "source" as const, ...(sourceResolution.automatic ? { automation: { state: "reviewing" as const } } : {}) } : {}) });
      session = this.repo.saveSession({ ...session, reportedTimeContext: this.repo.sessionTime.capture(session) });
      // Freeze dispatch and accept the source in one transaction. If the source
      // became stale, the session remains open and no time is lost.
      sourceResolution?.apply();
    });
    this.unavailableMonitors.delete(id);
    this.repo.sessionEvent(id, "conversation-finished", session.automation ? "The conversation ended for a separate automatic review." : "The user ended the conversation; a separate review is starting.");
    this.repo.sessionEvent(id, "recorder-selected", selectionReason, selection);
    // Collection owns stopping and snapshotting under tick's processing lock.
    // Releasing here as well would stop the same runtime twice before review.
    await this.tick(id);
    return this.repo.session(id);
  }

  async retry(id: string, recorder: "auto" | "same" | "personal-claude" = "auto") {
    let session = this.repo.session(id);
    if (session.mode !== "conversation" || !session.finishedAt || this.processing.has(id)) throw new PolicyError("Finish the conversation before retrying the review.");
    if (ACTIVE.has(session.status)) return session;
    if (!["blocked", "awaiting_approval", "rejected"].includes(session.status)) throw new PolicyError("This session's review has already finished.");
    if (this.repo.sessions(session.taskId).some((s) => s.continuedFrom === session.id && s.proposalId)) throw new PolicyError("This review was revised in a later session. Retry or discuss the latest review to preserve the corrections.");
    if (this.repo.active().some((s) => s.taskId === session.taskId)) throw new PolicyError("Finish this task's other open session first.");
    const task = this.repo.kernel.getTask(session.taskId);
    this.repo.assertCurrent(task.id, task.revision, this.requiresOpenTask(session));
    this.processing.add(id);
    try {
      if (recorder === "auto" && session.status === "blocked" && !session.proposalId && await this.recoverExtraction(session)) return this.repo.session(id);
      const options = await this.settings();
      const { selectionReason, ...selection } = await this.chooseRecorder(session, recorder, options);
      await this.stopSession(id);
      // The old draft remains in history; it cannot be accepted alongside its replacement.
      if (session.proposalId) {
        const proposal = this.repo.kernel.getProposal(session.proposalId);
        if (["pending", "approved"].includes(proposal.status)) this.repo.reject(proposal.id);
      }
      if (this.repo.active().some((s) => s.taskId === session.taskId)) throw new PolicyError("Another conversation is already open for this task.");
      session = this.repo.saveSession({ ...this.repo.session(id), ...selection, status: "collecting", baseRevision: task.revision, reviewerThreadId: null, proposalId: null, round: session.round + 1, extraction: null, extractionRepair: null, error: null, deadlineAt: Date.now() + options.sessionMinutes * 60000 });
      this.repo.sessionEvent(id, "recorder-selected", selectionReason, selection);
    } finally { this.processing.delete(id); }
    await this.tick(id);
    return this.repo.session(id);
  }

  async resume(id: string) {
    const session = this.repo.session(id);
    if (session.mode === "conversation" && session.status === "working" && !session.finishedAt) return this.current(id);
    const assertResumable = (value: Session) => {
      if (this.disposed || value.mode !== "conversation" || value.status !== "blocked" || value.finishedAt || !value.workerThreadId ||
          value.reviewerThreadId || value.proposalId || value.extraction || value.extractionRepair || value.result || value.review || this.repo.transcript(id)) {
        throw new PolicyError("Only a blocked, unfinished conversation with its original chat can be resumed. Finished conversations stay frozen; use Retry review or Discuss review.");
      }
      if (!value.continuedFrom && !isLiveTask(this.repo.kernel.getTask(value.taskId).status)) throw new PolicyError("The task is already closed.");
      if (this.repo.active().some((other) => other.taskId === value.taskId)) throw new PolicyError("Finish this task's other open session first.");
    };
    assertResumable(session);
    if (this.processing.has(id)) throw new PolicyError("The session is still being checked. Try again in a few seconds.");
    this.processing.add(id);
    try {
      // Recovery is explicit and only re-enables this existing conversation.
      // Never create a replacement agent, resend a message or unfreeze a review.
      const thread = await this.bb.sdk.threads.get({ threadId: session.workerThreadId! });
      if (thread.id !== session.workerThreadId || thread.originPluginId !== this.bb.pluginId || this.repo.forThread(thread.id)?.id !== id || thread.archivedAt || thread.deletedAt || ["archived", "deleted"].includes(thread.status)) {
        throw new PolicyError("The original work chat is unavailable or archived. Open its saved history before choosing how to continue.");
      }
      return this.repo.store.transaction(() => {
        const current = this.repo.session(id);
        if (JSON.stringify(current) !== JSON.stringify(session)) throw new PolicyError("The session changed while checking the chat. Refresh the dossier and try again.");
        assertResumable(current);
        const resumed = this.repo.saveSession({ ...current, status: "working", error: null });
        this.repo.sessionEvent(id, "conversation-resumed", "The user resumed the existing unfinished conversation; no message was sent.", { threadId: thread.id, previousError: current.error });
        return resumed;
      });
    } finally { this.processing.delete(id); }
  }

  private async recoverExtraction(session: Session) {
    const transcript = this.repo.transcript(session.id);
    const dossier = this.repo.detail(session.taskId);
    if (!transcript || dossier.task.revision !== session.baseRevision) return false;
    for (const candidate of this.repo.recorderThreads(session.id)) {
      const recoveryKey = `conversation:${session.id}:recovered:${candidate.threadId}`;
      // A human-rejected or previously proposed answer must never be revived.
      if (dossier.proposals.some((p) => p.idempotencyKey === `conversation:${session.id}:${candidate.round}` || p.idempotencyKey === recoveryKey)) continue;
      let saved;
      try { saved = await readSavedRecorder(this.bb, candidate.threadId, session, dossier, transcript); }
      catch (error) { this.bb.log.warn(`Could not inspect saved recorder ${candidate.threadId}: ${String(error)}`); continue; }
      if (!saved) continue;
      let extraction: Extraction;
      let proposalInput: ReturnType<typeof extractionProposal>;
      try {
        extraction = validateExtraction(parseJsonResult(saved.output, 512 * 1024), transcript, session.reportedTimeContext, this.repo.kernel.getTask(session.taskId).status, sessionFinishMode(session));
        proposalInput = extractionProposal(extraction, session, dossier, transcript);
      } catch (error) {
        if (error instanceof PolicyError || error instanceof ZodError) continue;
        throw error;
      }
      const current = this.repo.session(session.id);
      if (this.disposed || current.status !== "blocked" || current.updatedAt !== session.updatedAt) throw new PolicyError("The session changed during revalidation.");
      this.repo.assertCurrent(session.taskId, session.baseRevision, this.requiresOpenTask(session));
      if (this.repo.active().some((s) => s.taskId === session.taskId)) throw new PolicyError("Finish this task's other open session first.");
      this.repo.store.transaction(() => {
        const recovered = this.repo.saveSession({ ...current, status: "reviewing", round: current.round + 1, reviewerThreadId: candidate.threadId,
          reviewerProvider: saved.reviewerProvider, reviewerModel: saved.reviewerModel, reviewerReasoning: saved.reviewerReasoning,
          extraction: null, extractionRepair: null, error: null });
        this.makeConversationProposal(recovered, extraction, proposalInput, recoveryKey);
        this.repo.sessionEvent(session.id, "extraction-recovered", "The saved review response passed revalidation; no new generation was needed.", { threadId: candidate.threadId, sourceRound: candidate.round });
      });
      return true;
    }
    return false;
  }

  private async tickConversation(session: Session) {
    this.current(session.id);
    const chatting = session.status === "working" || session.status === "starting";
    if (!chatting && Date.now() > session.deadlineAt) throw new PolicyError("The review timed out. The conversation is saved; you can retry the review.");
    if (session.status === "starting" || session.status === "review_starting") {
      const worker = session.status === "starting";
      const found = await this.findThread(session, worker ? "worker" : "review");
      if (!found) {
        if (Date.now() - Date.parse(session.updatedAt) > 60000) throw new PolicyError("The launch was not confirmed. An automatic retry could create a second agent.");
        return;
      }
      if (worker) {
        try { await this.clearEmptyChatBootstrap({ ...session, workerThreadId: found.id }); }
        catch (error) { this.bb.log.warn(`Could not prepare empty chat ${session.id}; will retry: ${String(error)}`); return; }
      }
      session = this.repo.saveSession({ ...session, error: null, ...(worker ? { workerThreadId: found.id, environmentId: found.environmentId, status: "working" as const } : { reviewerThreadId: found.id, status: "reviewing" as const }) });
    }
    if (session.status === "working") {
      let thread;
      try { thread = await this.bb.sdk.threads.get({ threadId: session.workerThreadId! }); }
      catch (error) {
        // A failed read says nothing about whether the user ended the chat.
        // The monitor retries; it must never stop an agent on this evidence.
        if (!this.disposed && this.repo.session(session.id).status === "working" && !this.unavailableMonitors.has(session.id)) {
          this.unavailableMonitors.add(session.id);
          const message = (error instanceof Error ? error.message : String(error)).slice(0, 4000);
          this.bb.log.warn(`Could not check conversation ${session.id}; keeping it open and retrying: ${message}`);
          this.repo.sessionEvent(session.id, "monitor-unavailable", "The chat status could not be read. The conversation remains open; the check will retry.", { error: message });
        }
        return;
      }
      if (this.current(session.id).status !== "working") return;
      if (this.unavailableMonitors.delete(session.id)) this.repo.sessionEvent(session.id, "monitor-restored", "The chat status is available again; the conversation stayed open.");
      await this.nameWorkerThread(session, thread);
      if (thread.archivedAt || thread.deletedAt || ["archived", "deleted"].includes(thread.status)) throw new PolicyError("The work chat was archived or deleted. The saved conversation is preserved.");
      // Idle, failed turns and pauses are normal in a human conversation. Neither
      // an answer nor the old session timer is an instruction to finish it.
      return;
    }
    if (session.status === "collecting") { await this.beginExtraction(session); return; }
    if (session.status !== "reviewing" || !session.reviewerThreadId) return;
    const thread = await this.bb.sdk.threads.get({ threadId: session.reviewerThreadId });
    if (FAILED.has(thread.status) || thread.archivedAt || thread.deletedAt) throw new PolicyError("The review stopped with an error. The conversation is saved; you can retry the review.");
    if (thread.status !== "idle") return;
    const execution = await this.bb.sdk.threads.defaultExecutionOptions({ threadId: thread.id });
    if (thread.providerId !== session.reviewerProvider || execution?.model !== session.reviewerModel) throw new PolicyError("BB did not confirm the selected review account and model.");
    try {
      const output = await this.bb.sdk.threads.output({ threadId: thread.id });
      const transcript = this.repo.transcript(session.id);
      if (!transcript) throw new PolicyError("Saved conversation not found.");
      this.current(session.id);
      const dossier = this.repo.detail(session.taskId);
      this.repo.assertCurrent(session.taskId, session.baseRevision, this.requiresOpenTask(session));
      let extraction: Extraction;
      let proposalInput: ReturnType<typeof extractionProposal>;
      try {
        extraction = validateExtraction(parseJsonResult(output.output, 512 * 1024), transcript, session.reportedTimeContext, this.repo.kernel.getTask(session.taskId).status, sessionFinishMode(session));
        proposalInput = extractionProposal(extraction, session, dossier, transcript);
      } catch (error) {
        // Only malformed model output is repairable. Operational failures and
        // stale/cancelled sessions must not start more agents or save a draft.
        if (!(error instanceof PolicyError || error instanceof ZodError)) throw error;
        await this.repairExtraction(session, error);
        return;
      }
      this.makeConversationProposal(session, extraction, proposalInput);
    } finally { await this.stopThread(thread.id, true); }
  }

  private async repairExtraction(session: Session, error: Error) {
    const attempt = (session.extractionRepair?.attempt ?? 0) + 1;
    const limit = Math.min(2, session.maximumRepairs);
    if (attempt > limit) throw new PolicyError(`The review failed validation${limit ? ` after ${limit} automatic repairs` : ""}. ${error.message}`);
    const options = await this.settings();
    const { selectionReason, ...selection } = await this.chooseRecorder({ ...session, status: "blocked" }, "auto", options);
    this.current(session.id);
    this.repo.assertCurrent(session.taskId, session.baseRevision, this.requiresOpenTask(session));
    const feedback = error.message.slice(0, 4000);
    // Reuse the frozen transcript and the existing deadline. A fresh round
    // avoids duplicate dispatch and retains every failed response in history.
    this.repo.saveSession({ ...this.current(session.id), ...selection, status: "collecting", reviewerThreadId: null, round: session.round + 1,
      extractionRepair: { attempt, feedback }, error: null });
    this.repo.sessionEvent(session.id, "extraction-repair", `Automatic review repair ${attempt}/${limit}: ${feedback}`, { threadId: session.reviewerThreadId, attempt });
    this.repo.sessionEvent(session.id, "recorder-selected", selectionReason, selection);
  }

  private async beginExtraction(session: Session) {
    await this.stopRuntime(session.workerThreadId!, () => this.current(session.id));
    this.current(session.id);
    // A successful stop acknowledgement alone does not prove the final answer
    // has settled. Wait for a quiescent status before freezing its transcript.
    const thread = await this.bb.sdk.threads.get({ threadId: session.workerThreadId! });
    if (["active", "starting", "stopping", "pending"].includes(thread.status)) return;
    let transcript = this.repo.transcript(session.id);
    if (!transcript) {
      const current = await readConversation(this.bb, session);
      const previous = session.continuedFrom ? this.repo.transcript(session.continuedFrom) : null;
      if (session.continuedFrom && !previous) throw new PolicyError("The transcript of the session being discussed was not found.");
      transcript = previous ? continueTranscript(previous, current) : current;
    }
    this.current(session.id);
    this.repo.saveTranscript(session.id, transcript);
    if (!session.reportedTimeContext) session = this.repo.saveSession({ ...session, reportedTimeContext: this.repo.sessionTime.capture(session) });
    // Supplement legacy dates for this review without replacing its frozen transcript.
    transcript = await withTranscriptDates(this.bb, transcript);
    session = this.current(session.id);
    if (session.reportedTimeContext && !session.reportedTimeContext.timeZone) session = this.repo.saveSession({ ...session, reportedTimeContext: { ...session.reportedTimeContext, timeZone: this.repo.sessionTime.days.timeZone } });
    const env = await this.bindEnvironment(session);
    const dossier = this.repo.detail(session.taskId);
    this.repo.assertCurrent(dossier.task.id, dossier.task.revision, this.requiresOpenTask(session));
    const route = await this.threadRouting.review(env.hostId!);
    this.current(session.id);
    session = this.repo.saveSession({ ...this.repo.session(session.id), status: "review_starting", baseRevision: dossier.task.revision });
    this.repo.sessionEvent(session.id, "transcript", `Conversation saved: ${transcript.messages.length} messages.`, { count: transcript.messages.length, capturedAt: transcript.capturedAt });
    try {
      const recorder = await this.bb.sdk.threads.spawn({ ...route, providerId: session.reviewerProvider, model: session.reviewerModel,
        reasoningLevel: session.reviewerReasoning, permissionMode: "accept-edits", visibility: "hidden",
        executionInputSources: { providerId: "explicit", model: "explicit", reasoningLevel: "explicit", permissionMode: "explicit" },
        title: `247C · review ${session.round} · ${session.id}`, prompt: extractionInstructions(session, dossier, transcript),
      });
      const current = this.repo.saveSession({ ...this.repo.session(session.id), reviewerThreadId: recorder.id });
      if (!ACTIVE.has(current.status) || this.disposed) { await this.stopThread(recorder.id, true); return; }
      this.repo.saveSession({ ...this.current(session.id), status: "reviewing" });
    } catch (error) {
      const found = await this.findThread(session, "review").catch(() => undefined);
      if (found) this.repo.saveSession({ ...this.repo.session(session.id), reviewerThreadId: found.id });
      throw error;
    }
  }

  private makeConversationProposal(session: Session, extraction: Extraction, proposalInput: ReturnType<typeof extractionProposal>, idempotencyKey = `conversation:${session.id}:${session.round}`) {
    this.current(session.id);
    if (!extraction.changes && !extraction.facts.length && !extraction.knowledge.length && !extraction.reportedTime) {
      this.repo.saveSession({ ...session, status: "completed", extraction, error: null });
      this.repo.sessionEvent(session.id, "nothing-to-save", extraction.rationale);
      return;
    }
    // Notes-only updates still have one normal, receipted approval transaction.
    this.repo.store.transaction(() => {
      this.current(session.id);
      const proposal = this.repo.kernel.createProposal({ taskId: session.taskId, baseRevision: session.baseRevision, model: `${session.reviewerModel} · conversation review`,
        ...proposalInput, idempotencyKey });
      this.repo.saveSessionUpdate(session, proposal.id, extraction);
      this.repo.saveSession({ ...session, status: "awaiting_approval", extraction, proposalId: proposal.id, error: null });
      if (session.discussionProposalId) {
        const previous = this.repo.kernel.getProposal(session.discussionProposalId);
        if (["pending", "approved"].includes(previous.status)) {
          this.repo.reject(previous.id);
          this.repo.sessionEvent(session.id, "discussion-replaced-proposal", "The revised review replaced the previous unaccepted proposal.", { previousProposalId: previous.id, proposalId: proposal.id });
        }
      }
      this.repo.sessionEvent(session.id, "proposal", "Dossier and knowledge updates are ready for review.", { proposalId: proposal.id });
    });
  }

  private async beginReview(session: Session) {
    this.current(session.id);
    const artifacts = await this.observeArtifacts(session);
    session = this.repo.saveSession({ ...this.current(session.id), status: "review_starting", artifacts });
    this.repo.sessionEvent(session.id, "artifacts", "BB read the files for independent verification.", artifacts);
    try {
      const route = await this.threadRouting.review(session.hostId!);
      this.current(session.id);
      const reviewer = await this.bb.sdk.threads.spawn({ ...route, providerId: session.reviewerProvider, model: session.reviewerModel,
        reasoningLevel: "medium", permissionMode: "accept-edits", visibility: "hidden",
        executionInputSources: { providerId: "explicit", model: "explicit", reasoningLevel: "explicit", permissionMode: "explicit" },
        title: `247C · verification ${session.round} · ${session.id}`, prompt: reviewInstructions(session),
      });
      const current = this.repo.saveSession({ ...this.repo.session(session.id), reviewerThreadId: reviewer.id });
      if (!ACTIVE.has(current.status) || this.disposed) { await this.stopThread(reviewer.id, true); return; }
      this.repo.saveSession({ ...this.current(session.id), status: "reviewing" });
    } catch (error) {
      const found = await this.findThread(session, "verification").catch(() => undefined);
      if (found) this.repo.saveSession({ ...this.repo.session(session.id), reviewerThreadId: found.id });
      throw error;
    }
  }

  private makeProposal(session: Session) {
    this.current(session.id);
    const summaryRef = `session:${session.id}:summary`;
    const additionalEvidence: ProposalEvidence[] = [{ ref: summaryRef, kind: "progress", text: session.result!.summary, source: `reviewed-session:${session.id}`, sourceRef: null }];
    const changes: StewardChanges = { summary: { value: session.result!.summary, evidenceRefs: [summaryRef] } };
    if (session.artifacts.length) {
      const dossier = this.repo.kernel.getDossier(session.taskId);
      const merged = new Map(dossier.projection.artifacts.map((a) => [a.uri, a]));
      for (const a of session.artifacts) merged.set(workspaceFileUrl(a.path), { label: a.label, uri: workspaceFileUrl(a.path) });
      const allArtifacts = [...merged.values()];
      if (allArtifacts.length > 20) throw new PolicyError("The dossier contains too many artifacts for one proposal. The summary needs manual review.");
      for (const [i, a] of allArtifacts.entries()) additionalEvidence.push({ ref: `session:${session.id}:artifact:${i}`, kind: "artifact", text: a.label, source: session.artifacts.some((x) => workspaceFileUrl(x.path) === a.uri) ? `host-observation:${session.id}` : "previously-accepted-projection", sourceRef: a.uri });
      changes.artifacts = { value: allArtifacts, evidenceRefs: additionalEvidence.filter((e) => e.kind === "artifact").map((e) => e.ref) };
    }
    this.repo.store.transaction(() => {
      this.current(session.id);
      const proposal = this.repo.kernel.createProposal({ taskId: session.taskId, baseRevision: session.baseRevision, model: `${session.workerModel} / review:${session.reviewerModel}`, output: { rationale: `The session result was checked against ${session.criteria.length} criteria. Verification covers the response and the listed text files.`, confidence: 0.8, changes }, additionalEvidence, idempotencyKey: `session:${session.id}` });
      this.repo.saveSession({ ...session, status: "awaiting_approval", proposalId: proposal.id });
      this.repo.sessionEvent(session.id, "proposal", "Dossier changes await your approval.", { proposalId: proposal.id });
    });
  }

  async reviewParts(input: PartDecision, actor = "human:bb-panel") {
    const proposal = this.repo.kernel.getProposal(input.id);
    if (input.decision === "accept" && proposal.status === "pending") {
      const session = this.repo.sessions(proposal.taskId).find(s => s.proposalId === proposal.id);
      if (session) await this.assertArtifacts(session);
    }
    const result = this.repo.reviewParts(input, actor);
    await this.archiveFinishedThreads(proposal.taskId);
    return result;
  }
  async accept(proposalId: string, revision: number) {
    const proposal = this.repo.kernel.getProposal(proposalId);
    if (proposal.status !== "applied") {
      const session = this.repo.sessions(proposal.taskId).find((s) => s.proposalId === proposalId);
      if (session) await this.assertArtifacts(session);
    }
    const dossier = this.repo.accept(proposalId, revision);
    await this.archiveFinishedThreads(dossier.task.id);
    return dossier;
  }
  async status(taskId: string, status: TaskRecord["status"], revision: number) {
    const task = this.repo.status(taskId, status, revision);
    if (!isLiveTask(task.status)) await this.archiveFinishedThreads(task.id);
    return task;
  }
  async archiveFinishedThreads(taskId?: string) {
    for (const pending of this.repo.pendingThreadArchives(taskId)) {
      if (this.disposed) return;
      if (this.archiving.has(pending.threadId)) continue;
      this.archiving.add(pending.threadId);
      try {
        const thread = await this.bb.sdk.threads.get({ threadId: pending.threadId });
        // Recheck eligibility after BB responds: either the whole task is
        // closed, or this particular session's result has been accepted.
        const task = this.repo.kernel.getTask(pending.taskId);
        const currentSession = this.repo.forThread(pending.threadId);
        const acceptedSession = currentSession && this.repo.sessionResultsAccepted(currentSession.id);
        if (this.disposed || (currentSession && ACTIVE.has(currentSession.status)) || (isLiveTask(task.status) && !acceptedSession) || task.revision !== pending.revision) continue;
        if (!thread.archivedAt && !thread.deletedAt) await this.stopThread(thread.id, true);
        if (!this.disposed) this.repo.recordThreadArchive(pending.threadId, pending.revision, true);
      } catch (error) {
        // The dossier was committed before cleanup. Retry independently, also
        // after reload, without making a successful approval look like a failure.
        if (!this.disposed) {
          this.repo.recordThreadArchive(pending.threadId, pending.revision, false);
          this.bb.log.warn(`Could not archive finished thread ${pending.threadId}; will retry: ${String(error)}`);
        }
      } finally { this.archiving.delete(pending.threadId); }
    }
  }
  async cancel(id: string) {
    const session = this.repo.session(id);
    if (!ACTIVE.has(session.status)) return session;
    this.repo.saveSession({ ...session, status: "cancelled", error: "The user stopped the session." });
    this.unavailableMonitors.delete(id);
    await this.stopSession(id);
    return this.repo.session(id);
  }
  async block(id: string, error: unknown) {
    const session = this.repo.session(id);
    if (!ACTIVE.has(session.status)) return session;
    const message = error instanceof Error ? error.message : String(error);
    this.repo.saveSession({ ...session, status: "blocked", error: message.slice(0, 4000) });
    this.unavailableMonitors.delete(id);
    this.repo.sessionEvent(id, "blocked", message.slice(0, 4000));
    await this.stopSession(id);
    return this.repo.session(id);
  }
  private async stopRuntime(threadId: string, assertCurrent?: () => unknown) {
    // BB can evict an idle runtime while refreshing the host's shell environment.
    // Its in-flight stop then loses the acknowledgement with this exact error.
    // Retrying the idempotent stop releases the existing runtime only; it never
    // resends a prompt or retries a recorder launch with an uncertain outcome.
    const waits = [200, 500];
    for (let attempt = 0; ; attempt++) {
      assertCurrent?.();
      try { await this.bb.sdk.threads.stop({ threadId }); return; }
      catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/^(?:HTTP 502: )?Runtime shutting down$/.test(message) || attempt >= waits.length) throw error;
        await delay(waits[attempt]);
      }
    }
  }
  private async stopThread(threadId: string, archive: boolean) {
    try { if (archive) await this.bb.sdk.threads.archive({ threadId }); }
    finally { await this.stopRuntime(threadId); }
  }
  private async stopSession(id: string) {
    const results = await Promise.allSettled(this.repo.threadIds(id).map((t) => this.stopThread(t.threadId, t.role === "reviewer")));
    for (const result of results) if (result.status === "rejected") this.bb.log.warn(`Could not release a session thread: ${String(result.reason)}`);
  }
  dispatch(threadId: string) {
    const session = this.repo.forThread(threadId);
    if (!session) return { action: "proceed" as const };
    try {
      if (session.status === "blocked") {
        const next = session.mode === "conversation" && !session.finishedAt && session.workerThreadId
          ? "Open the task in 247C and click Resume chat."
          : session.mode === "conversation" && session.finishedAt ? "Open the task in 247C and click Retry review or Discuss review." : "Open the task in 247C to inspect the session.";
        throw new PolicyError(`The session is blocked${session.error ? ` (${session.error})` : ""}. ${next}`);
      }
      this.current(session.id);
      const chatting = session.mode === "conversation" && ["starting", "working"].includes(session.status);
      if (!ACTIVE.has(session.status) || (!chatting && Date.now() > session.deadlineAt)) throw new PolicyError("This session has finished. Click Discuss review in the 247C dossier to continue with its context.");
      if (session.mode === "conversation" && threadId === session.workerThreadId && !chatting) throw new PolicyError("The conversation has finished. After the review, click Discuss review in the 247C dossier.");
      if (threadId !== session.workerThreadId && threadId !== session.reviewerThreadId) throw new PolicyError("This check has already finished.");
      return { action: "proceed" as const };
    } catch (error) { return { action: "reject" as const, message: error instanceof Error ? error.message : String(error) }; }
  }

  prepareDispatch(context: MessageDispatchHookContext) {
    const bootstrap = this.bootstrapDispatch(context);
    if (bootstrap) return bootstrap;
    const decision = this.dispatch(context.thread.id);
    if (decision.action !== "proceed") return decision;
    const session = this.repo.forThread(context.thread.id);
    if (!session || session.mode !== "conversation" || session.workerThreadId !== context.thread.id) return decision;
    const wait = (reason: string, sendAt = Date.now() + 1000) => ({ action: "wait" as const, reason, sendAt });
    if (this.refreshingWorkers.has(context.thread.id)) return wait("Refreshing the accepted 247C task context.");
    if (sameWorkerContext(session.workerContext, acceptedWorkerContext(this.repo, session.taskId))) return decision;
    if (context.attempt === "join-turn" || ["active", "starting", "stopping"].includes(context.thread.status)) {
      return wait("The task changed. Context will refresh after the current turn finishes.");
    }
    const retryAt = this.refreshRetryAt.get(context.thread.id) ?? 0;
    if (retryAt > Date.now()) return wait("The task context could not be refreshed yet. Retrying automatically.", retryAt);
    // Queue the original message while releasing the idle runtime. Keeping this
    // outside the hook's awaited decision avoids BB's short hook timeout. No
    // extra prompt is sent, and the existing provider conversation is resumed.
    const refresh = this.refreshWorker(session).catch(() => {
      if (!this.disposed) {
        this.refreshRetryAt.set(context.thread.id, Date.now() + 30000);
        this.bb.log.warn(`Could not refresh the accepted task context for ${context.thread.id}; the message remains queued for retry.`);
      }
    }).finally(() => { this.refreshingWorkers.delete(context.thread.id); });
    this.refreshingWorkers.set(context.thread.id, refresh);
    return wait("Refreshing the accepted 247C task context.");
  }

  private async refreshWorker(session: Session) {
    const threadId = session.workerThreadId!;
    const thread = await this.bb.sdk.threads.get({ threadId });
    if (this.disposed || !["idle", "error", "pending"].includes(thread.status)) return;
    const stillChatting = () => {
      if (this.disposed) return false;
      const current = this.repo.session(session.id);
      return current.workerThreadId === threadId && current.mode === "conversation" && ["starting", "working"].includes(current.status);
    };
    if (!stillChatting()) return;
    // A pending empty chat has no resident runtime. Stopping it would cancel
    // initial provisioning; its first start already receives fresh instructions.
    if (thread.status !== "pending") await this.stopRuntime(threadId, () => {
      if (!stillChatting()) throw new PolicyError("The conversation ended during context refresh.");
    });
    if (!stillChatting()) return;
    const current = this.repo.session(session.id);
    this.repo.saveSession({ ...current, workerContext: acceptedWorkerContext(this.repo, current.taskId) });
    this.refreshRetryAt.delete(threadId);
  }

  recordDossierRead(threadId: string, inputCursor: string | undefined, response: string) {
    const session = this.repo.forThread(threadId);
    if (!session || session.workerThreadId !== threadId || session.mode !== "conversation" || !["starting", "working"].includes(session.status)) return;
    const page = JSON.parse(response) as { section: string; format: string; snapshot: string; nextCursor: string | null; offset?: number; revision: number; sourceRevision: number };
    if (!["context", "accepted"].includes(page.section)) return;
    const pending = this.pendingWorkerReads.get(threadId);
    const sequential = inputCursor === undefined
      ? page.format === "json" || page.offset === 0
      : pending?.snapshot === page.snapshot && pending.nextCursor === inputCursor;
    this.pendingWorkerReads.delete(threadId);
    if (!sequential) return;
    if (page.nextCursor !== null) {
      this.pendingWorkerReads.set(threadId, { snapshot: page.snapshot, nextCursor: page.nextCursor });
      return;
    }
    this.repo.saveSession({ ...session, workerDossierRead: {
      taskRevision: page.revision, sourceRevision: page.sourceRevision, readAt: new Date().toISOString(),
    } });
  }
  async dispose() {
    this.disposed = true;
    this.unavailableMonitors.clear();
    this.pendingWorkerReads.clear();
    for (const session of this.repo.active()) {
      if (session.mode === "conversation" && ["starting", "working"].includes(session.status)) continue;
      if (session.mode === "conversation") {
        this.repo.saveSession({ ...session, status: "blocked", error: "The review was interrupted by a plugin reload. The conversation is saved; click Retry review." });
        await this.stopSession(session.id);
        continue;
      }
      this.repo.saveSession({ ...session, status: "blocked", error: "The plugin was reloaded or disabled. Chats and results are preserved; start a new session from the dossier." });
      await this.stopSession(session.id);
    }
  }
}
