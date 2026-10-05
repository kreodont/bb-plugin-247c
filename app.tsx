import { useReviewFailures, ReviewFailureBadge, ReviewFailureNotification, ReviewFailuresPage } from "./review-failures-ui.js";
import { isLiveTask, statusNeedsStoppedSession, taskStatusNames } from "./task-status.js";
import { ReportedEditor } from "./reported-editor.js";
import { UxScope, UxOverlay, UxPageView } from "./ux-app.js";
import { useUxRpc } from "./ux-app.js";
import { CustomerEditor, customerChoices, customerKey } from "./customer-ui.js";
import { SourceCoverageCard } from "./source-coverage-ui.js";
import { useUpdaterHealth, UpdaterHealthBanner, UpdaterHealthBadge, UpdaterHealthNotification } from "./updater-health-ui.js";
import { PlanningTimeZone, usePlanningTimeZone } from "./day-zone.js";
import { proposalParts, sourceParts } from "./proposal-parts.js";
import { usePartSelection, PartReviewNote, partOutcome } from "./review-parts-ui.js";
import { TaskViewMarker } from "./task-view-marker.js";
import { TaskSources } from "./task-sources-ui.js";
import { sourceUrl } from "./task-sources.js";
import { mountSidebarShortcut } from "./sidebar-shortcut.js";
import { TaskSwitcher, openTaskSwitcher } from "./task-switcher.js";
import { PagePinnedFiles, ThreadPinnedFiles } from "./pinned-files-ui.js";
import { NavigationFrame } from "./navigation.js";
import { deskRoute, taskDayPath, taskProposalPath, taskReviewPath, withThread } from "./desk-routes.js";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ComponentProps, FormEvent, ReactNode } from "react";
import { definePluginApp, useRealtime, useRealtimeConnectionState, useBbNavigate, ThreadChat, Markdown, experimental_NewThreadComposer as NewThreadComposer, experimental_FileLink as FileLink } from "@get-bb/plugin-sdk/app";
import type { NewThreadRequest, PluginNavPanelProps, PluginThreadHeaderActionProps } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract, TaskCard, Dossier, Session, StartInput, KnowledgeEntry, SyncCandidate, SyncSource, SyncRun, ReviewDossier, ReviewItem, ReviewSelection } from "./contracts.js";
import { Button } from "./components/ui/button.js";
import { Input } from "./components/ui/input.js";
import { Icon } from "./components/ui/icon.js";
import { cn } from "./lib/utils.js";
import { CalendarStatus, DayPage, TaskTimeSummary } from "./day-app.js";
import { dayDateSchema, formatMinutes, localDay, DAY_TIME_ZONE } from "./day-contracts.js";

const ACTIVE = new Set(["starting", "working", "collecting", "review_starting", "reviewing", "repair_starting"]);
const statusNames: Record<Session["status"], string> = { starting: "Starting", working: "In progress", collecting: "Reading the result", review_starting: "Starting verification", reviewing: "Independent verification", repair_starting: "Addressing findings", awaiting_approval: "Awaiting your decision", applied: "Dossier updated", rejected: "Proposal rejected", blocked: "Needs attention", cancelled: "Stopped", completed: "Review completed" };
function sessionLabel(session: Pick<Session, "mode" | "status"> & Partial<Pick<Session, "extractionRepair">>): string {
  if (session.mode !== "conversation") return statusNames[session.status];
  if (session.extractionRepair && ["collecting", "review_starting", "reviewing"].includes(session.status)) return "Correcting the review";
  return ({ working: "Conversation open", collecting: "Saving the conversation", review_starting: "Starting the review", reviewing: "Reviewing the conversation", applied: "Records saved" } as Partial<Record<Session["status"], string>>)[session.status] ?? statusNames[session.status];
}
const factNames: Record<Dossier["facts"][number]["kind"], string> = { description: "Context", progress: "Progress", user_instruction: "Instruction", explicit_next_step: "Next step", decision: "Decision", open_question: "Question", artifact: "Artifact", constraint: "Constraint", blocker: "Blocker" };
const fieldNames = { customer: "Customer", title: "Title", urgent: "Urgency", important: "Importance", status: "Task status", summary: "Summary", nextStep: "Next step", openQuestions: "Open questions", blockers: "Blockers", artifacts: "Artifacts" };
const groups = [
  { key: "focus", title: "Do now", subtitle: "Urgent and important", card: "border-red-500/25 border-l-red-500 bg-red-500/10 hover:bg-red-500/15", selected: "bg-red-500/15 ring-2 ring-inset ring-red-500/50", dot: "bg-red-500" },
  { key: "delegate", title: "Delegate", subtitle: "Urgent, less important", card: "border-orange-500/25 border-l-orange-500 bg-orange-500/10 hover:bg-orange-500/15", selected: "bg-orange-500/15 ring-2 ring-inset ring-orange-500/50", dot: "bg-orange-500" },
  { key: "plan", title: "Schedule", subtitle: "Important, not urgent", card: "border-yellow-500/25 border-l-yellow-500 bg-yellow-500/10 hover:bg-yellow-500/15", selected: "bg-yellow-500/15 ring-2 ring-inset ring-yellow-500/50", dot: "bg-yellow-500" },
  { key: "later", title: "For later", subtitle: "Neither urgent nor important", card: "border-green-500/25 border-l-green-500 bg-green-500/10 hover:bg-green-500/15", selected: "bg-green-500/15 ring-2 ring-inset ring-green-500/50", dot: "bg-green-500" },
  { key: "waiting", title: "Waiting for response", subtitle: "Waiting on someone else", card: "border-sky-400/30 border-l-sky-400 bg-sky-400/10 hover:bg-sky-400/15", selected: "bg-sky-400/15 ring-2 ring-inset ring-sky-400/50", dot: "bg-sky-400" },
  { key: "inbox", title: "Classify", subtitle: "Priority not yet set", card: "border-border bg-card hover:bg-muted/50", selected: "bg-muted/50 ring-2 ring-inset ring-border", dot: "bg-muted-foreground" },
] as const;
type GroupKey = typeof groups[number]["key"];
const priorityGroupFor = (task: TaskCard): GroupKey => task.planning.urgent === null || task.planning.important === null ? "inbox" : task.planning.urgent ? task.planning.important ? "focus" : "delegate" : task.planning.important ? "plan" : "later";
const groupFor = (task: TaskCard): GroupKey => task.status === "waiting" ? "waiting" : priorityGroupFor(task);
type TaskSort = "updated" | "oldest" | "priority";
const TASK_SORT_KEY = "247c:task-sort";
function savedTaskSort(): TaskSort {
  try {
    const value = window.localStorage.getItem(TASK_SORT_KEY);
    return value === "oldest" || value === "priority" ? value : "updated";
  } catch { return "updated"; }
}
const date = (value: string) => new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
// A pulse means an agent is running. An open conversation waiting for the user is not.
const cardSessionLabel = (task: Pick<TaskCard, "activeSessionBusy" | "activeSessionSince">) => task.activeSessionBusy ? "Session running" : task.activeSessionSince ? `Chat open since ${date(task.activeSessionSince)}` : "Chat open";
const textareaClass = "w-full resize-y rounded-lg border border-input bg-transparent px-3 py-2 text-sm leading-relaxed placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50";
const sourceNames: Record<SyncSource, string> = { gmail: "Gmail", slack: "Slack", jira: "Jira", teams: "Teams", outlook: "Outlook", clickup: "ClickUp" };
const syncStatusNames: Record<SyncRun["status"], string> = { starting: "Starting", working: "Checking sources", completed: "Check completed", partial: "Partially checked", blocked: "Check interrupted", cancelled: "Stopped" };
const syncActive = (run?: SyncRun) => Boolean(run && ["starting", "working"].includes(run.status));

function ErrorNotice({ error, retry }: { error: string | null; retry?: () => void }) {
  if (!error) return null;
  return <div role="alert" className="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm"><Icon name="AlertCircle" className="mt-0.5 size-4 shrink-0 text-destructive" /><p className="min-w-0 flex-1 whitespace-pre-wrap break-words">{error}</p>{retry && <Button size="sm" variant="ghost" onClick={retry}>Refresh</Button>}</div>;
}
function Pill({ children, attention = false }: { children: ReactNode; attention?: boolean }) {
  return <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs", attention ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground")}>{children}</span>;
}

function useSnapshot<T>(load: () => Promise<T>) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const mounted = useRef(true);
  const connection = useRealtimeConnectionState();
  const refresh = useCallback(async () => {
    const sequence = ++generation.current;
    try {
      const value = await load();
      if (mounted.current && sequence === generation.current) { setData(value); setError(null); }
    } catch (cause) { if (mounted.current && sequence === generation.current) setError(cause instanceof Error ? cause.message : String(cause)); }
  }, [load]);
  useEffect(() => { mounted.current = true; void refresh(); return () => { mounted.current = false; generation.current++; }; }, [refresh, connection]);
  useRealtime("desk-changed", refresh);
  useEffect(() => {
    const focus = () => { if (document.visibilityState !== "hidden") void refresh(); };
    window.addEventListener("focus", focus);
    document.addEventListener("visibilitychange", focus);
    const timer = setInterval(focus, 10000);
    return () => { clearInterval(timer); window.removeEventListener("focus", focus); document.removeEventListener("visibilitychange", focus); };
  }, [refresh]);
  return { data, error, refresh };
}

function ProjectThreadComposer({ purpose = "work", ...props }: ComponentProps<typeof NewThreadComposer> & { purpose?: "work" | "sync" }) {
  const rpc = useUxRpc();
  const load = useCallback(() => rpc.call("threadProject", {}), [rpc]);
  const { data, error, refresh } = useSnapshot(load);
  if (error) return <ErrorNotice error={error} retry={() => void refresh()} />;
  if (!data) return <p role="status" className="text-sm text-muted-foreground">Loading conversation settings…</p>;
  return <NewThreadComposer {...props} defaultProviderId={data.providerId ?? props.defaultProviderId ?? ((purpose === "work" ? data.workProvider : data.syncProvider) || undefined)} defaultModel={data.model ?? props.defaultModel ?? ((purpose === "work" ? data.workModel : data.syncModel) || undefined)} defaultProjectId={data.projectId ?? undefined} defaultEnvironment={data.projectId ? { type: "project-default" } : undefined} onSubmit={request => props.onSubmit({ ...request, executionInputSources: { ...request.executionInputSources, providerId: "explicit", model: "explicit" } })} />;
}

function ThreadSessionControl({ threadId, isCompactViewport, action }: PluginThreadHeaderActionProps & { action: "task" | "finish" }) {
  const rpc = useUxRpc();
  const navigate = useBbNavigate();
  const load = useCallback(() => rpc.call("threadSession", { threadId }), [rpc, threadId]);
  const { data, error, refresh } = useSnapshot(load);
  const [busy, setBusy] = useState(false);
  const finishing = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const session = data?.session;
  if (!session) return null;

  const canFinish = session.mode === "conversation" && session.workerThreadId === threadId && session.status === "working";
  const failedReview = session.mode === "conversation" && session.status === "blocked" && Boolean(session.finishedAt);
  const reviewing = session.workerThreadId === threadId && ["collecting", "review_starting", "reviewing"].includes(session.status);
  const reviewThreadId = session.status === "reviewing" ? session.reviewerThreadId : null;
  if (action === "finish" && !canFinish && !failedReview && !reviewing) return null;
  const label = action === "task" ? "Open task" : failedReview ? "Review failed" : reviewing ? reviewThreadId ? "Open review" : "Starting review…" : busy ? "Finishing…" : error ? "Refresh session" : "Finish session";
  async function finish() {
    if (!session || finishing.current) return;
    finishing.current = true; setBusy(true);
    try { await rpc.call("finish", { sessionId: session.id }); }
    catch (cause) { toast.error("Could not finish the session", { description: cause instanceof Error ? cause.message : String(cause) }); }
    finally { await refresh(); finishing.current = false; setBusy(false); }
  }
  async function openReview() {
    if (finishing.current) return;
    finishing.current = true; setBusy(true);
    try {
      // A repair or retry may have replaced the recorder since the last event.
      const current = (await rpc.call("threadSession", { threadId })).session;
      if (mounted.current && current?.workerThreadId === threadId && current.status === "reviewing" && current.reviewerThreadId && current.reviewerThreadId !== threadId) navigate.toThread(current.reviewerThreadId);
    } catch (cause) { if (mounted.current) toast.error("Could not open the review", { description: cause instanceof Error ? cause.message : String(cause) }); }
    finally { await refresh(); finishing.current = false; setBusy(false); }
  }
  return <UxScope page="thread" view={threadId}><span title={label} className="inline-flex"><Button data-c247-ux-action={action === "task" ? "thread-task" : reviewing ? "thread-review" : "thread-finish"} type="button" size="sm" variant="outline"
    className={cn("h-7 shrink-0", action === "finish" && failedReview && "border-destructive/40 text-destructive", isCompactViewport ? "w-7 px-0" : "px-2")}
    aria-label={label} aria-description={action === "task" ? "Open the linked 247C task dossier" : failedReview ? "Open the failed conversation review" : reviewing ? "Open the chat reviewing this conversation" : "Stop the current response and review the conversation"}
    disabled={action === "finish" && (busy || (reviewing && !reviewThreadId))} onClick={() => { if (action === "task") navigate.toPluginPanel("desk", { subPath: withThread(session.taskId, threadId) }); else if (failedReview) navigate.toPluginPanel("desk", { subPath: taskReviewPath(session.taskId, session.id, threadId) }); else if (reviewing) void openReview(); else if (error) void refresh(); else void finish(); }}>
    <Icon name={action === "task" ? "Target" : failedReview ? "AlertCircle" : reviewing ? reviewThreadId ? "MessageSquare" : "Loading" : "Check"} aria-hidden="true" />{!isCompactViewport && label}
  </Button></span></UxScope>;
}

function ThreadSessionAction(props: PluginThreadHeaderActionProps) {
  return <ThreadSessionControl key={props.threadId} {...props} action="finish" />;
}

function ThreadTaskAction(props: PluginThreadHeaderActionProps) {
  return <ThreadSessionControl key={props.threadId} {...props} action="task" />;
}

function ThreadSwitchAction({ threadId, isCompactViewport }: PluginThreadHeaderActionProps) {
  return <UxScope page="thread" view={threadId}><span title="Switch task (Cmd+Shift+K)" className="inline-flex"><Button type="button" size="sm" variant="outline"
    data-c247-ux-action="task-switch" aria-label="Switch task" aria-description="Open the work chat of another 247C task"
    className={cn("h-7 shrink-0", isCompactViewport ? "w-7 px-0" : "px-2")} onClick={openTaskSwitcher}>
    <Icon name="Layers" aria-hidden="true" />{!isCompactViewport && "Tasks"}
  </Button></span></UxScope>;
}
function TaskSwitcherOverlay() {
  return <TaskSwitcher dotFor={task => groups.find(g => g.key === groupFor(task))!.dot} updated={date} />;
}

function ThreadProposal({ threadId, isCompactViewport }: PluginThreadHeaderActionProps) {
  const rpc = useUxRpc(), navigate = useBbNavigate();
  const load = useCallback(() => rpc.call("threadSession", { threadId }), [rpc, threadId]);
  const { data } = useSnapshot(load);
  const session = data?.session;
  if (!session?.proposalId) return null;
  return <UxScope page="thread" view={threadId}><span title="Open this session's proposal" className="inline-flex"><Button type="button" size="sm" variant="outline"
    data-c247-ux-action="thread-proposal" aria-label="Proposal" aria-description="Open this session's proposal"
    className={cn("h-7 shrink-0", session.status === "awaiting_approval" && "border-orange-500/40 text-orange-700 dark:text-orange-300", isCompactViewport ? "w-7 px-0" : "px-2")}
    onClick={() => navigate.toPluginPanel("desk", { subPath: taskProposalPath(session.taskId, session.id, threadId) })}>
    <Icon name="ListTodo" aria-hidden="true" />{!isCompactViewport && "Proposal"}
  </Button></span></UxScope>;
}

function ThreadProposalAction(props: PluginThreadHeaderActionProps) {
  return <ThreadProposal key={props.threadId} {...props} />;
}

function ThreadSource({ threadId, isCompactViewport }: PluginThreadHeaderActionProps) {
  const rpc = useUxRpc();
  const load = useCallback(() => rpc.call("threadSource", { threadId }), [rpc, threadId]);
  const { data, error } = useSnapshot(load);
  const source = data?.source;
  if (error || !source || !sourceUrl(source.url)) return null;
  return <UxScope page="thread" view={threadId}><Button asChild size="sm" variant="outline" className={cn("h-7 shrink-0", isCompactViewport ? "w-7 px-0" : "px-2")}>
    <a data-c247-ux-action="thread-source" href={source.url} target="_blank" rel="noopener noreferrer" title={`Primary source · ${source.label}\n${source.url}`} aria-label={`Open primary source: ${source.label}`}>
      <Icon name="ExternalLink" aria-hidden="true" />{!isCompactViewport && "Source"}
    </a>
  </Button></UxScope>;
}

function ThreadSourceAction(props: PluginThreadHeaderActionProps) {
  return <ThreadSource key={props.threadId} {...props} />;
}

function ThreadReportedTime({ threadId, isCompactViewport }: PluginThreadHeaderActionProps) {
  const rpc = useUxRpc();
  const navigate = useBbNavigate();
  const load = useCallback(() => rpc.call("threadSession", { threadId }), [rpc, threadId]);
  const { data, error, refresh } = useSnapshot(load);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const opening = useRef(false), mounted = useRef(true);
  const request = useRef<{ date: string; id: string } | null>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function openDay() {
    const taskId = data?.session?.taskId;
    if (!taskId || opening.current) return;
    opening.current = true; setBusy(true);
    try {
      // Resolve today at click time, even when the header was loaded before midnight.
      const day = await rpc.call("day", {});
      if (!mounted.current) return;
      if (!day.items.some(item => item.taskId === taskId)) {
        if (request.current?.date !== day.date) request.current = { date: day.date, id: crypto.randomUUID() };
        try { await rpc.call("dayAdd", { date: day.date, taskId, plannedMinutes: 0, requestId: request.current.id }); }
        catch (cause) {
          // Another window may have added the row, or the successful response was lost.
          const current = await rpc.call("day", { date: day.date });
          if (!current.items.some(item => item.taskId === taskId)) throw cause;
        }
      }
      if (mounted.current) navigate.toPluginPanel("desk", { subPath: taskDayPath(day.date, taskId, threadId) });
    } catch (cause) {
      if (mounted.current) toast.error("Could not open Day Plan", { description: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      opening.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  if (!data?.session || !data.reportedToday) return null;
  const { date, minutes, estimated, timeZone = DAY_TIME_ZONE } = data.reportedToday;
  const value = error ? "unavailable" : formatMinutes(minutes);
  const label = `Reported today: ${value}${!error && estimated ? " (estimate)" : ""}`;
  const title = error ? `Could not refresh reported time: ${error}` : `${label} · ${date} · ${timeZone}${minutes === null ? " · No reported time entered" : ""}`;
  return <UxScope page="thread" view={threadId}><span title={title} className="inline-flex items-center rounded-md border border-input">
    <Button data-c247-ux-action="reported-open" type="button" size="sm" variant="ghost" className="h-7 shrink-0 gap-1.5 px-2 text-xs text-muted-foreground" aria-label={`${label}. Edit reported time`} onClick={() => setEditing(true)}>
      {isCompactViewport ? <Icon name="Clock" aria-hidden="true" /> : <span>Reported today:</span>}
      <output aria-label={label} className="font-medium tabular-nums text-foreground">{value}</output>{!error && estimated && <span>estimate</span>}
    </Button>
    <Button data-c247-ux-action="reported-day" type="button" size="sm" variant="ghost" className="h-7 border-l border-input px-1.5" disabled={busy} aria-busy={busy} aria-label={`${label}. Open Day Plan`} aria-description="Open today's task row and edit Reported time; add the task if missing" onClick={() => void openDay()}><Icon name="ChevronRight" aria-hidden="true" /></Button>
  </span>{editing && <ReportedEditor taskId={data.session.taskId} threadId={threadId} close={() => setEditing(false)} saved={refresh} />}</UxScope>;
}

function ThreadReportedAction(props: PluginThreadHeaderActionProps) {
  return <ThreadReportedTime key={props.threadId} {...props} />;
}

function CreateTask({ done, cancel }: { done: (id: string) => void; cancel: () => void }) {
  const rpc = useUxRpc();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [primarySourceUrl, setPrimarySourceUrl] = useState("");
  const [customer, setCustomer] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(crypto.randomUUID());
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!title.trim() || busy) return;
    setBusy(true); setError(null);
    try { const task = await rpc.call("create", { title, description, ...(customer.trim() ? { customer: customer.trim() } : {}), ...(primarySourceUrl.trim() ? { primarySourceUrl: primarySourceUrl.trim() } : {}), requestId: requestId.current }); done(task.id); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }
  return <form onSubmit={submit} className="rounded-xl border border-border bg-card p-5">
    <div className="mb-4 flex items-center justify-between"><h2 className="font-medium">New task</h2><Button type="button" variant="ghost" size="icon" onClick={cancel} aria-label="Close new task form"><Icon name="X" /></Button></div>
    <label className="mb-1.5 block text-sm" htmlFor="task-title">What result do you need?</label>
    <Input id="task-title" autoFocus required maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="For example, prepare a moving plan" />
    <label className="mb-1.5 mt-4 block text-sm" htmlFor="task-customer">Customer <span className="text-muted-foreground">· optional</span></label>
    <Input id="task-customer" maxLength={200} value={customer} onChange={event => setCustomer(event.target.value)} placeholder="Customer name" />
    <label className="mb-1.5 mt-4 block text-sm" htmlFor="task-context">What should we know? <span className="text-muted-foreground">· optional</span></label>
    <textarea id="task-context" className={textareaClass} rows={3} maxLength={12000} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Why this matters, what you already know, and any constraints…" />
    <label className="mb-1.5 mt-4 block text-sm" htmlFor="task-source">Primary source <span className="text-muted-foreground">· optional</span></label>
    <Input id="task-source" type="url" maxLength={4096} value={primarySourceUrl} onChange={e => setPrimarySourceUrl(e.target.value)} placeholder="https://…" aria-describedby="task-source-help" />
    <p id="task-source-help" className="mt-1.5 text-xs text-muted-foreground">Link to the original message, issue or document. Available directly from linked threads.</p>
    <div className="mt-4"><ErrorNotice error={error} /></div>
    <div className="mt-4 flex justify-end gap-2"><Button type="button" variant="ghost" onClick={cancel} disabled={busy}>Cancel</Button><Button type="submit" disabled={busy || !title.trim()}>{busy ? "Saving…" : "Create task"}</Button></div>
  </form>;
}

type InitialPriority = { urgent: boolean; important: boolean };

function SyncCandidateCard({ candidate, currentTask, action, busy, partSelection, onPartSelection, initialPriority, priorityInHeader = false }: { initialPriority?: InitialPriority; priorityInHeader?: boolean; partSelection?: string[]; onPartSelection?: (parts: string[] | undefined) => void; candidate: SyncCandidate; currentTask?: Pick<TaskCard, "revision" | "status" | "activeSession">; action: (fn: () => Promise<unknown>) => Promise<boolean>; busy: boolean }) {
  const rpc = useUxRpc();
  const navigate = useBbNavigate();
  const [localPriority, setLocalPriority] = useState<InitialPriority>();
  const priority = priorityInHeader ? initialPriority : localPriority;
  const priorityInput = priority && !candidate.taskId ? { initialPriority: priority } : {};
  const pending = candidate.status === "pending";
  const stale = Boolean(candidate.taskId && (!currentTask || currentTask.revision !== candidate.baseRevision));
  const selection = usePartSelection(candidate.id, sourceParts(candidate), busy, onPartSelection, partSelection);
  const active = Boolean(currentTask?.activeSession && candidate.changes.status && statusNeedsStoppedSession(currentTask.status, candidate.changes.status.value) && selection.picked.includes("field:status"));
  const decide = (decision: "accept" | "reject") => action(() => selection.all
    ? decision === "accept" ? rpc.call("syncAccept", { candidateId: candidate.id, ...priorityInput }) : rpc.call("syncReject", { candidateId: candidate.id })
    : rpc.call("reviewParts", { kind: "source", id: candidate.id, revision: candidate.baseRevision, decision, parts: selection.picked, requestId: crypto.randomUUID(), ...(decision === "accept" ? priorityInput : {}) }));
  const quotes = [...new Map(candidate.facts.flatMap((f) => f.citations).map((c) => [JSON.stringify([c.source, c.messageId, c.quote]), c])).values()];
  function value(field: string, raw: unknown) {
    if (field === "status" && typeof raw === "string") return taskStatusNames[raw as keyof typeof taskStatusNames];
    if ((field === "urgent" || field === "important") && typeof raw === "boolean") return raw ? "Yes" : "No";
    return <DisplayValue value={raw} />;
  }
  return <article className="overflow-hidden rounded-xl border border-border bg-card">
    <div className="space-y-2 p-4"><div className="flex flex-wrap items-center gap-2"><Pill attention={pending}>{candidate.taskId ? "Task update" : "New task"}</Pill><span className="text-xs text-muted-foreground">{[...new Set(quotes.map((q) => sourceNames[q.source]))].join(" · ")}</span>{!pending && <span className="text-xs text-muted-foreground">{candidate.partReview ? "Reviewed in parts" : candidate.status === "applied" ? "Accepted" : candidate.status === "superseded" ? "Superseded by a new check" : "Rejected"}</span>}</div><h3 className="break-words font-medium">{candidate.title}</h3>{Boolean(candidate.mergeCandidateIds?.length) && <p className="text-xs text-muted-foreground">Includes {candidate.mergeCandidateIds!.length} earlier pending {candidate.mergeCandidateIds!.length === 1 ? "proposal" : "proposals"}. Previous versions are kept in history.</p>}<p className="whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">{candidate.rationale}</p></div>
    {pending && !candidate.taskId && !priorityInHeader && <div className="px-4 pb-4"><NewTaskPriority priority={priority} disabled={busy} change={setLocalPriority} /></div>}
    <PartReviewNote review={candidate.partReview} />{pending && selection.bar}
    <div className="divide-y divide-border border-y border-border">{Object.entries(candidate.changes).map(([field, change]) => <div key={field} className="p-4"><div className="mb-2 text-xs font-medium">{pending ? selection.checkbox(`field:${field}`, fieldNames[field as keyof typeof fieldNames]) : fieldNames[field as keyof typeof fieldNames] + partOutcome(candidate.partReview, `field:${field}`)}</div><div className={cn("grid gap-3 text-sm leading-relaxed", candidate.before && "md:grid-cols-2")}>{candidate.before && <div className="rounded-lg bg-muted/40 p-3"><p className="mb-1 text-xs text-muted-foreground">Before</p>{value(field, candidate.before[field as keyof typeof candidate.before])}</div>}<div className="rounded-lg bg-primary/5 p-3"><p className="mb-1 text-xs text-muted-foreground">After</p>{value(field, change?.value)}</div></div></div>)}</div>
    <details className="p-4"><summary className="cursor-pointer text-sm">Facts and quotes · {quotes.length}</summary><ul className="mt-3 space-y-2 text-sm">{candidate.facts.map((fact, i) => (!candidate.recordFactIndexes || candidate.recordFactIndexes.includes(i)) && <li key={i} className="whitespace-pre-wrap">{pending ? selection.checkbox(`fact:${i}`, `Record ${i + 1}: ${fact.text}`) : fact.text + partOutcome(candidate.partReview, `fact:${i}`)}</li>)}</ul><div className="mt-4 space-y-4">{quotes.map((quote, index) => <div key={index} className="border-l-2 border-border pl-3"><a href={quote.url} target="_blank" rel="noopener noreferrer" className="text-xs underline underline-offset-4">{sourceNames[quote.source]} · {date(quote.occurredAt)}</a><blockquote className="mt-1 whitespace-pre-wrap break-words text-sm leading-relaxed text-muted-foreground">{quote.quote}</blockquote></div>)}</div></details>
    <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border p-4">{(candidate.taskId ?? candidate.resultTaskId) && <Button size="sm" variant="ghost" onClick={() => navigate.toPluginPanel("desk", { subPath: candidate.taskId ?? candidate.resultTaskId! })}>Open task</Button>}{pending && <>{stale && <p className="w-full text-sm text-destructive">The dossier changed after this check. Check sources from the previous date to replace the stale proposal.</p>}{active && <p className="w-full text-sm text-muted-foreground">Finish the work session before changing the status.</p>}<Button variant="ghost" size="sm" disabled={busy || !selection.picked.length} onClick={() => void decide("reject")}>{selection.all ? "Reject update" : `Reject selected parts · ${selection.picked.length}`}</Button><Button size="sm" disabled={busy || stale || active || !selection.picked.length} onClick={() => void decide("accept")}>{!candidate.taskId ? selection.all ? "Create task from proposal" : "Create task with selected parts" : selection.all ? "Accept update" : `Accept selected parts · ${selection.picked.length}`}</Button></>}</div>
  </article>;
}

function SyncPage() {
  const { data: updater, error: updaterError, refresh: refreshUpdater } = useUpdaterHealth();
  const [launchNotice, setLaunchNotice] = useState<string | null>(null);
  const rpc = useUxRpc();
  const navigate = useBbNavigate();
  const [starting, setStarting] = useState(false);
  const [manual, setManual] = useState(false);
  const [since, setSince] = useState(() => { const d = new Date(Date.now() - 86400000); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); });
  const [history, setHistory] = useState(false);
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const requestId = useRef(crypto.randomUUID());
  const load = useCallback(async () => { const [sync, tasks] = await Promise.all([rpc.call("syncState", {}), rpc.call("list", { history: true })]); return { sync, tasks: tasks.tasks }; }, [rpc]);
  const { data, error, refresh } = useSnapshot(load);
  const latest = data?.sync.runs[0];
  const active = data?.sync.runs.find(syncActive);
  const pastRuns = updater?.configured ? data?.sync.runs ?? [] : data?.sync.runs.slice(1) ?? [];
  const candidates = data?.sync.candidates.filter((c) => history || c.status === "pending") ?? [];
  async function action(fn: () => Promise<unknown>): Promise<boolean> {
    if (locked.current) return false;
    locked.current = true; setBusy(true); setMutationError(null);
    try { await fn(); await refresh(); return true; }
    catch (cause) { setMutationError(cause instanceof Error ? cause.message : String(cause)); await refresh(); return false; }
    finally { locked.current = false; setBusy(false); }
  }
  async function startUpdater() {
    setLaunchNotice(null);
    await action(async () => {
      const result = await rpc.call("updaterStart", { requestId: requestId.current });
      requestId.current = crypto.randomUUID();
      if (result.status === "failed") throw new Error("The configured updater could not start. Check the updater status for details.");
      setLaunchNotice(result.alreadyRunning ? "The configured source check is already running."
        : result.status === "skipped" ? "The check was not started. Another run may already be in progress; see updater status."
        : "The configured source check has been started. Collection and analysis progress appear in updater status.");
    });
  }
  async function startQuickCheck() {
    setLaunchNotice(null);
    await action(async () => {
      const result = await rpc.call("syncQuickStart", { requestId: requestId.current });
      requestId.current = crypto.randomUUID();
      if (result.run.error) throw new Error(result.run.error);
      setLaunchNotice(result.alreadyRunning ? "A check is already running. Progress is shown below."
        : syncActive(result.run) ? "Check started. Progress is shown below."
        : "Check finished. Results are shown below.");
    });
  }
  async function start(request: NewThreadRequest) {
    setMutationError(null);
    try {
      if (manual && (!since || Number.isNaN(new Date(since).getTime()))) throw new Error("Choose a start date and time.");
      const run = await rpc.call("syncStart", { requestId: requestId.current, since: manual ? new Date(since).toISOString() : null, request: request as unknown as StartInput["request"] });
      requestId.current = crypto.randomUUID(); setStarting(false); await refresh();
      if (run.error) setMutationError(run.error);
    } catch (cause) { setMutationError(cause instanceof Error ? cause.message : String(cause)); throw cause; }
  }
  return <div className="h-full min-h-0 overflow-y-auto"><div className="mx-auto max-w-5xl space-y-5 p-5 md:p-8">
    <Button variant="ghost" size="sm" className="-ml-3" onClick={() => navigate.toPluginPanel("desk", { subPath: "tasks" })}><Icon name="ChevronLeft" /> All tasks</Button>
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h1 className="text-2xl font-medium">Work source updates</h1><p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">Connected work sources reveal task updates and new requests. Review the proposals and accept the ones you need.</p></div>{!starting && <div className="flex flex-wrap gap-2"><Button disabled={busy || !data || !updater || Boolean(updaterError) || updater.running || (!updater.configured && Boolean(active))} onClick={() => updater?.configured ? void startUpdater() : void startQuickCheck()}>{updater?.running || (!updater?.configured && active) ? "Check running…" : busy ? "Starting…" : "Check for updates"}</Button>{updater && !updater.configured && <Button variant="outline" disabled={busy || !data || Boolean(active) || Boolean(updaterError)} onClick={() => { setLaunchNotice(null); setMutationError(null); setStarting(true); }}>Custom check…</Button>}</div>}</div>
    <ErrorNotice error={mutationError ?? updaterError ?? error} retry={() => { refreshUpdater(); void refresh(); }} />
    {launchNotice && <p role="status" className="text-sm text-muted-foreground">{launchNotice}</p>}
    <div className="grid gap-3 md:grid-cols-3">{(updater?.sourceCoverage?.length ? updater.sourceCoverage.map(item => item.source) : Object.keys(latest?.ranges ?? { gmail: {}, slack: {}, jira: {} }) as SyncSource[]).map((source) => {
      const coverage = updater?.sourceCoverage?.find(item => item.source === source);
      if (coverage) return <SourceCoverageCard key={source} coverage={coverage} name={sourceNames[source]} date={date} />;
      const report = latest?.reports.find((r) => r.source === source);
      const checkpoint = data?.sync.checkpoints[source];
      return <section key={source} className="rounded-xl border border-border bg-card p-4"><h2 className="font-medium">{sourceNames[source]}</h2><p className="mt-2 text-xs text-muted-foreground">{checkpoint ? `Fully checked through ${date(checkpoint)}` : latest && data ? `Full coverage not confirmed since ${date(data.sync.nextSince[source])}` : "First run: last 24 hours"}</p>{latest && <><p className={cn("mt-3 text-sm", report && report.status !== "complete" && "text-destructive")}>{active ? active.collection?.phase === "collecting" ? "Loading data…" : "The model is analyzing the export…" : report?.status === "complete" ? "Checked" : report?.status === "partial" ? "Partially checked" : report?.status === "unavailable" ? "Unavailable" : syncStatusNames[latest.status]}</p>{report && <p className="mt-1 whitespace-pre-wrap break-words text-xs leading-relaxed text-muted-foreground">{report.detail}<br />Candidates: {report.scanned} · threads/issues read: {report.threadsRead}</p>}</>}</section>;
    })}</div>
    {starting && !active && !updater?.configured && <section className="space-y-4 rounded-xl border border-border p-4"><div className="flex items-center justify-between"><h2 className="font-medium">Custom check</h2><Button size="sm" variant="ghost" onClick={() => setStarting(false)}>Cancel</Button></div><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={manual} onChange={(e) => setManual(e.target.checked)} />Set a start date</label>{manual ? <div><label htmlFor="sync-since" className="mb-1.5 block text-xs text-muted-foreground">From date and time · {Intl.DateTimeFormat().resolvedOptions().timeZone}</label><Input id="sync-since" type="datetime-local" value={since} onChange={(e) => setSince(e.target.value)} /></div> : <p className="text-sm text-muted-foreground">Continue from each source's last complete check. If a source was unavailable, its missed interval will be checked.</p>}<p className="text-xs leading-relaxed text-muted-foreground">Sources will be loaded through the configured login. Choose any available model to analyze the data; you can also specify what to focus on.</p><ProjectThreadComposer purpose="sync" defaultReasoningLevel="medium" defaultPermissionMode="accept-edits" initialPrompt="Analyze email, Slack and Jira updates and prepare proposals for 247C tasks." placeholder="Additional instructions for this check" layout="document" draftKey="247c-source-sync" onSubmit={start} /></section>}
    <CalendarStatus />
    {latest && !updater?.configured && <section className="flex flex-wrap items-center gap-3 rounded-xl border border-border p-4"><Pill attention={syncActive(latest) || latest.status === "partial" || latest.status === "blocked"}>{syncStatusNames[latest.status]}</Pill><span className="mr-auto text-xs text-muted-foreground">{date(latest.startedAt)}{latest.collection && ` · ${latest.collection.phase === "collecting" && syncActive(latest) ? "loading" : "loaded"} ${latest.collection.reads} threads/issues in ${Math.round(latest.collection.elapsedMs / 1000)} s`}{latest.analysis && ` · ${latest.analysis.modelSkipped ? "no changes to analyze · model not used" : `${latest.analysis.documents} documents to analyze · ${latest.analysis.reusedDocuments} unchanged documents reused`}`} · proposals {latest.suggestions}{latest.duplicates ? ` · duplicates ${latest.duplicates}` : ""}</span>{latest.threadId && <Button size="sm" variant="outline" onClick={() => navigate.toThread(latest.threadId!)}>Check conversation</Button>}{active && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void action(() => rpc.call("syncCancel", { runId: active.id }))}>Stop check</Button>}{latest.error && <p className="w-full text-sm text-destructive">{latest.error}</p>}{latest.manualSince && <p className="w-full text-xs text-muted-foreground">From {date(latest.manualSince)} to {date(latest.until)}. A manual date later than the previous checkpoint does not advance it, so the unchecked interval is preserved.</p>}</section>}
    <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="font-medium">Pending · {data?.sync.pending ?? 0}</h2><Button variant="outline" size="sm" onClick={() => navigate.toPluginPanel("desk", { subPath: "proposals" })}>All proposals</Button><label className="flex items-center gap-2 text-sm text-muted-foreground"><input type="checkbox" checked={history} onChange={(e) => setHistory(e.target.checked)} />Show reviewed proposals</label></div>
    {candidates.map((candidate) => <SyncCandidateCard key={candidate.id} candidate={candidate} currentTask={data?.tasks.find((t) => t.id === candidate.taskId)} action={action} busy={busy} />)}
    {data && !candidates.length && <div className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">{latest ? "No proposals awaiting review yet." : "Start a check to see findings here."}</div>}
    {data && data.sync.pending > candidates.filter((c) => c.status === "pending").length && <p className="text-xs text-muted-foreground">Showing the first batch of proposals. More will appear after you review these.</p>}
    {pastRuns.length > 0 && <details className="rounded-xl border border-border p-4"><summary className="cursor-pointer text-sm">Check history · {pastRuns.length}</summary><div className="mt-3 space-y-4">{pastRuns.map((run) => <div key={run.id} className="border-t border-border pt-3"><div className="flex flex-wrap items-center gap-2 text-sm"><span>{date(run.startedAt)} · {syncStatusNames[run.status]} · proposals {run.suggestions}</span>{run.threadId && <Button size="sm" variant="ghost" onClick={() => navigate.toThread(run.threadId!)}>Open chat</Button>}</div>{run.reports.map((r) => <p key={r.source} className="mt-1 text-xs text-muted-foreground">{sourceNames[r.source]} · from {date(run.ranges[r.source].since)} to {date(run.until)} · {r.status === "complete" ? "checked" : r.status === "partial" ? "partial" : "unavailable"}: {r.detail}</p>)}{run.error && <p className="mt-1 text-xs text-destructive">{run.error}</p>}</div>)}</div></details>}
  </div></div>;
}

function Desk() {
  const [customerFilter, setCustomerFilter] = useState("all");
  const rpc = useUxRpc();
  const navigate = useBbNavigate();
  const [history, setHistory] = useState(false);
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState<GroupKey | null>(null);
  const [sort, setSort] = useState<TaskSort>(savedTaskSort);
  function chooseSort(value: string) {
    if (value !== "updated" && value !== "oldest" && value !== "priority") return;
    setSort(value);
    try { window.localStorage.setItem(TASK_SORT_KEY, value); } catch { /* Sorting still works when browser storage is unavailable. */ }
  }
  useEffect(() => {
    const changed = (event: StorageEvent) => { if (event.key === TASK_SORT_KEY || event.key === null) setSort(savedTaskSort()); };
    window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  }, []);
  const [creating, setCreating] = useState(false);
  const [layout, setLayout] = useState<"list" | "cards">(() => { try { return localStorage.getItem("247c-task-layout") === "cards" ? "cards" : "list"; } catch { return "list"; } });
  const [openingTask, setOpeningTask] = useState<string | null>(null);
  const opening = useRef(false), chatRequests = useRef(new Map<string, string>()), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function openChat(taskId: string) {
    if (opening.current) return;
    opening.current = true; setOpeningTask(taskId);
    const requestId = chatRequests.current.get(taskId) ?? crypto.randomUUID(); chatRequests.current.set(taskId, requestId);
    try {
      const session = await rpc.call("openChat", { taskId, requestId });
      if (!session.workerThreadId) throw new Error(session.error || "The chat is still starting. Try again.");
      if (mounted.current) navigate.toThread(session.workerThreadId);
    } catch (cause) { toast.error("Could not open the work chat", { description: cause instanceof Error ? cause.message : String(cause) }); }
    finally { opening.current = false; if (mounted.current) setOpeningTask(null); }
  }
  const load = useCallback(() => rpc.call("list", { history }), [rpc, history]);
  const { data, error, refresh } = useSnapshot(load);
  const tasks = data?.tasks ?? [];
  const open = tasks.filter((t) => isLiveTask(t.status));
  const pending = data?.pendingTotal ?? 0;
  const customers = customerChoices(tasks);
  const visible = tasks.filter((t) => (customerFilter === "all" || (customerFilter === "none" ? !t.customer : customerKey(t.customer) === customerFilter.slice(5))) && (!group || groupFor(t) === group) && `${t.title} ${t.customer ?? ""} ${t.summary ?? ""} ${t.nextStep ?? ""} ${(t.sourceReferences ?? []).join(" ")}`.toLocaleLowerCase("ru").includes(query.toLocaleLowerCase("ru")))
    .sort((a, b) => {
      const priority = sort === "priority" ? groups.findIndex((g) => g.key === groupFor(a)) - groups.findIndex((g) => g.key === groupFor(b)) : 0;
      const updated = Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
      return priority || (sort === "oldest" ? -updated : updated) || a.id.localeCompare(b.id);
    });
  return <div data-c247-task-layout={layout} className="h-full min-h-0 overflow-y-auto"><div className="mx-auto max-w-6xl space-y-4 p-4 md:p-5">
    <div className="flex flex-wrap items-center justify-between gap-3"><div className="flex items-baseline gap-3"><h1 className="text-xl font-medium">Tasks</h1><span className="text-sm text-muted-foreground">{open.length} open{pending ? ` · ${pending} awaiting review` : ""}</span></div><div className="flex gap-2"><div className="inline-flex rounded-lg border border-border p-0.5" aria-label="Task layout">{(["list", "cards"] as const).map(value => <Button data-c247-ux-action="task-layout" size="sm" variant={layout === value ? "secondary" : "ghost"} aria-pressed={layout === value} key={value} onClick={() => { setLayout(value); try { localStorage.setItem("247c-task-layout", value); } catch {} }}>{value === "list" ? "List" : "Cards"}</Button>)}</div><Button onClick={() => setCreating(true)}><span aria-hidden="true">＋</span> New task</Button></div></div>
    <ErrorNotice error={error} retry={() => void refresh()} />
    {creating && <CreateTask cancel={() => setCreating(false)} done={(id) => navigate.toPluginPanel("desk", { subPath: id })} />}
    <div className="grid grid-cols-2 gap-2 lg:grid-cols-6" aria-label="Task groups">
      {groups.map((g) => <button key={g.key} type="button" aria-pressed={group === g.key} onClick={() => setGroup(group === g.key ? null : g.key)} className={cn("rounded-xl border border-l-4 p-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", g.card, group === g.key && g.selected)}><div className="flex items-center justify-between gap-2"><span className="text-sm font-medium">{g.title}</span><span className="font-mono text-lg tabular-nums">{open.filter((t) => groupFor(t) === g.key).length}</span></div>{layout === "cards" && <p className="mt-1 text-xs text-muted-foreground">{g.subtitle}</p>}</button>)}
    </div>
    <div className="flex flex-wrap items-center gap-3"><div className="relative min-w-48 flex-1"><Icon name="Search" className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted-foreground" /><Input className="pl-9" value={query} onChange={(e) => setQuery(e.target.value)} data-c247-ux-action="search" placeholder="Find a task" aria-label="Find a task" /></div><label className="flex items-center gap-2 text-sm text-muted-foreground">Customer<select aria-label="Filter by customer" className="h-9 max-w-64 rounded-lg border border-input bg-background px-3 text-sm text-foreground" value={customerFilter} onChange={event => setCustomerFilter(event.target.value)}><option value="all">All customers</option><option value="none">No customer</option>{customers.map(name => <option key={customerKey(name)} value={`name:${customerKey(name)}`}>{name}</option>)}{customerFilter.startsWith("name:") && !customers.some(name => customerKey(name) === customerFilter.slice(5)) && <option value={customerFilter}>{customerFilter.slice(5)}</option>}</select></label><label className="flex items-center gap-2 text-sm text-muted-foreground">Sort by<select aria-label="Sort tasks" className="h-9 rounded-lg border border-input bg-background px-3 text-sm text-foreground" value={sort} onChange={e => chooseSort(e.target.value)}><option value="updated">Recently updated</option><option value="oldest">Oldest update</option><option value="priority">Priority</option></select></label><label className="flex cursor-pointer items-center gap-2 text-sm text-muted-foreground"><input type="checkbox" checked={history} onChange={(e) => setHistory(e.target.checked)} className="accent-current" /> Show completed tasks</label></div>
    {!data && !error ? <div role="status" className="py-16 text-center text-sm text-muted-foreground">Opening your workspace…</div> : visible.length === 0 ? <div className="rounded-2xl border border-dashed border-border px-6 py-16 text-center"><div className="mx-auto mb-5 flex size-12 items-center justify-center rounded-xl bg-muted"><Icon name="Target" className="size-6 text-muted-foreground" /></div><h2 className="text-lg font-medium">{tasks.length ? "Nothing here yet" : "A place for what matters"}</h2><p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-muted-foreground">{tasks.length ? "Try another search, customer or group." : "Start with one task. Save its context, delegate work to agents and return to the result without repeating the background."}</p>{!tasks.length && !creating && <Button className="mt-6" variant="outline" onClick={() => setCreating(true)}>Add your first task</Button>}</div> : <div className={layout === "cards" ? "grid gap-3 md:grid-cols-2 xl:grid-cols-3" : "space-y-2"}>
      {visible.map((task) => { const quadrant = groups.find((g) => g.key === groupFor(task))!;
        const chat = task.activeSession || isLiveTask(task.status) ? <Button data-c247-ux-action={task.activeSession ? "return-thread" : "session-start"} size="sm" variant="outline" disabled={!!openingTask} onClick={() => void openChat(task.id)}>{openingTask === task.id ? "Opening…" : task.activeSession ? "Open chat" : "New chat"}</Button> : null;
        return layout === "list" ? <div key={task.id} className={cn("flex items-center gap-2 rounded-lg border border-l-4 pr-3", quadrant.card)}>
        <button data-c247-ux-action="task-open" type="button" onClick={() => navigate.toPluginPanel("desk", { subPath: task.id })} className="min-w-0 flex-1 rounded-md px-3 py-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <div className="flex items-center gap-2"><span aria-hidden="true" className={cn("size-2 shrink-0 rounded-full", quadrant.dot)} /><h2 title={task.title} className="min-w-0 truncate text-sm font-medium">{task.title}</h2>{task.unseen && <span className="shrink-0 text-xs font-medium text-blue-700 dark:text-blue-300">{task.unseen === "new" ? "New" : "Updated"}</span>}</div>
          {task.nextStep && <p className="mt-1 truncate text-xs text-muted-foreground">{task.nextStep}</p>}
          <div className="mt-1 flex flex-wrap gap-3 text-xs text-muted-foreground">{task.status === "waiting" && <span className="text-sky-700 dark:text-sky-300">Waiting for response</span>}<span>{task.pendingCount ? `Awaiting a decision · ${task.pendingCount}` : task.activeSession ? cardSessionLabel(task) : isLiveTask(task.status) ? groups.find(g => g.key === priorityGroupFor(task))!.subtitle : taskStatusNames[task.status]}</span>{task.customer && <span>Customer: {task.customer}</span>}<time dateTime={task.updatedAt}>Updated {date(task.updatedAt)}</time></div>
        </button>{task.failedReviewId && <Button size="sm" variant="outline" className="shrink-0 border-destructive/40 text-destructive" onClick={() => navigate.toPluginPanel("desk", { subPath: taskReviewPath(task.id, task.failedReviewId!) })}>Review failed</Button>}{chat}
      </div> : <div key={task.id} className={cn("flex flex-col rounded-xl border border-l-4", quadrant.card)}><button data-c247-ux-action="task-open" type="button" onClick={() => navigate.toPluginPanel("desk", { subPath: task.id })} className="group flex min-h-44 flex-1 flex-col rounded-xl p-4 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <div className="mb-3 flex min-h-5 items-center gap-2 text-xs text-muted-foreground"><span aria-hidden="true" className={cn("size-2 shrink-0 rounded-full", quadrant.dot)} />{task.activeSession ? <>{task.activeSessionBusy && <span className="size-1.5 animate-pulse rounded-full bg-primary" />} {cardSessionLabel(task)}</> : task.pendingCount ? <span className="text-primary">Awaiting a decision · {task.pendingCount}</span> : isLiveTask(task.status) ? groups.find(g => g.key === priorityGroupFor(task))!.subtitle : taskStatusNames[task.status]}</div>
        <h2 className={cn("break-words text-base font-medium leading-snug", !isLiveTask(task.status) && "text-muted-foreground")}>{task.title}{task.unseen && <span className="ml-2 inline-flex align-middle rounded-full bg-blue-500/15 px-2 py-0.5 text-xs font-medium text-blue-700 dark:text-blue-300" title={task.unseen === "new" ? "You have not opened this task yet" : "Accepted changes since your last visit"}>{task.unseen === "new" ? "New" : "Updated"}</span>}</h2>
        {task.status === "waiting" && <p className="mt-2 text-xs text-sky-700 dark:text-sky-300">Waiting for response</p>}
        <p className="mt-2 text-xs text-muted-foreground">Customer: <span className="font-medium text-foreground">{task.customer ?? "Not specified"}</span></p>
        {task.summary && <p className="mt-2 line-clamp-3 text-sm leading-relaxed text-muted-foreground">{task.summary}</p>}
        <div className="mt-auto pt-4">{task.nextStep && <p className="line-clamp-2 text-xs"><span className="text-muted-foreground">Next: </span>{task.nextStep}</p>}<p className={cn("text-xs text-muted-foreground", task.nextStep && "mt-2")}><time dateTime={task.updatedAt}>Updated {date(task.updatedAt)}</time></p></div>
      </button>{(chat || task.failedReviewId) && <div className="flex flex-wrap justify-end gap-2 px-4 pb-3">{task.failedReviewId && <Button size="sm" variant="outline" className="border-destructive/40 text-destructive" onClick={() => navigate.toPluginPanel("desk", { subPath: taskReviewPath(task.id, task.failedReviewId!) })}>Review failed</Button>}{chat}</div>}</div>; })}
    </div>}
    {data && data.total > tasks.length && <p className="text-sm text-muted-foreground">Showing the latest {tasks.length} of {data.total} tasks.</p>}
  </div></div>;
}

function DisplayValue({ value }: { value: unknown }) {
  if (value == null || value === "" || (Array.isArray(value) && value.length === 0)) return <span className="text-muted-foreground">Not specified yet</span>;
  if (Array.isArray(value)) return <ul className="space-y-1">{value.map((item, i) => <li key={i}>• {typeof item === "string" ? item : typeof item === "object" && item && "label" in item ? String(item.label) : JSON.stringify(item)}</li>)}</ul>;
  return <span className="whitespace-pre-wrap break-words">{String(value)}</span>;
}

function ProposalCard({ proposal, dossier, action, busy, discuss, partSelection, onPartSelection }: { partSelection?: string[]; onPartSelection?: (parts: string[] | undefined) => void; discuss?: (sessionId: string) => void; proposal: Dossier["proposals"][number]; dossier: ReviewDossier; action: (fn: () => Promise<unknown>) => Promise<boolean>; busy: boolean }) {
  const rpc = useUxRpc();
  const navigate = useBbNavigate();
  const update = dossier.sessionUpdates.find((u) => u.proposalId === proposal.id);
  const pending = proposal.status === "pending" || proposal.status === "approved";
  const stale = proposal.baseRevision !== dossier.task.revision;
  const selection = usePartSelection(proposal.id, proposalParts(proposal.changes, update?.extraction), busy || proposal.status === "approved", onPartSelection, partSelection,
    stale ? "Refreshing keeps the selected parts pending. Unchecked parts are discarded from the replacement and preserved in history." : undefined);
  const completing = proposal.changes.status?.value === "done" && selection.picked.includes("field:status");
  const decide = (decision: "accept" | "reject") => action(() => selection.all
    ? decision === "accept" ? rpc.call("accept", { proposalId: proposal.id, revision: dossier.task.revision }) : rpc.call("reject", { proposalId: proposal.id })
    : rpc.call("reviewParts", { kind: "proposal", id: proposal.id, revision: dossier.task.revision, decision, parts: selection.picked, requestId: crypto.randomUUID() }));
  const discussing = dossier.sessions.some((s) => ACTIVE.has(s.status) && s.discussionProposalId === proposal.id);
  const changingStatusDuringWork = Boolean(proposal.changes.status && statusNeedsStoppedSession(dossier.task.status, proposal.changes.status.value)) && selection.picked.includes("field:status") && dossier.sessions.some((s) => ACTIVE.has(s.status));
  const allEvidence = [...dossier.facts.map((f) => ({ ref: f.id, text: f.text })), ...proposal.evidence];
  const used = new Set([...Object.values(proposal.changes).flatMap((change) => change?.evidenceRefs ?? []), ...(update?.extraction.reportedTime?.evidenceRefs ?? [])]);
  return <article className="overflow-hidden rounded-xl border border-border bg-card">
    <div className="border-b border-border p-4"><div className="flex flex-wrap items-center justify-between gap-2"><Pill attention={pending}>{pending ? "Proposal" : proposal.partReview ? "Reviewed in parts" : proposal.status === "applied" ? "Accepted" : proposal.status === "rejected" ? "Rejected" : "Stale"}</Pill><span className="text-xs text-muted-foreground">{date(proposal.createdAt)}</span></div><p className="mt-3 text-sm leading-relaxed">{proposal.rationale}</p></div>
    <PartReviewNote review={proposal.partReview} />{pending && selection.bar}
    <div className="divide-y divide-border">{Object.entries(update ? update.extraction.changes ?? {} : proposal.changes).map(([field, change]) => <div key={field} className="p-4"><h3 aria-label={fieldNames[field as keyof typeof fieldNames]} className="mb-3 text-sm font-medium">{pending ? selection.checkbox(`field:${field}`, fieldNames[field as keyof typeof fieldNames]) : fieldNames[field as keyof typeof fieldNames] + partOutcome(proposal.partReview, `field:${field}`)}</h3><div className="grid gap-4 sm:grid-cols-2"><div><p className="mb-1.5 text-xs text-muted-foreground">Before</p><div className="text-sm leading-relaxed text-muted-foreground"><DisplayValue value={field === "status" ? taskStatusNames[dossier.task.status] : field === "title" ? dossier.task.title : field === "urgent" || field === "important" ? axisName(dossier.planning[field]) : dossier.projection[field as Exclude<keyof typeof fieldNames, "status" | "title" | "urgent" | "important">]} /></div></div><div className="rounded-lg bg-primary/5 p-3"><p className="mb-1.5 text-xs text-primary">Proposed</p><div className="text-sm leading-relaxed"><DisplayValue value={field === "status" ? taskStatusNames[change?.value as keyof typeof taskStatusNames] : field === "urgent" || field === "important" ? axisName(change?.value as boolean | null) : change?.value} /></div></div></div></div>)}</div>
    {update && <div className="space-y-5 border-t border-border p-4">
      {update.omittedReportedTime && <p role="note" className="text-xs text-muted-foreground">Reported time was automatically excluded because {update.omittedReportedTime.reason === "already_reported" ? "this session was already reported" : update.omittedReportedTime.reason === "recorded_in_conversation" ? "time for this work was already entered from the conversation" : "the day total changed after the estimate"}. Your current reported time is preserved.</p>}
      {update.extraction.reportedTime && update.reportedTimeContext && <section aria-label="Reported time proposal" className="rounded-lg border border-primary/20 bg-primary/5 p-3">
        <h3 className="text-sm font-medium">{pending ? selection.checkbox("reportedTime", "Reported time") : "Reported time" + partOutcome(proposal.partReview, "reportedTime")}</h3>
        <p className="mt-2 text-sm">{update.reportedTimeContext.date}: {formatMinutes(update.reportedTimeContext.beforeMinutes)} → {formatMinutes((update.reportedTimeContext.beforeMinutes ?? 0) + update.extraction.reportedTime.minutes)}</p>
        <p className="mt-1 text-sm">Add {formatMinutes(update.extraction.reportedTime.minutes)} for this session.</p>
        <p className="mt-2 whitespace-pre-wrap text-sm">{update.extraction.reportedTime.reason}</p>
        <p className="mt-2 text-xs text-muted-foreground">Estimated human work, including reading and checking. Saved only when this part is accepted. Discuss the review to correct the estimate.</p>
      </section>}
      {update.extraction.facts.length > 0 && <section><h3 className="mb-3 text-sm font-medium">Dossier records · {update.extraction.facts.length}</h3><div className="space-y-3">{update.extraction.facts.map((fact, i) => <div key={i} className="rounded-lg bg-muted/30 p-3"><div className="text-xs text-muted-foreground">{pending ? selection.checkbox(`fact:${i}`, `Record ${i + 1}: ${factNames[fact.kind]}`) : factNames[fact.kind] + partOutcome(proposal.partReview, `fact:${i}`)}</div><p className="mt-1 whitespace-pre-wrap break-words text-sm">{fact.text}</p><details className="mt-2"><summary className="cursor-pointer text-xs text-muted-foreground">Conversation quotes</summary>{fact.citations.map((citation, j) => <blockquote key={j} className="mt-2 border-l-2 border-border pl-3 text-sm"><p className="mb-1 text-xs text-muted-foreground">{update.speakers[citation.messageRef] === "user" ? "You" : update.speakers[citation.messageRef] === "assistant" ? "Assistant" : "Context"}</p><p className="whitespace-pre-wrap break-words">{citation.quote}</p>{update.sources[citation.messageRef] && update.sources[citation.messageRef].threadId !== update.threadId && <Button variant="ghost" size="sm" onClick={() => navigate.toThread(update.sources[citation.messageRef].threadId)}>From the previous conversation</Button>}</blockquote>)}</details></div>)}</div></section>}
      {update.extraction.knowledge.length > 0 && <section><h3 className="mb-3 text-sm font-medium">Knowledge to save · {update.extraction.knowledge.length}</h3><div className="space-y-3">{update.extraction.knowledge.map((entry, i) => <article key={i} className="rounded-lg border border-primary/20 bg-primary/5 p-3"><div className="text-sm font-medium">{pending ? selection.checkbox(`knowledge:${i}`, `Knowledge: ${entry.title}`) : entry.title + partOutcome(proposal.partReview, `knowledge:${i}`)}</div><p className="mt-2 whitespace-pre-wrap break-words text-sm leading-relaxed">{entry.body}</p>{entry.tags.length > 0 && <p className="mt-2 text-xs text-muted-foreground">{entry.tags.join(" · ")}</p>}</article>)}</div></section>}
      {update.warnings.map((warning) => <p key={warning} className="text-xs text-muted-foreground">{warning}</p>)}
      <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" onClick={() => navigate.toThread(update.threadId)}>Open source conversation</Button>{discuss && <Button size="sm" variant="outline" disabled={busy || dossier.sessions.some((s) => ACTIVE.has(s.status))} onClick={() => discuss(update.sessionId)}>Discuss review</Button>}</div>
      {pending && <p className="text-xs text-muted-foreground">{completing ? "Accepting the selected parts also marks the task as done." : "Accepting saves only the selected fields, records, knowledge and reported time."}</p>}
    </div>}
    <details className="border-t border-border px-4 py-3"><summary className="cursor-pointer text-xs text-muted-foreground">Supporting evidence · {used.size}</summary><ul className="mt-3 space-y-2">{allEvidence.filter((e) => used.has(e.ref)).map((e) => <li key={e.ref} className="whitespace-pre-wrap break-words rounded-lg bg-muted/40 p-3 text-sm leading-relaxed">{e.text}</li>)}</ul><p className="mt-3 break-words text-xs text-muted-foreground">{proposal.model}</p></details>
    {pending && <div className="border-t border-border p-4">{discussing && <p className="mb-3 text-sm text-muted-foreground">A discussion of this review is open. Finish it to receive a revised proposal.</p>}{stale && <ProposalRecovery proposalId={proposal.id} revision={dossier.task.revision} parts={selection.picked} all={selection.all} busy={busy} action={action} />}<div className="flex flex-wrap justify-end gap-2"><Button variant="ghost" disabled={busy || !selection.picked.length || (stale && !selection.all)} onClick={() => void decide("reject")}>{selection.all ? "Reject" : `Reject selected parts · ${selection.picked.length}`}</Button><Button disabled={busy || stale || discussing || changingStatusDuringWork || !selection.picked.length} onClick={() => void decide("accept")}><Icon name="Check" />{!selection.all ? `Accept selected parts · ${selection.picked.length}` : completing ? "Accept and complete task" : proposal.changes.status?.value === "archived" ? "Accept and archive task" : "Accept changes"}</Button></div></div>}
    {proposal.receipt && <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-3"><span className="text-xs text-muted-foreground">Accepted {date(proposal.receipt.createdAt)} · revision {proposal.receipt.afterRevision}</span><Button variant="ghost" size="sm" disabled={busy} onClick={() => void action(() => rpc.call("revert", { proposalId: proposal.id }))}>{completing ? "Propose undoing completion and changes" : update ? "Propose undoing dossier fields" : "Propose undo"}</Button>{update && <p className="w-full text-xs text-muted-foreground">Undo preserves historical conversation records, knowledge and accepted reported time. Correct time in the day plan.</p>}</div>}
  </article>;
}

function ProposalRecovery({ proposalId, revision, parts, all, busy, action }: { proposalId: string; revision: number; parts: string[]; all: boolean; busy: boolean; action: (fn: () => Promise<unknown>) => Promise<boolean> }) {
  const rpc = useUxRpc();
  const [preview, setPreview] = useState<import("./contracts.js").ProposalRefreshPreview | null>(null);
  const [error, setError] = useState<string | null>(null), [attempt, setAttempt] = useState(0);
  const [reviewing, setReviewing] = useState(false), [confirmed, setConfirmed] = useState(false);
  const partsKey = JSON.stringify(parts);
  const requestId = useRef(crypto.randomUUID());
  useEffect(() => { setConfirmed(false); requestId.current = crypto.randomUUID(); }, [proposalId, revision, partsKey]);
  useEffect(() => {
    let live = true;
    setPreview(null); setError(null); setConfirmed(false); setReviewing(false);
    void rpc.call("proposalRefreshPreview", { proposalId }).then(value => { if (live) setPreview(value); }).catch(error => { if (live) setError(String(error)); });
    return () => { live = false; };
  }, [rpc, proposalId, revision, attempt]);
  async function refresh(reviewed: boolean) {
    if (!preview) return;
    const ok = await action(() => rpc.call("refreshProposal", { proposalId, revision: preview.revision, parts, reviewed, requestId: requestId.current }));
    if (!ok) setAttempt(value => value + 1);
  }
  return <section aria-label="Update stale proposal" className="mb-4 space-y-3 rounded-lg border border-border p-3">
    <p className="text-sm font-medium">The task changed after this proposal was prepared.</p>
    {error ? <><p className="text-sm text-destructive">{error}</p><Button size="sm" variant="outline" onClick={() => setAttempt(value => value + 1)}>Retry loading current task</Button></>
      : !preview ? <p role="status" className="text-sm text-muted-foreground">Checking the current task…</p>
      : preview.blockedReason ? <p className="text-sm text-muted-foreground">{preview.blockedReason}</p>
      : <><p className="text-sm text-muted-foreground">{preview.reason}</p>
        {preview.safe && all && !reviewing ? <Button size="sm" variant="outline" disabled={busy} onClick={() => void refresh(false)}>Refresh proposal</Button>
          : !reviewing && <Button size="sm" variant="outline" disabled={busy} onClick={() => setReviewing(true)}>Review current task</Button>}
        {reviewing && <div className="space-y-3">
          <p className="text-sm">Compare the current task below with the proposed values above. Select the parts to keep using their checkboxes.</p>
          <div className="space-y-3 rounded-lg bg-muted/30 p-3"><h3 className="text-sm font-medium">Current task · revision {preview.revision}</h3>
            <p className="text-sm">{preview.dossier.task.title} · {taskStatusNames[preview.dossier.task.status]}</p>
            <p className="text-sm">Urgent: {axisName(preview.dossier.planning.urgent)} · Important: {axisName(preview.dossier.planning.important)}</p>
            {(["customer", "summary", "nextStep", "openQuestions", "blockers", "artifacts"] as const).map(field => <div key={field}><p className="text-xs text-muted-foreground">{fieldNames[field]}</p><div className="text-sm"><DisplayValue value={preview.dossier.projection[field]} /></div></div>)}
            <h4 className="text-sm font-medium">Context and decisions</h4>
            {preview.dossier.facts.map(fact => <div key={fact.id} className="text-sm"><p className="text-xs text-muted-foreground">{factNames[fact.kind]} · {date(fact.createdAt)}</p><p className="whitespace-pre-wrap break-words">{fact.text}</p></div>)}
          </div>
          {!all && <p className="text-sm">Only the {parts.length} selected parts will remain pending. Unchecked parts will be discarded from this proposal and preserved in its history.</p>}
          <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.target.checked)} />I reviewed the current task and want to keep the selected changes.</label>
          <Button size="sm" variant="outline" disabled={busy || !confirmed || !parts.length} onClick={() => void refresh(true)}>Save updated proposal</Button>
        </div>}
        <p className="text-xs text-muted-foreground">This prepares a replacement for your acceptance. It does not run a model or change the task. The original remains in history.</p>
      </>}
  </section>;
}

const axisName = (value: boolean | null) => value === null ? "Not selected" : value ? "Yes" : "No";

const priorityOptions = [
  { color: "Green", label: "Neither urgent nor important", urgent: false, important: false, style: "border-green-500/50 bg-green-500/25 text-green-800 hover:bg-green-500/40 dark:text-green-200" },
  { color: "Yellow", label: "Important, not urgent", urgent: false, important: true, style: "border-yellow-500/50 bg-yellow-500/25 text-yellow-800 hover:bg-yellow-500/40 dark:text-yellow-200" },
  { color: "Orange", label: "Urgent, not important", urgent: true, important: false, style: "border-orange-500/50 bg-orange-500/25 text-orange-800 hover:bg-orange-500/40 dark:text-orange-200" },
  { color: "Red", label: "Urgent and important", urgent: true, important: true, style: "border-red-500/50 bg-red-500/25 text-red-800 hover:bg-red-500/40 dark:text-red-200" },
] as const;

function PriorityButtons({ planning, disabled, change, redFirst = false }: { planning: Pick<Dossier["planning"], "urgent" | "important">; redFirst?: boolean; disabled: boolean; change: (urgent: boolean, important: boolean) => void }) {
  const selected = priorityOptions.find(option => option.urgent === planning.urgent && option.important === planning.important);
  return <div role="group" aria-label="Priority" aria-busy={disabled} className="space-y-2">
    <div className="grid grid-cols-4 gap-2">{(redFirst ? [...priorityOptions].reverse() : priorityOptions).map(option => <span key={option.color} title={`${option.color}: ${option.label}`}>
      <Button type="button" variant="outline" className={cn("h-10 w-full min-w-0 px-0", option.style, selected === option && "ring-2 ring-foreground ring-offset-2 ring-offset-background")}
        aria-label={`${option.color}: ${option.label}`} aria-pressed={selected === option} disabled={disabled}
        onClick={() => { if (selected !== option) change(option.urgent, option.important); }}>
        {selected === option && <Icon name="Check" aria-hidden="true" />}
      </Button>
    </span>)}</div>
    <p className="text-xs text-muted-foreground" aria-live="polite">{selected?.label ?? "Not classified"}</p>
  </div>;
}

function NewTaskPriority({ priority, disabled, change }: { priority?: InitialPriority; disabled: boolean; change: (value: InitialPriority) => void }) {
  return <div className="max-w-sm space-y-2">
    <p className="text-xs font-medium">Priority when created</p>
    <PriorityButtons redFirst planning={priority ?? { urgent: null, important: null }} disabled={disabled}
      change={(urgent, important) => change({ urgent, important })} />
    {priority && <p className="text-xs text-muted-foreground">Your choice overrides any suggested priority when you accept this proposal.</p>}
  </div>;
}

function TaskOverview({ dossier, action, busy, showWork }: { dossier: Dossier; action: (fn: () => Promise<unknown>) => Promise<boolean>; busy: boolean; showWork: () => void }) {
  const rpc = useUxRpc();
  const [note, setNote] = useState("");
  const [kind, setKind] = useState<Dossier["facts"][number]["kind"]>("description");
  const requestId = useRef(crypto.randomUUID());
  const active = dossier.sessions.some((s) => ACTIVE.has(s.status));
  const closed = !isLiveTask(dossier.task.status);
  async function addNote(event: FormEvent) {
    event.preventDefault();
    if (!note.trim()) return;
    if (await action(() => rpc.call("note", { taskId: dossier.task.id, revision: dossier.task.revision, kind, text: note, requestId: requestId.current }))) { setNote(""); requestId.current = crypto.randomUUID(); }
  }
  const proposeFact = (fact: Dossier["facts"][number], field: "summary" | "nextStep") => action(() => rpc.call("propose", { taskId: dossier.task.id, revision: dossier.task.revision, requestId: crypto.randomUUID(), draft: { rationale: field === "summary" ? "Use this record as the current task summary." : "Save the explicitly stated next step.", confidence: 1, changes: { [field]: { value: fact.text, evidenceRefs: [fact.id] } } } }));
  return <div className="grid gap-6 lg:grid-cols-[minmax(0,1.5fr)_minmax(240px,1fr)]">
    <div className="space-y-5"><section className="rounded-xl border border-border bg-card p-5"><div className="mb-3 flex items-center gap-2"><Icon name="Target" className="size-4 text-muted-foreground" /><h2 className="text-sm font-medium">Where things stand</h2></div>{dossier.projection.summary ? <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{dossier.projection.summary}</p> : <p className="text-sm leading-relaxed text-muted-foreground">No accepted summary yet. Add context or start a work session.</p>}<div className="mt-5 border-t border-border pt-4"><p className="mb-1.5 text-xs text-muted-foreground">Next step</p><p className="whitespace-pre-wrap text-sm leading-relaxed">{dossier.projection.nextStep ?? "Not set yet"}</p></div>{!closed && <Button variant="outline" className="mt-5" onClick={showWork}><Icon name="MessageSquare" />{active ? "Open work chat" : "Start work session"}</Button>}</section>
      {!closed && <form className="rounded-xl border border-border bg-card p-4" onSubmit={addNote}><div className="mb-3 flex flex-wrap items-center justify-between gap-2"><label className="text-sm font-medium" htmlFor="new-note">Add context</label><select aria-label="Record type" className="rounded-md border border-input bg-transparent px-2 py-1 text-xs" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>{Object.entries(factNames).filter(([key]) => key !== "artifact").map(([key, title]) => <option key={key} value={key}>{title}</option>)}</select></div><textarea id="new-note" rows={3} maxLength={12000} className={textareaClass} value={note} onChange={(e) => setNote(e.target.value)} placeholder="A fact, decision or important detail to keep…" /><div className="mt-3 flex justify-end"><Button size="sm" disabled={busy || !note.trim()} type="submit">Save record</Button></div>{active && <p className="mt-2 text-xs text-muted-foreground">A new record changes the dossier and stops a session using the old context.</p>}</form>}
      <section><div className="mb-3 flex items-center justify-between"><h2 className="text-sm font-medium">Context and decisions</h2><span className="text-xs text-muted-foreground">{dossier.facts.length} records</span></div>{dossier.facts.length === 0 ? <p className="text-sm text-muted-foreground">Important task details will be saved here.</p> : <ol className="space-y-3">{[...dossier.facts].reverse().map((fact) => <li key={fact.id} className="rounded-xl border border-border bg-card p-4"><div className="mb-2 flex justify-between gap-2 text-xs text-muted-foreground"><span>{factNames[fact.kind]}</span><time>{date(fact.createdAt)}</time></div><p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{fact.text}</p>{!closed && <div className="mt-2 flex flex-wrap justify-end gap-1"><Button variant="ghost" size="sm" disabled={busy} onClick={() => void proposeFact(fact, "summary")}>Propose as summary</Button>{["explicit_next_step", "user_instruction"].includes(fact.kind) && <Button variant="ghost" size="sm" disabled={busy} onClick={() => void proposeFact(fact, "nextStep")}>Propose as next step</Button>}</div>}</li>)}</ol>}</section>
    </div>
    <aside className="space-y-5"><CustomerEditor key={dossier.task.id} taskId={dossier.task.id} revision={dossier.task.revision} value={dossier.projection.customer ?? null} disabled={busy} action={action} /><section className="space-y-2"><h2 className="mb-3 text-sm font-medium">Priority</h2><PriorityButtons planning={dossier.planning} disabled={busy} change={(urgent, important) => void action(() => rpc.call("classify", { taskId: dossier.task.id, revision: dossier.planning.revision, urgent, important }))} /></section>
      <section className="rounded-xl border border-border p-4"><h2 className="mb-3 text-sm font-medium">Open questions</h2><div className="text-sm leading-relaxed"><DisplayValue value={dossier.projection.openQuestions} /></div></section>
      <section className="rounded-xl border border-border p-4"><h2 className="mb-3 text-sm font-medium">Blockers</h2><div className="text-sm leading-relaxed"><DisplayValue value={dossier.projection.blockers} /></div></section>
      <section className="rounded-xl border border-border p-4"><h2 className="mb-3 text-sm font-medium">Artifacts</h2>{!dossier.projection.artifacts.length ? <p className="text-sm text-muted-foreground">Available after accepting a result.</p> : <ul className="space-y-3">{dossier.projection.artifacts.map((artifact) => {
        const source = dossier.sessions.find((s) => s.hostId && s.artifacts.some((a) => { try { return new URL(artifact.uri).pathname === a.path || decodeURIComponent(new URL(artifact.uri).pathname) === a.path; } catch { return false; } }));
        if (source?.hostId && artifact.uri.startsWith("file:")) return <li key={artifact.uri}><FileLink className="break-words text-sm underline decoration-border underline-offset-4 hover:decoration-foreground" target={{ kind: "host", hostId: source.hostId, path: decodeURIComponent(new URL(artifact.uri).pathname) }}>{artifact.label}</FileLink></li>;
        return <li key={artifact.uri} className="break-words text-sm">{artifact.label}</li>;
      })}</ul>}</section>
    </aside>
  </div>;
}

function Work({ dossier, refresh, showProposals, discussionId, initialSessionId }: { initialSessionId?: string; dossier: Dossier; refresh: () => Promise<void>; showProposals: () => void; discussionId: string | null }) {
  const rpc = useUxRpc();
  const navigate = useBbNavigate();
  const [selected, setSelected] = useState<string | null>(initialSessionId ?? null);
  const [starting, setStarting] = useState(Boolean(discussionId));
  const [continuing, setContinuing] = useState<string | null>(discussionId);
  const [reviewer, setReviewer] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const requestId = useRef(crypto.randomUUID());
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const active = dossier.sessions.find((s) => ACTIVE.has(s.status));
  const session = dossier.sessions.find((s) => s.id === selected) ?? active ?? dossier.sessions[0];
  const previous = dossier.sessions.find((s) => s.id === continuing);
  const showComposer = !active && (starting || !session) && (isLiveTask(dossier.task.status) || Boolean(previous));
  async function start(request: NewThreadRequest) {
    setError(null);
    try {
      const result = await rpc.call("start", { taskId: dossier.task.id, revision: dossier.task.revision, criteria: [], requestId: requestId.current, ...(continuing ? { continueSessionId: continuing } : {}), request: request as unknown as StartInput["request"] });
      setSelected(result.id); setStarting(false); setContinuing(null); setReviewer(false); requestId.current = crypto.randomUUID();
      if (mounted.current && result.workerThreadId) navigate.toThread(result.workerThreadId);
      await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); throw cause; }
  }
  async function change(method: "finish" | "retry" | "resume" | "cancel") {
    if (!session || busy) return;
    setBusy(true); setError(null);
    try {
      await rpc.call(method, { sessionId: session.id });
      await refresh();
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); await refresh(); }
    finally { setBusy(false); }
  }
  const threadId = reviewer ? session?.reviewerThreadId : session?.workerThreadId;
  const conversation = session?.mode === "conversation";
  const canResume = conversation && session.status === "blocked" && !session.finishedAt && session.workerThreadId && !session.reviewerThreadId && !session.proposalId && (isLiveTask(dossier.task.status) || session.continuedFrom);
  const canRetry = conversation && session.finishedAt && !dossier.sessions.some((s) => s.continuedFrom === session.id && s.proposalId) && (session.status === "blocked" || session.status === "rejected" || (session.status === "awaiting_approval" && session.baseRevision !== dossier.task.revision));
  return <div className="space-y-4"><ErrorNotice error={error} />
    <div className="flex flex-wrap items-center gap-2">{dossier.sessions.map((s, i) => <button type="button" key={s.id} className={cn("rounded-lg border px-3 py-2 text-xs", !showComposer && session?.id === s.id ? "border-primary/30 bg-primary/5" : "border-border text-muted-foreground")} onClick={() => { setSelected(s.id); setStarting(false); setContinuing(null); setReviewer(false); }}>Session {dossier.sessions.length - i} · {sessionLabel(s)}</button>)}{!active && isLiveTask(dossier.task.status) && session && <Button size="sm" variant="outline" onClick={() => { setContinuing(null); setStarting(true); }}>New session</Button>}</div>
    {showComposer ? <div className="space-y-5">
      <div className="max-w-3xl"><h2 className="text-lg font-medium">{previous ? "Discuss the review" : "Just start a conversation"}</h2>{previous && <p className="mt-2 text-sm text-muted-foreground">The assistant will already have the previous conversation, review and quotes. Describe what you want to clarify or correct.</p>}<p className="mt-2 text-sm leading-relaxed text-muted-foreground">The assistant will already have the dossier. Discuss the task and keep working for as long as you need. When you are done, click Finish session; a separate session will read the dialogue and propose dossier and knowledge records.</p></div>
      <div className="min-h-80 overflow-hidden rounded-xl border border-border bg-card p-3 md:p-4"><ProjectThreadComposer key={`${dossier.task.id}-${continuing ?? "new"}`} defaultProviderId={previous?.workerProvider} defaultModel={previous?.workerModel} defaultReasoningLevel="medium" defaultPermissionMode="accept-edits" initialPrompt={previous ? "I would like to discuss the review of the previous session. " : ""} placeholder={previous ? "What should we clarify in the review?" : "Where shall we start?"} layout="document" draftKey={`247c-session-${dossier.task.id}-${continuing ?? "new"}`} onSubmit={start} /></div>
      <p className="text-xs leading-relaxed text-muted-foreground">The review model is selected automatically: Codex Sol after Claude, personal Sonnet after Codex. The prepared records will appear in Proposals.</p>
    </div> : session ? <>
      <div className="rounded-xl border border-border bg-card p-4">
        <div className="flex flex-wrap items-center justify-between gap-3"><div className="flex items-center gap-2"><Pill attention={ACTIVE.has(session.status) || session.status === "awaiting_approval"}>{sessionLabel(session)}</Pill><span className="text-xs text-muted-foreground">{date(session.createdAt)}</span></div>
          <div className="flex flex-wrap items-center gap-2">
            {conversation && session.finishedAt && !ACTIVE.has(session.status) && <Button size="sm" variant="outline" disabled={busy || Boolean(active)} onClick={() => { setContinuing(session.id); setStarting(true); }}>Discuss review</Button>}
            {canRetry && <Button size="sm" variant="outline" disabled={busy || Boolean(active)} onClick={() => void change("retry")}>Retry review</Button>}
            {canResume && <Button size="sm" variant="outline" disabled={busy || Boolean(active)} onClick={() => void change("resume")}>Resume chat</Button>}
            {ACTIVE.has(session.status) && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void change("cancel")}>{conversation ? "Cancel session" : "Stop session"}</Button>}
            {conversation && session.status === "working" && <Button size="sm" disabled={busy} onClick={() => void change("finish")}>{busy ? "Finishing…" : "Finish session"}</Button>}
          </div>
        </div>
        <details className="mt-3"><summary className="cursor-pointer text-xs text-muted-foreground">Starting point</summary><p className="mt-2 whitespace-pre-wrap break-words text-sm leading-relaxed">{session.objective}</p></details>
        {!conversation && <details className="mt-3"><summary className="cursor-pointer text-xs text-muted-foreground">Acceptance criteria · {session.criteria.length}</summary><ol className="mt-2 list-inside list-decimal space-y-1 text-sm">{session.criteria.map((c, i) => <li key={i}>{c}</li>)}</ol></details>}
        {conversation && session.status === "working" && <p className="mt-3 text-xs text-muted-foreground">You can keep talking. Finish session stops the current response and starts a review of the conversation. The model is selected automatically, with Sol and Sonnet preferred.</p>}
        {conversation && ["collecting", "review_starting", "reviewing"].includes(session.status) && <p className="mt-3 text-sm text-muted-foreground">{session.extractionRepair ? `Refining records from the conversation. Attempt ${session.extractionRepair.attempt} of ${Math.min(2, session.maximumRepairs)}. Proposals will appear here.` : "Saving the conversation outcome. Dossier and knowledge proposals will appear here."}</p>}
        {session.error && <div className="mt-4"><ErrorNotice error={session.error} /></div>}
        {session.review && <div className="mt-4 space-y-2 border-t border-border pt-3">{session.review.criteria.map((c) => <div key={c.index} className="flex items-start gap-2 text-sm"><Icon name={c.passed ? "Check" : "AlertCircle"} className={cn("mt-0.5 size-4 shrink-0", c.passed ? "text-primary" : "text-destructive")} /><div><p>{session.criteria[c.index]}</p><p className="mt-1 text-xs leading-relaxed text-muted-foreground">{c.reason}</p></div></div>)}</div>}
        {session.status === "completed" && <p className="mt-3 text-sm text-muted-foreground">{session.extraction?.rationale ?? "Conversation saved. No new records to add."}</p>}
        {session.status === "awaiting_approval" && <div className="mt-4 flex flex-wrap items-center gap-3"><p className="text-sm">{conversation ? "Dossier and knowledge records are ready." : "Result verified."}</p><Button size="sm" onClick={showProposals}>View proposals</Button></div>}
      </div>
      <div className="overflow-hidden rounded-xl border border-border"><div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-card px-3 py-2"><div className="flex items-center gap-1"><Button variant="ghost" size="sm" aria-pressed={!reviewer} onClick={() => setReviewer(false)}>{conversation ? "Conversation" : "Worker"} · {session.workerModel}</Button>{session.reviewerThreadId && <Button variant="ghost" size="sm" aria-pressed={reviewer} onClick={() => setReviewer(true)}>{conversation ? "Review" : "Verification"} · {session.reviewerModel}</Button>}</div>{threadId && <Button variant="ghost" size="sm" onClick={() => navigate.toThread(threadId)}>Open thread <Icon name="ChevronRight" /></Button>}</div>{threadId ? <div className="h-[min(70vh,760px)] min-h-96"><ThreadChat key={threadId} threadId={threadId} variant={!reviewer && session.status === "working" ? "full" : "timeline"} layout="contained" permissionPolicy="inherit" /></div> : <p className="p-6 text-sm text-muted-foreground">The chat has not been created yet. The reason for starting it will appear here.</p>}</div>
    </> : <p className="text-sm text-muted-foreground">This task has no work sessions yet.</p>}
  </div>;
}

function SessionProposal({ dossier, sessionId, ...props }: { dossier: Dossier; sessionId: string } & Pick<ComponentProps<typeof ProposalCard>, "action" | "busy" | "discuss">) {
  const session = dossier.sessions.find(s => s.id === sessionId);
  const proposal = dossier.proposals.find(p => p.id === session?.proposalId);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
    heading.current?.scrollIntoView?.({ block: "start" });
  }, [proposal?.id]);
  return <section aria-label="Session proposal" className="space-y-3">
    <h2 ref={heading} tabIndex={-1} className="scroll-mt-4 text-sm font-medium outline-none">Proposal from this session</h2>
    {proposal ? <ProposalCard key={proposal.id} proposal={proposal} dossier={dossier} {...props} />
      : <p className="rounded-lg border border-border p-4 text-sm text-muted-foreground">This session has no proposal yet. Its review status is available in Work.</p>}
  </section>;
}

function TaskPage({ taskId, returnTo, threadId, initialSessionId, showSessionProposal = false }: { taskId: string; returnTo?: string; threadId?: string; initialSessionId?: string; showSessionProposal?: boolean }) {
  const rpc = useUxRpc();
  const navigate = useBbNavigate();
  const backLabel = returnTo?.startsWith("report/") ? "Back to report" : returnTo?.startsWith("day/") ? "Back to day plan" : "All tasks";
  const [discussionId, setDiscussionId] = useState<string | null>(null);
  const discuss = (sessionId: string) => { setDiscussionId(sessionId); setTab("work"); };
  const [tab, setTab] = useState<"overview" | "work" | "proposals" | "history">(showSessionProposal ? "proposals" : initialSessionId ? "work" : "overview");
  const [busy, setBusy] = useState(false);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const load = useCallback(() => rpc.call("detail", { id: taskId, ...(initialSessionId ? { sessionId: initialSessionId } : {}) }), [rpc, taskId, initialSessionId]);
  const { data: dossier, error, refresh } = useSnapshot(load);
  async function action(fn: () => Promise<unknown>): Promise<boolean> {
    if (busy) return false;
    setBusy(true); setMutationError(null);
    try { await fn(); await refresh(); return true; }
    catch (cause) { setMutationError(cause instanceof Error ? cause.message : String(cause)); await refresh(); return false; }
    finally { setBusy(false); }
  }
  if (!dossier || dossier.task.id !== taskId) return <div className="space-y-4 p-6"><Button variant="ghost" onClick={() => navigate.toPluginPanel("desk", { subPath: withThread(returnTo ?? "tasks", threadId) })}><Icon name="ChevronLeft" /> {backLabel}</Button>{error ? <ErrorNotice error={error} retry={() => void refresh()} /> : <p role="status" className="text-sm text-muted-foreground">Opening the dossier…</p>}</div>;
  const pending = dossier.proposals.filter((p) => p.status === "pending" || p.status === "approved");
  const syncPending = dossier.syncUpdates.filter((p) => p.status === "pending");
  const pendingCount = pending.length + syncPending.length;
  const focusedSession = showSessionProposal ? dossier.sessions.find(s => s.id === initialSessionId) : undefined;
  const active = dossier.sessions.some((s) => ACTIVE.has(s.status));
  return <div className="relative h-full min-h-0 overflow-y-auto"><TaskViewMarker id={dossier.task.id} revision={dossier.task.revision} /><div className="mx-auto max-w-6xl space-y-5 p-5 md:p-8">
    <Button variant="ghost" size="sm" className="-ml-3" onClick={() => navigate.toPluginPanel("desk", { subPath: withThread(returnTo ?? "tasks", threadId) })}><Icon name="ChevronLeft" /> {backLabel}</Button>
    <div className="flex flex-wrap items-start justify-between gap-4"><div className="min-w-0 flex-1"><div className="mb-2 flex items-center gap-2"><span className={cn("inline-flex rounded-full px-2 py-0.5 text-xs", dossier.task.status === "waiting" ? "bg-sky-400/15 text-sky-700 dark:text-sky-300" : "bg-muted text-muted-foreground")}>{taskStatusNames[dossier.task.status]}</span><span className="text-xs text-muted-foreground">Revision {dossier.task.revision}</span></div><h1 className="break-words text-2xl font-medium leading-snug tracking-tight">{dossier.task.title}</h1></div><div className="flex flex-wrap gap-2">{isLiveTask(dossier.task.status) ? <><Button variant="outline" size="sm" className={cn("border-sky-400/40 text-sky-700 hover:bg-sky-400/10 dark:text-sky-300", dossier.task.status === "waiting" && "bg-sky-400/10")} disabled={busy} onClick={() => void action(() => rpc.call("status", { taskId, status: dossier.task.status === "waiting" ? "open" : "waiting", revision: dossier.task.revision }))}>{dossier.task.status === "waiting" ? "Resume task" : "Waiting for response"}</Button><Button variant="outline" size="sm" disabled={busy || active} onClick={() => void action(() => rpc.call("status", { taskId, status: "done", revision: dossier.task.revision }))}><Icon name="Check" /> Complete</Button><Button variant="ghost" size="icon" aria-label="Archive task" disabled={busy || active} onClick={() => void action(() => rpc.call("status", { taskId, status: "archived", revision: dossier.task.revision }))}><Icon name="Archive" /></Button></> : <Button variant="outline" size="sm" disabled={busy} onClick={() => void action(() => rpc.call("status", { taskId, status: "open", revision: dossier.task.revision }))}>Reopen task</Button>}</div></div>
    <TaskSources key={taskId} links={dossier.sourceLinks} primaryUrl={dossier.primarySource?.url} busy={busy}
      onPrimary={url => void action(() => rpc.call("setPrimarySource", { taskId, url, revision: dossier.sourceRevision, requestId: crypto.randomUUID() }))} />
    <TaskTimeSummary taskId={taskId} threadId={threadId} initialDate={returnTo?.match(/\d{4}-\d{2}-\d{2}/)?.[0]} />
    <div role="tablist" aria-label="Task sections" className="flex gap-1 overflow-x-auto border-b border-border">{([{ id: "overview", name: "Dossier" }, { id: "work", name: "Work" }, { id: "proposals", name: `Proposals${pendingCount ? ` · ${pendingCount}` : ""}` }, { id: "history", name: "History" }] as const).map((item) => <button key={item.id} type="button" role="tab" aria-selected={tab === item.id} onClick={() => { setDiscussionId(null); setTab(item.id); }} className={cn("whitespace-nowrap border-b-2 px-4 py-3 text-sm transition-colors", tab === item.id ? "border-foreground font-medium" : "border-transparent text-muted-foreground hover:text-foreground")}>{item.name}</button>)}</div>
    <ErrorNotice error={mutationError ?? error} retry={() => void refresh()} />
    {pendingCount > 0 && tab === "overview" && <button type="button" className="flex w-full items-center justify-between gap-4 rounded-xl border border-primary/20 bg-primary/5 p-4 text-left" onClick={() => setTab("proposals")}><div><p className="text-sm font-medium">Changes awaiting review</p><p className="mt-1 text-xs text-muted-foreground">Check what will be saved to the permanent dossier.</p></div><Icon name="ChevronRight" className="size-4 shrink-0" /></button>}
    {tab === "overview" && <TaskOverview dossier={dossier} busy={busy} action={action} showWork={() => { setDiscussionId(null); setTab("work"); }} />}
    {tab === "work" && <Work key={discussionId ?? initialSessionId ?? "work"} initialSessionId={initialSessionId} discussionId={discussionId} dossier={dossier} refresh={refresh} showProposals={() => setTab("proposals")} />}
    {tab === "proposals" && <div className="mx-auto max-w-4xl space-y-4">{showSessionProposal && initialSessionId && <SessionProposal dossier={dossier} sessionId={initialSessionId} discuss={discuss} busy={busy} action={action} />}{syncPending.map((p) => <SyncCandidateCard key={p.id} candidate={p} currentTask={{ ...dossier.task, activeSession: active ? "active" : null }} action={action} busy={busy} />)}{pending.filter(p => p.id !== focusedSession?.proposalId).map((p) => <ProposalCard discuss={discuss} key={p.id} proposal={p} dossier={dossier} busy={busy} action={action} />)}{!pendingCount && !showSessionProposal && <div className="rounded-xl border border-dashed border-border py-12 text-center"><Icon name="CircleCheck" className="mx-auto mb-3 size-7 text-muted-foreground" /><h2 className="text-sm font-medium">Everything reviewed</h2><p className="mt-1 text-sm text-muted-foreground">New session results will appear here.</p></div>}</div>}
    {tab === "history" && <div className="mx-auto max-w-4xl space-y-5"><h2 className="text-sm font-medium">Decisions and accepted changes</h2>{dossier.proposals.filter((p) => !["pending", "approved"].includes(p.status)).map((p) => <ProposalCard discuss={discuss} key={p.id} proposal={p} dossier={dossier} busy={busy} action={action} />)}<details className="rounded-xl border border-border p-4"><summary className="cursor-pointer text-sm">Dossier log · latest {dossier.events.length} events</summary><ol className="mt-3 space-y-3">{dossier.events.map((event) => <li key={event.id} className="text-xs"><span className="text-muted-foreground">{date(event.createdAt)}</span><span className="ml-2">{event.kind}</span></li>)}</ol></details></div>}
  </div></div>;
}

function KnowledgeBody({ entry }: { entry: KnowledgeEntry }) {
  const [expanded, setExpanded] = useState(false);
  const body = entry.kind === "file" ? entry.body.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "") : entry.body;
  const long = body.length > 1500;
  return <div className="mt-3 space-y-2">
    {long && !expanded ? <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{body.slice(0, 600).trimEnd()}…</p> : <Markdown content={body} className="break-words text-sm leading-relaxed" />}
    {long && <Button type="button" variant="ghost" size="sm" className="-ml-3" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? "Collapse" : "Read in full"}</Button>}
  </div>;
}

function KnowledgePage() {
  const rpc = useUxRpc();
  const navigate = useBbNavigate();
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const [previousOffsets, setPreviousOffsets] = useState<number[]>([]);
  const load = useCallback(() => rpc.call("knowledge", { query, offset }), [rpc, query, offset]);
  const { data, error, refresh } = useSnapshot(load);
  return <div className="h-full min-h-0 overflow-y-auto"><div className="mx-auto max-w-4xl space-y-5 p-5 md:p-8">
    <Button variant="ghost" size="sm" className="-ml-3" onClick={() => navigate.toPluginPanel("desk", { subPath: "tasks" })}><Icon name="ChevronLeft" /> All tasks</Button>
    <div><h1 className="text-2xl font-medium">Knowledge base</h1><p className="mt-2 text-sm leading-relaxed text-muted-foreground">Reference documents, file notes and accepted knowledge from work conversations. Available in future sessions for any task.</p></div>
    <Input aria-label="Search the knowledge base" placeholder="Find a rule, term or solution" value={query} onChange={(event) => { setQuery(event.target.value); setOffset(0); setPreviousOffsets([]); }} />
    <ErrorNotice error={error} retry={() => void refresh()} />
    {!data ? <p role="status" className="text-sm text-muted-foreground">Opening the knowledge base…</p> : !data.entries.length ? <div className="rounded-xl border border-dashed border-border p-8 text-center"><h2 className="font-medium">{query ? "No matches" : "Knowledge will appear after a conversation"}</h2><p className="mt-2 text-sm text-muted-foreground">{query ? "Try different words." : "Finish a work session and accept useful records in Proposals."}</p></div> : <>
      <p className="text-xs text-muted-foreground">Records {offset + 1}–{offset + data.entries.length} of {data.total}</p>
      <div className="space-y-4">{data.entries.map((entry) => <article key={entry.id} className="rounded-xl border border-border bg-card p-5"><h2 className="font-medium">{entry.title}</h2><KnowledgeBody entry={entry} />{entry.tags.length > 0 && <p className="mt-3 text-xs text-muted-foreground">{entry.tags.join(" · ")}</p>}<div className="mt-4 flex flex-wrap items-center gap-2 border-t border-border pt-3"><span className="mr-auto text-xs text-muted-foreground">{date(entry.createdAt)}</span>{entry.kind === "file" ? <FileLink className="text-xs underline underline-offset-4" target={{ kind: "host", hostId: entry.source.hostId, path: entry.source.path }}>Source file</FileLink> : <><Button size="sm" variant="ghost" onClick={() => navigate.toPluginPanel("desk", { subPath: entry.taskId })}>Task dossier</Button><Button size="sm" variant="ghost" onClick={() => navigate.toThread(entry.threadId)}>Source conversation</Button></>}</div><p className="mt-2 break-words text-xs text-muted-foreground">{entry.kind === "file" ? `${entry.source.label} · ${entry.source.relativePath}` : entry.taskTitle}</p></article>)}</div>
      {(offset > 0 || data.nextOffset !== null) && <div className="flex justify-between"><Button variant="outline" disabled={previousOffsets.length === 0} onClick={() => { setOffset(previousOffsets.at(-1) ?? 0); setPreviousOffsets(previousOffsets.slice(0, -1)); }}>Previous page</Button><Button variant="outline" disabled={data.nextOffset === null} onClick={() => { if (data.nextOffset !== null) { setPreviousOffsets([...previousOffsets, offset]); setOffset(data.nextOffset); } }}>Next page</Button></div>}
    </>}
  </div></div>;
}

const reviewKey = (item: ReviewItem) => `${item.kind}:${item.kind === "source" ? item.candidate.id : item.proposal.id}`;
const reviewTask = (item: ReviewItem) => item.kind === "source" ? item.candidate.taskId : item.proposal.taskId;
const reviewTitle = (item: ReviewItem) => item.kind === "source" ? item.candidate.title : item.dossier.task.title;
const reviewGroup = (item: ReviewItem) => item.kind === "proposal" ? "dossier" : item.candidate.taskId ? "updates" : "new";
const reviewSelection = (item: ReviewItem): ReviewSelection => ({ kind: item.kind, id: item.kind === "source" ? item.candidate.id : item.proposal.id, revision: item.kind === "source" ? item.candidate.baseRevision : item.proposal.baseRevision });
function ProposalInboxPage() {
  const updater = useUpdaterHealth();
  const incompleteSources = Boolean(updater.error || updater.data?.alert);
  const rpc = useUxRpc(), navigate = useBbNavigate();
  const [offset, setOffset] = useState(0);
  const [previousOffsets, setPreviousOffsets] = useState<number[]>([]);
  const [filter, setFilter] = useState("all");
  const [selected, setSelected] = useState(new Set<string>());
  const [expanded, setExpanded] = useState(new Set<string>());
  const [partSelections, setPartSelections] = useState<Record<string, string[] | undefined>>({});
  const [priorities, setPriorities] = useState<Record<string, InitialPriority | undefined>>({});
  const [busy, setBusy] = useState(false), locked = useRef(false);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const load = useCallback(() => rpc.call("proposalInbox", { offset }), [rpc, offset]);
  const { data, error, refresh } = useSnapshot(load);
  const items = data?.items ?? [];
  const visible = items.filter(item => filter === "all" || reviewGroup(item) === filter);
  const picked = items.filter(item => selected.has(reviewKey(item)) && !item.blockedReason && partSelections[reviewKey(item)]?.length !== 0);
  const taskCounts = new Map<string, number>();
  for (const item of items) { const id = reviewTask(item); if (id && !item.blockedReason) taskCounts.set(id, (taskCounts.get(id) ?? 0) + 1); }
  const eligible = visible.filter(item => !item.blockedReason && partSelections[reviewKey(item)]?.length !== 0 && (!reviewTask(item) || taskCounts.get(reviewTask(item)!) === 1));
  const allSelected = eligible.length > 0 && eligible.every(item => selected.has(reviewKey(item)));
  useEffect(() => {
    if (!data) return;
    setSelected(previous => new Set(data.items.filter(item => !item.blockedReason && previous.has(reviewKey(item))).map(reviewKey)));
    if (!data.items.length && offset > 0) { setOffset(0); setPreviousOffsets([]); }
  }, [data, offset]);
  async function action(fn: () => Promise<unknown>) {
    if (locked.current) return false;
    locked.current = true; setBusy(true); setMutationError(null); setNotice(null);
    try { await fn(); await refresh(); return true; }
    catch (cause) { setMutationError(cause instanceof Error ? cause.message : String(cause)); await refresh(); return false; }
    finally { locked.current = false; setBusy(false); }
  }
  function selectAll() {
    setSelected(previous => { const next = new Set(previous); eligible.forEach(item => allSelected ? next.delete(reviewKey(item)) : next.add(reviewKey(item))); return next; });
  }
  function acceptSelected() {
    if (!picked.length) return;
    const snapshot = picked;
    void action(async () => {
      const result = await rpc.call("acceptInbox", { items: snapshot.map(item => ({ ...reviewSelection(item), ...(priorities[reviewKey(item)] && reviewGroup(item) === "new" ? { initialPriority: priorities[reviewKey(item)] } : {}), ...(partSelections[reviewKey(item)] ? { parts: partSelections[reviewKey(item)] } : {}) })) });
      setSelected(new Set(result.failed.map(item => `${item.kind}:${item.id}`)));
      setNotice(`Accepted: ${result.applied.length}.${result.failed.length ? ` Need attention: ${result.failed.length}.` : ""}`);
      if (result.failed.length) setMutationError(result.failed.map(failure => `${reviewTitle(snapshot.find(item => reviewKey(item) === `${failure.kind}:${failure.id}`)!)}: ${failure.message}`).join("\n"));
    });
  }
  return <div className="h-full min-h-0 overflow-y-auto"><div className="mx-auto max-w-5xl space-y-5 p-5 md:p-8">
    <Button variant="ghost" size="sm" className="-ml-3" onClick={() => navigate.toPluginPanel("desk", { subPath: "tasks" })}><Icon name="ChevronLeft" /> All tasks</Button>
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h1 className="text-2xl font-medium">Proposals{data ? ` · ${data.total}` : ""}</h1><p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">New tasks, updates and session outcomes in one place. Review the changes and accept the ones you need.</p></div><Button variant="outline" onClick={() => navigate.toPluginPanel("desk", { subPath: "updates" })}>Check sources</Button></div>
    <div className="flex flex-wrap gap-2" aria-label="Proposal types">{([{ id: "all", name: "All" }, { id: "new", name: "New tasks" }, { id: "updates", name: "Task updates" }, { id: "dossier", name: "Dossiers and sessions" }]).map(group => <Button key={group.id} size="sm" variant={filter === group.id ? "default" : "outline"} aria-pressed={filter === group.id} disabled={busy} onClick={() => { setFilter(group.id); setSelected(new Set()); }}>{group.name} · {items.filter(item => group.id === "all" || reviewGroup(item) === group.id).length}</Button>)}</div>
    <div className="sticky top-0 z-10 flex flex-wrap items-center gap-3 rounded-xl border border-border bg-background p-3 shadow-sm">
      <label className="flex cursor-pointer items-center gap-2 text-sm"><input type="checkbox" aria-label={data?.nextOffset !== null && data?.nextOffset !== undefined || offset ? "Select all on this page" : "Select all"} checked={allSelected} disabled={busy || !eligible.length} onChange={selectAll} />{data?.nextOffset !== null && data?.nextOffset !== undefined || offset ? "Select all on page" : "Select all"}</label>
      <Button size="sm" variant="ghost" disabled={!visible.length} onClick={() => setExpanded(previous => visible.every(item => previous.has(reviewKey(item))) ? new Set() : new Set(visible.map(reviewKey)))}>{visible.length > 0 && visible.every(item => expanded.has(reviewKey(item))) ? "Collapse all" : "Expand all"}</Button>
      <span className="mr-auto text-xs text-muted-foreground">Selected: {picked.length}{picked.some(item => reviewGroup(item) === "new") ? ` · new tasks: ${picked.filter(item => reviewGroup(item) === "new").length}` : ""}</span>
      <Button size="sm" disabled={busy || !picked.length} onClick={acceptSelected}><Icon name="Check" />{busy ? "Saving…" : `Accept selected${picked.length ? ` · ${picked.length}` : ""}`}</Button>
    </div>
    {notice && <p role="status" className="rounded-lg bg-primary/5 p-3 text-sm">{notice}</p>}
    <ErrorNotice error={mutationError ?? error} retry={() => void refresh()} />
    {[...taskCounts.values()].some(count => count > 1) && <p className="text-sm text-muted-foreground">Some tasks have multiple proposals. Choose one manually; Select all skips those tasks.</p>}
    {!data && !error && <p role="status" className="py-12 text-center text-sm text-muted-foreground">Loading proposals…</p>}
    {visible.map(item => {
      const key = reviewKey(item), title = reviewTitle(item), taskId = reviewTask(item);
      const draft = item.kind === "source" ? item.candidate : item.proposal;
      const changes = item.kind === "proposal" ? item.dossier.sessionUpdates[0]?.extraction.changes ?? draft.changes : draft.changes;
      const group = reviewGroup(item), open = expanded.has(key);
      const conflict = Boolean(taskId && picked.some(other => reviewKey(other) !== key && reviewTask(other) === taskId));
      return <section key={key} aria-label={`Proposal: ${title}`} className={cn("overflow-hidden rounded-xl border bg-card", selected.has(key) ? "border-primary/40" : "border-border")}>
        <div className="flex items-start gap-3 p-4"><input type="checkbox" className="mt-1 size-4 shrink-0" aria-label={`Select: ${title}`} checked={selected.has(key)} disabled={busy || Boolean(item.blockedReason) || conflict || partSelections[key]?.length === 0} onChange={() => setSelected(previous => { const next = new Set(previous); next.has(key) ? next.delete(key) : next.add(key); return next; })} />
          <div className="min-w-0 flex-1"><div className="mb-2 flex flex-wrap items-center gap-2"><Pill attention={group === "new"}>{group === "new" ? "New task" : group === "updates" ? "Task changes" : item.kind === "proposal" && item.dossier.sessionUpdates.length ? "Session outcomes" : "Dossier changes"}</Pill><span className="text-xs text-muted-foreground">{[...Object.keys(changes).map(field => fieldNames[field as keyof typeof fieldNames]), ...(item.kind === "proposal" && item.dossier.sessionUpdates[0]?.extraction.reportedTime ? ["Reported time"] : [])].join(" · ")}</span></div>
            <button type="button" className="w-full text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-expanded={open} aria-label={`${open ? "Collapse" : "View"}: ${title}`} onClick={() => setExpanded(previous => { const next = new Set(previous); next.has(key) ? next.delete(key) : next.add(key); return next; })}><h2 className="break-words font-medium leading-snug">{title}</h2><p className="mt-2 line-clamp-2 text-sm leading-relaxed text-muted-foreground">{draft.rationale}</p></button>
            {!open && changes.nextStep?.value && <p className="mt-3 line-clamp-3 text-sm leading-relaxed"><span className="text-muted-foreground">Next: </span>{changes.nextStep.value}</p>}
            {!open && changes.status && <p className="mt-2 text-sm">Status: {taskStatusNames[changes.status.value]}</p>}
            {group === "new" && <div className="mt-3"><NewTaskPriority priority={priorities[key]} disabled={busy || Boolean(item.blockedReason)} change={value => setPriorities(previous => ({ ...previous, [key]: value }))} /></div>}
            {partSelections[key] && <p className="mt-2 text-xs text-muted-foreground">{partSelections[key]!.length} parts selected. Unchecked parts stay pending.</p>}{item.blockedReason && <p className="mt-3 text-sm text-destructive">{item.blockedReason}</p>}{conflict && <p className="mt-3 text-xs text-muted-foreground">Another proposal is already selected for this task.</p>}
          </div><Button size="sm" variant="ghost" aria-label={`${open ? "Collapse changes" : "Show changes"}: ${title}`} onClick={() => setExpanded(previous => { const next = new Set(previous); next.has(key) ? next.delete(key) : next.add(key); return next; })}><Icon name={open ? "ChevronDown" : "ChevronRight"} /></Button>
        </div>
        {open && <div className="border-t border-border p-3 pt-0 md:p-4 md:pt-0">{item.kind === "source" ? <SyncCandidateCard priorityInHeader initialPriority={priorities[key]} candidate={item.candidate} currentTask={item.currentTask ?? undefined} action={action} busy={busy} partSelection={partSelections[key]} onPartSelection={parts => setPartSelections(previous => ({ ...previous, [key]: parts }))} /> : <><div className="flex justify-end py-2"><Button size="sm" variant="ghost" onClick={() => navigate.toPluginPanel("desk", { subPath: item.dossier.task.id })}>Open task</Button></div><ProposalCard proposal={item.proposal} dossier={item.dossier} action={action} busy={busy} partSelection={partSelections[key]} onPartSelection={parts => setPartSelections(previous => ({ ...previous, [key]: parts }))} /></>}</div>}
      </section>;
    })}
    {data && !visible.length && <div className="rounded-xl border border-dashed border-border p-10 text-center"><Icon name={incompleteSources ? "AlertCircle" : "CircleCheck"} className="mx-auto mb-3 size-7 text-muted-foreground" /><h2 className="font-medium">{data.total ? "No proposals in this section" : incompleteSources ? "No proposals are ready" : "Everything reviewed"}</h2><p className="mt-2 text-sm text-muted-foreground">{data.total ? "Choose another proposal type or the next page." : incompleteSources ? "Source checks need attention. New work may not have reached this list." : "New proposals will appear after checking sources or finishing sessions."}</p></div>}
    {data && (offset > 0 || data.nextOffset !== null) && <div className="flex flex-wrap items-center justify-between gap-3"><Button variant="outline" disabled={busy || !previousOffsets.length} onClick={() => { setOffset(previousOffsets.at(-1) ?? 0); setPreviousOffsets(previousOffsets.slice(0, -1)); setSelected(new Set()); }}>Previous page</Button><span className="text-xs text-muted-foreground">On this page {items.length} of {data.total}. The rest are on the next page.</span><Button variant="outline" disabled={busy || data.nextOffset === null} onClick={() => { if (data.nextOffset !== null) { setPreviousOffsets([...previousOffsets, offset]); setOffset(data.nextOffset); setSelected(new Set()); } }}>Next page</Button></div>}
  </div></div>;
}

// The sidebar always opens the panel root. Keep the Tasks route explicit so
// choosing Tasks never redirects back to the inbox while proposals are pending.
function Page({ subPath }: PluginNavPanelProps) {
  return deskRoute(subPath).path === "" ? <EntryPage subPath={subPath} /> : <DeskPage subPath={subPath} />;
}

function EntryPage({ subPath }: PluginNavPanelProps) {
  const rpc = useUxRpc(), navigate = useBbNavigate();
  const load = useCallback(() => rpc.call("threadProject", {}), [rpc]);
  const { data, error, refresh } = useSnapshot(load);
  const { threadId } = deskRoute(subPath);
  useEffect(() => {
    if (data) navigate.toPluginPanel("desk", {
      subPath: withThread((data.pendingTotal ?? 0) > 0 ? "proposals" : "tasks", threadId),
      replace: true,
    });
  }, [data, navigate, threadId]);
  return error ? <ErrorNotice error={error} retry={() => void refresh()} /> : <p role="status">Opening 247C…</p>;
}

function DeskPage({ subPath }: PluginNavPanelProps) {
  const rpc = useUxRpc();
  const reviews = useReviewFailures();
  const load = useCallback(() => rpc.call("threadProject", {}), [rpc]);
  const { data, error, refresh } = useSnapshot(load);
  const navigate = useBbNavigate(), { threadId } = deskRoute(subPath);
  if (!data && error) return <ErrorNotice error={error} retry={() => void refresh()} />;
  if (!data) return <p role="status">Loading 247C settings…</p>;
  const page = deskRoute(subPath).path.split("/")[0];
  const uxPage = !page || page === "tasks" ? "tasks" : ["day", "report", "proposals", "updates", "knowledge", "ux"].includes(page) ? page as "day" | "report" | "proposals" | "updates" | "knowledge" | "ux" : "task";
  return <UxScope page={uxPage} view={subPath} className="h-full min-h-0"><PlanningTimeZone.Provider value={data.timeZone ?? DAY_TIME_ZONE}><ErrorNotice error={error} retry={() => void refresh()} /><NavigationFrame subPath={subPath} pendingTotal={data.pendingTotal} failedReviews={reviews.data?.total ?? 0} today={localDay(new Date(), data.timeZone ?? DAY_TIME_ZONE)} goTo={path => navigate.toPluginPanel("desk", { subPath: withThread(path, threadId) })} returnToThread={threadId ? () => navigate.toThread(threadId) : undefined}><div className="flex h-full min-h-0 flex-col"><UpdaterHealthBanner showHealthy={deskRoute(subPath).path === "updates"} /><div className="min-h-0 flex-1"><PageContent subPath={subPath} /></div></div></NavigationFrame></PlanningTimeZone.Provider></UxScope>;
}

function PageContent({ subPath }: PluginNavPanelProps) {
  const timeZone = usePlanningTimeZone();
  const { path, threadId, focusTaskId } = deskRoute(subPath);
  if (path === "tasks") return <Desk />;
  if (path === "reviews") return <ReviewFailuresPage />;
  if (path === "ux") return <UxPageView />;
  if (path === "proposals") return <ProposalInboxPage />;
  if (path === "updates") return <SyncPage />;
  if (path === "knowledge") return <KnowledgePage />;
  const parts = path.split("/");
  if (parts[0] === "new-chat" && parts.length === 2 && /^[A-Za-z0-9_-]{1,120}$/.test(parts[1])) return <TaskPage key={parts[1]} taskId={parts[1]} threadId={threadId} />;
  if (parts[0] === "day" || parts[0] === "report") {
    const report = parts[0] === "report", period = parts[1] === "day" ? "day" : "week";
    const date = (report ? parts[2] : parts[1]) || localDay(new Date(), timeZone);
    if (!dayDateSchema.safeParse(date).success) return <div className="p-6"><ErrorNotice error="The link contains an invalid date." /></div>;
    return <DayPage key={`${report}:${period}:${date}:${focusTaskId ?? ""}`} date={date} report={report} period={period} threadId={threadId} focusTaskId={focusTaskId} />;
  }
  const sessionRoute = path.match(/^[A-Za-z0-9_-]{1,120}\/session\/([A-Za-z0-9_-]{1,120})(\/proposal)?$/);
  const reviewSession = sessionRoute?.[1], showSessionProposal = Boolean(sessionRoute?.[2]);
  const returnTo = path.match(/^[^/]+\/from\/((?:day|report\/(?:day|week))\/\d{4}-\d{2}-\d{2}(?:\/task\/[A-Za-z0-9_-]{1,120})?)$/)?.[1];
  return path ? <TaskPage key={`${parts[0]}:${reviewSession ?? ""}:${showSessionProposal}`} taskId={parts[0]} initialSessionId={reviewSession} showSessionProposal={showSessionProposal} returnTo={returnTo} threadId={threadId} /> : <Desk />;
}
function SidebarReported() {
  const rpc = useUxRpc();
  const load = useCallback(() => rpc.call("day", {}), [rpc]);
  const { data, error } = useSnapshot(load);
  if (!data && !error) return null;
  const minutes = Math.round(data?.totals.reportedMinutes ?? 0);
  const value = error ? "—" : `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}`;
  const label = error ? "Reported today: unavailable" : `Reported today: ${value}`;
  const title = error ? `${label} · ${error}` : `${label} · ${data!.date} · ${data!.timeZone}${data!.totals.estimatedReported ? " · Includes estimates" : ""}`;
  return <span className="max-w-9 shrink-0 truncate font-mono text-[10px] tabular-nums text-muted-foreground" title={title} aria-label={label}>{value}</span>;
}

function SidebarCount() {
  const rpc = useUxRpc();
  const navigate = useBbNavigate();
  const load = useCallback(() => rpc.call("list", { history: false }), [rpc]);
  const { data } = useSnapshot(load);
  const pendingLabel = `Proposals awaiting a decision: ${data?.pendingTotal ?? 0}`;
  // The scoped sidebar style reserves room for failure and proposal signals
  // together, without clipping reported time or covering BB’s menu button.
  return <span className="inline-flex w-auto min-w-0 items-center justify-end gap-0.5 whitespace-nowrap leading-4">
    <ReviewFailureBadge />
    <UpdaterHealthBadge />
    {data && data.pendingTotal > 0 && <button type="button" data-c247-proposals-shortcut="" className="inline-flex h-4 w-4 shrink-0 cursor-pointer items-center justify-center rounded-full bg-orange-500/20 font-mono text-[9px] font-semibold leading-none tabular-nums text-orange-700 hover:bg-orange-500/35 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-orange-500 dark:text-orange-300" title={`${pendingLabel}. Open Proposals`} aria-label={pendingLabel} onPointerDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); navigate.toPluginPanel("desk", { subPath: "proposals" }); }}>{data.pendingTotal > 9 ? "9+" : data.pendingTotal}</button>}
    {data && data.total > 0 && <span className="min-w-0 truncate font-mono text-[10px] tabular-nums text-muted-foreground" title={`Open tasks: ${data.total}`}>{data.total}</span>}
    <SidebarReported />
  </span>;
}
export default definePluginApp((app) => {
  app.slots.experimental_appOverlay({ id: "ux-recording", component: UxOverlay });
  app.slots.settingsSection({ id: "ux-recording", title: "UX recording", component: UxPageView });
  app.slots.experimental_appOverlay({ id: "review-failure-notification", component: ReviewFailureNotification });
  app.slots.experimental_appOverlay({ id: "updater-health-notification", component: UpdaterHealthNotification });
  app.contentScripts.register({ id: "sidebar-proposals-shortcut", mount: mountSidebarShortcut });
  app.slots.navPanel({ id: "desk", title: "247C", icon: "Target", path: "desk", component: Page, experimental_sidebarAccessory: SidebarCount, headerContent: PagePinnedFiles });
  app.slots.experimental_appOverlay({ id: "task-switcher", component: TaskSwitcherOverlay });
  app.commands.register({ id: "switch-task", title: "247C: Switch task", defaultShortcut: { key: "k", mod: true, shift: true }, run: openTaskSwitcher });
  app.slots.experimental_threadHeaderAction({ id: "task", title: "247C task", component: ThreadTaskAction });
  app.slots.experimental_threadHeaderAction({ id: "switch", title: "247C switch task", component: ThreadSwitchAction });
  app.slots.experimental_threadHeaderAction({ id: "pinned-files", title: "Pinned files", component: ThreadPinnedFiles });
  app.slots.experimental_threadHeaderAction({ id: "proposal", title: "247C proposal", component: ThreadProposalAction });
  app.slots.experimental_threadHeaderAction({ id: "source", title: "247C primary source", component: ThreadSourceAction });
  app.slots.experimental_threadHeaderAction({ id: "reported", title: "247C reported today", component: ThreadReportedAction });
  app.slots.experimental_threadHeaderAction({ id: "session", title: "247C session", component: ThreadSessionAction });
});
