import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import { pathToFileURL } from "node:url";
import { ZodError } from "zod";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { nativeRequest, resultSchema, reviewSchema, type Extraction, type ObservedArtifact, type Review, type Session, type SettingsView, type StartInput, type WorkerResult } from "./contracts.js";
import { ACTIVE, Repository, digest } from "./repository.js";
import { PolicyError } from "./core/errors.js";
import type { ProposalEvidence, StewardChanges, TaskRecord } from "./core/types.js";
import { workerInstructions, reviewInstructions, repairInstructions, extractionInstructions } from "./prompts.js";
import { continueTranscript, extractionProposal, readConversation, validateExtraction } from "./conversation.js";
import { allowedRecorder, selectRecorder } from "./recorder.js";
import { readSavedRecorder } from "./recorder-recovery.js";
import { ThreadRouting } from "./thread-routing.js";

const FAILED = new Set(["error", "failed", "archived", "deleted"]);
const forbiddenPath = new Set([".git", ".bb", ".codex", ".claude", ".agents", ".ssh", ".env", ".npmrc", "node_modules", ".247c"]);

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
  private disposed = false;
  constructor(readonly bb: BbPluginApi, readonly repo: Repository, readonly settings: () => Promise<SettingsView>, readonly threadRouting = new ThreadRouting(bb, async () => "")) {}

  private current(id: string): Session {
    const session = this.repo.session(id);
    if (this.disposed || !ACTIVE.has(session.status)) throw new PolicyError("The session has already stopped.");
    if (session.mode === "conversation" && ["starting", "working", "collecting"].includes(session.status) && !(session.status === "collecting" && session.extractionRepair)) {
      if (!session.continuedFrom && this.repo.kernel.getTask(session.taskId).status !== "open") throw new PolicyError("The task is already closed.");
    } else this.repo.assertCurrent(session.taskId, session.baseRevision, !session.continuedFrom);
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

  async start(input: StartInput): Promise<Session> {
    const existing = this.repo.db.prepare("SELECT id FROM sessions WHERE id=?").get(input.requestId);
    if (existing) {
      const original = this.repo.sessionRequest(input.requestId) as { startFingerprint?: string };
      if (original.startFingerprint !== digest(input)) throw new PolicyError("The launch key has already been used for a different assignment.");
      return this.repo.session(input.requestId);
    }
    this.repo.assertCurrent(input.taskId, input.revision, !input.continueSessionId);
    const discussion = this.discussionSource(input);
    if (this.repo.active().some((s) => s.taskId === input.taskId)) throw new PolicyError("This task already has a worker.");
    if (input.request.input.some((i) => i.type !== "text")) throw new PolicyError("This version requires text input. Reference any necessary files within the selected workspace in the task description.");
    const objective = input.request.input.filter((i) => i.type === "text").map((i) => i.text).join("\n").trim();
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
      this.bb.sdk.providers.models({ ...routing, providerId: reviewerProvider }),
      this.bb.sdk.providers.models({ ...routing, providerId: input.request.providerId }),
    ]);
    if (![input.request.providerId, reviewerProvider].every((id) => providers.some((p) => p.id === id && p.available))) throw new PolicyError(mode === "conversation" ? "The selected account is unavailable on this machine." : "Both Codex and Claude Code must be available on the selected machine to start.");
    if (reviewerCatalog.modelLoadError || !reviewerCatalog.models.some((m) => m.model === reviewerModel || m.id === reviewerModel)) throw new PolicyError(`Verification model ${reviewerModel} is unavailable. Another model will not be substituted automatically.`);
    if (workerCatalog.modelLoadError || !workerCatalog.models.some((m) => m.model === input.request.model || m.id === input.request.model)) throw new PolicyError("The selected worker model is unavailable.");
    const timestamp = new Date().toISOString();
    let session: Session = { id: input.requestId, taskId: input.taskId, baseRevision: input.revision, status: "starting", objective, criteria: input.criteria, mode, finishedAt: null, extraction: null, extractionRepair: null,
      continuedFrom: discussion?.session.id ?? null, discussionProposalId: discussion?.proposal?.id ?? null,
      workerThreadId: null, reviewerThreadId: null, environmentId: null, hostId: null, workerProvider: input.request.providerId, workerModel: input.request.model,
      reviewerProvider, reviewerModel, reviewerReasoning: input.request.reasoningLevel, round: 0, maximumRepairs: options.maximumRepairs, createdAt: timestamp, updatedAt: timestamp,
      deadlineAt: Date.now() + options.sessionMinutes * 60000, error: null, result: null, artifacts: [], review: null, proposalId: null };
    this.repo.store.transaction(() => {
      this.repo.assertCurrent(input.taskId, input.revision, !input.continueSessionId);
      const latest = this.discussionSource(input);
      if (latest?.proposal?.id !== discussion?.proposal?.id || latest?.proposal?.status !== discussion?.proposal?.status) throw new PolicyError("The review changed. Refresh the dossier before discussing it.");
      if (this.repo.active().some((s) => s.taskId === input.taskId)) throw new PolicyError("This task already has a worker.");
      this.repo.insertSession(session, { request, startFingerprint: digest(input) });
      this.repo.sessionEvent(session.id, "contract", mode === "conversation" ? "Task conversation started; the user ends it with the finish button." : "The assignment and acceptance criteria were saved.", input);
    });
    this.processing.add(session.id);
    try {
      const thread = await this.bb.sdk.threads.spawn({ ...request,
        title: `247C · worker · ${session.id}`, visibility: "visible",
        input: [...request.input, { type: "text", text: workerInstructions(session, this.repo.detail(session.taskId), discussion), mentions: [], visibility: "agent-only" }],
      });
      session = this.repo.saveSession({ ...this.repo.session(session.id), workerThreadId: thread.id, environmentId: thread.environmentId });
      if (!ACTIVE.has(session.status) || this.disposed) { await this.stopThread(thread.id, false); return session; }
      session = this.repo.saveSession({ ...session, status: "working" });
      this.repo.sessionEvent(session.id, "worker-started", "Worker started in BB.", { threadId: thread.id });
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
    if (!env.hostId || !env.path || !env.path.startsWith("/")) throw new PolicyError("An available macOS or Linux workspace is required.");
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
      if (item.path.includes("\\") || item.path.includes("\0")) throw new PolicyError("Invalid artifact path.");
      const path = posix.resolve(root, item.path);
      const relative = posix.relative(root, path);
      if (!relative || relative.startsWith("../") || relative === ".." || posix.isAbsolute(relative)) throw new PolicyError("The artifact is outside the session workspace.");
      if (relative.split("/").some((part) => forbiddenPath.has(part) || part.startsWith(".env.") || /\.(pem|key|p12|pfx)$/i.test(part))) throw new PolicyError("This file is not suitable for verification.");
      if (seen.has(path)) throw new PolicyError("The artifact is listed twice.");
      seen.add(path);
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
        await this.bb.sdk.threads.stop({ threadId: session.workerThreadId! });
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
      return { workerModel, ...selectRecorder(catalogs, { providerId: session.workerProvider, model: workerModel }, failed) };
    }
    // Compatibility for already-open clients using the former manual selector.
    const reviewerProvider = choice === "personal-claude" ? "claude-code" : session.workerProvider;
    const reviewerModel = choice === "personal-claude" ? options.claudeReviewer : workerModel;
    const [providers, catalog] = await Promise.all([this.bb.sdk.providers.list(routing), this.bb.sdk.providers.models({ ...routing, providerId: reviewerProvider })]);
    const model = catalog.models.find((m) => m.id === reviewerModel || m.model === reviewerModel);
    if (!providers.some((p) => p.id === reviewerProvider && p.available) || catalog.modelLoadError || !model) throw new PolicyError(`Review model unavailable: ${reviewerModel}. Choose another account or model.`);
    if (!allowedRecorder(reviewerProvider, model)) throw new PolicyError(`Model ${reviewerModel} is excluded from review. Retry finishing with automatic model selection.`);
    const desired = choice === "personal-claude" ? "medium" : execution?.reasoningLevel ?? "medium";
    const reviewerReasoning = model.supportedReasoningEfforts?.length && !model.supportedReasoningEfforts.some((e) => e.reasoningEffort === desired) ? model.defaultReasoningEffort : desired;
    return { workerModel, reviewerProvider, reviewerModel, reviewerReasoning, selectionReason: `Review model selected manually: ${reviewerModel} (${reviewerProvider}).` };
  }

  async finish(id: string, recorder: "auto" | "same" | "personal-claude" = "auto") {
    let session = this.repo.session(id);
    if (session.mode !== "conversation") throw new PolicyError("This session was created with acceptance criteria and uses the earlier verification workflow.");
    if (session.finishedAt || !ACTIVE.has(session.status)) return session;
    if (session.status !== "working" || !session.workerThreadId || this.processing.has(id)) throw new PolicyError("The chat is still starting. You will be able to finish it in a few seconds.");
    const options = await this.settings();
    const { selectionReason, ...selection } = await this.chooseRecorder(session, recorder, options);
    session = this.repo.session(id);
    if (session.finishedAt || !ACTIVE.has(session.status)) return session;
    // Freeze dispatch before awaiting anything that can deliver an idle event.
    session = this.repo.saveSession({ ...this.current(id), ...selection, status: "collecting", finishedAt: new Date().toISOString(), deadlineAt: Date.now() + options.sessionMinutes * 60000 });
    this.repo.sessionEvent(id, "conversation-finished", "The user ended the conversation; a separate review is starting.");
    this.repo.sessionEvent(id, "recorder-selected", selectionReason, selection);
    this.processing.add(id);
    try { await this.bb.sdk.threads.stop({ threadId: session.workerThreadId! }); }
    catch (error) { await this.block(id, error); }
    finally { this.processing.delete(id); }
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
    this.repo.assertCurrent(task.id, task.revision, !session.continuedFrom);
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
        extraction = validateExtraction(parseJsonResult(saved.output, 512 * 1024), transcript);
        proposalInput = extractionProposal(extraction, session, dossier, transcript);
      } catch (error) {
        if (error instanceof PolicyError || error instanceof ZodError) continue;
        throw error;
      }
      const current = this.repo.session(session.id);
      if (this.disposed || current.status !== "blocked" || current.updatedAt !== session.updatedAt) throw new PolicyError("The session changed during revalidation.");
      this.repo.assertCurrent(session.taskId, session.baseRevision, !session.continuedFrom);
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
      session = this.repo.saveSession({ ...session, ...(worker ? { workerThreadId: found.id, environmentId: found.environmentId, status: "working" as const } : { reviewerThreadId: found.id, status: "reviewing" as const }) });
    }
    if (session.status === "working") {
      const thread = await this.bb.sdk.threads.get({ threadId: session.workerThreadId! });
      await this.nameWorkerThread(session, thread);
      if (thread.archivedAt || thread.deletedAt) throw new PolicyError("The work chat was archived. The transcript is preserved.");
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
      this.repo.assertCurrent(session.taskId, session.baseRevision, !session.continuedFrom);
      let extraction: Extraction;
      let proposalInput: ReturnType<typeof extractionProposal>;
      try {
        extraction = validateExtraction(parseJsonResult(output.output, 512 * 1024), transcript);
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
    this.repo.assertCurrent(session.taskId, session.baseRevision, !session.continuedFrom);
    const feedback = error.message.slice(0, 4000);
    // Reuse the frozen transcript and the existing deadline. A fresh round
    // avoids duplicate dispatch and retains every failed response in history.
    this.repo.saveSession({ ...this.current(session.id), ...selection, status: "collecting", reviewerThreadId: null, round: session.round + 1,
      extractionRepair: { attempt, feedback }, error: null });
    this.repo.sessionEvent(session.id, "extraction-repair", `Automatic review repair ${attempt}/${limit}: ${feedback}`, { threadId: session.reviewerThreadId, attempt });
    this.repo.sessionEvent(session.id, "recorder-selected", selectionReason, selection);
  }

  private async beginExtraction(session: Session) {
    const thread = await this.bb.sdk.threads.get({ threadId: session.workerThreadId! });
    if (["active", "starting", "stopping", "pending"].includes(thread.status)) return;
    await this.bb.sdk.threads.stop({ threadId: thread.id });
    let transcript = this.repo.transcript(session.id);
    if (!transcript) {
      const current = await readConversation(this.bb, session);
      const previous = session.continuedFrom ? this.repo.transcript(session.continuedFrom) : null;
      if (session.continuedFrom && !previous) throw new PolicyError("The transcript of the session being discussed was not found.");
      transcript = previous ? continueTranscript(previous, current) : current;
    }
    this.current(session.id);
    this.repo.saveTranscript(session.id, transcript);
    const env = await this.bindEnvironment(session);
    const dossier = this.repo.detail(session.taskId);
    this.repo.assertCurrent(dossier.task.id, dossier.task.revision, !session.continuedFrom);
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
    if (!extraction.changes && !extraction.facts.length && !extraction.knowledge.length) {
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
      for (const a of session.artifacts) merged.set(pathToFileURL(a.path).href, { label: a.label, uri: pathToFileURL(a.path).href });
      const allArtifacts = [...merged.values()];
      if (allArtifacts.length > 20) throw new PolicyError("The dossier contains too many artifacts for one proposal. The summary needs manual review.");
      for (const [i, a] of allArtifacts.entries()) additionalEvidence.push({ ref: `session:${session.id}:artifact:${i}`, kind: "artifact", text: a.label, source: session.artifacts.some((x) => pathToFileURL(x.path).href === a.uri) ? `host-observation:${session.id}` : "previously-accepted-projection", sourceRef: a.uri });
      changes.artifacts = { value: allArtifacts, evidenceRefs: additionalEvidence.filter((e) => e.kind === "artifact").map((e) => e.ref) };
    }
    this.repo.store.transaction(() => {
      this.current(session.id);
      const proposal = this.repo.kernel.createProposal({ taskId: session.taskId, baseRevision: session.baseRevision, model: `${session.workerModel} / review:${session.reviewerModel}`, output: { rationale: `The session result was checked against ${session.criteria.length} criteria. Verification covers the response and the listed text files.`, confidence: 0.8, changes }, additionalEvidence, idempotencyKey: `session:${session.id}` });
      this.repo.saveSession({ ...session, status: "awaiting_approval", proposalId: proposal.id });
      this.repo.sessionEvent(session.id, "proposal", "Dossier changes await your approval.", { proposalId: proposal.id });
    });
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
    if (task.status !== "open") await this.archiveFinishedThreads(task.id);
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
        if (this.disposed || (currentSession && ACTIVE.has(currentSession.status)) || (task.status === "open" && !acceptedSession) || task.revision !== pending.revision) continue;
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
    await this.stopSession(id);
    return this.repo.session(id);
  }
  async block(id: string, error: unknown) {
    const session = this.repo.session(id);
    if (!ACTIVE.has(session.status)) return session;
    const message = error instanceof Error ? error.message : String(error);
    this.repo.saveSession({ ...session, status: "blocked", error: message.slice(0, 4000) });
    this.repo.sessionEvent(id, "blocked", message.slice(0, 4000));
    await this.stopSession(id);
    return this.repo.session(id);
  }
  private async stopThread(threadId: string, archive: boolean) {
    try { if (archive) await this.bb.sdk.threads.archive({ threadId }); }
    finally { await this.bb.sdk.threads.stop({ threadId }); }
  }
  private async stopSession(id: string) {
    const results = await Promise.allSettled(this.repo.threadIds(id).map((t) => this.stopThread(t.threadId, t.role === "reviewer")));
    for (const result of results) if (result.status === "rejected") this.bb.log.warn(`Could not release a session thread: ${String(result.reason)}`);
  }
  dispatch(threadId: string) {
    const session = this.repo.forThread(threadId);
    if (!session) return { action: "proceed" as const };
    try {
      this.current(session.id);
      const chatting = session.mode === "conversation" && ["starting", "working"].includes(session.status);
      if (!ACTIVE.has(session.status) || (!chatting && Date.now() > session.deadlineAt)) throw new PolicyError("This session has finished. Click Discuss review in the 247C dossier to continue with its context.");
      if (session.mode === "conversation" && threadId === session.workerThreadId && !chatting) throw new PolicyError("The conversation has finished. After the review, click Discuss review in the 247C dossier.");
      if (threadId !== session.workerThreadId && threadId !== session.reviewerThreadId) throw new PolicyError("This check has already finished.");
      return { action: "proceed" as const };
    } catch (error) { return { action: "reject" as const, message: error instanceof Error ? error.message : String(error) }; }
  }
  async dispose() {
    this.disposed = true;
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
