import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { definePluginApp, useRpc, useRealtime, useRealtimeConnectionState, useBbNavigate, ThreadChat, Markdown, experimental_NewThreadComposer as NewThreadComposer, experimental_FileLink as FileLink } from "@get-bb/plugin-sdk/app";
import type { NewThreadRequest, PluginNavPanelProps, PluginThreadHeaderActionProps } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract, TaskCard, Dossier, Session, StartInput, KnowledgeEntry, SyncCandidate, SyncSource, SyncRun, ReviewDossier, ReviewItem, ReviewSelection } from "./contracts.js";
import { Button } from "./components/ui/button.js";
import { Input } from "./components/ui/input.js";
import { Icon } from "./components/ui/icon.js";
import { cn } from "./lib/utils.js";
import { CalendarStatus, DayPage, TaskTimeSummary } from "./day-app.js";
import { dayDateSchema, localDay } from "./day-contracts.js";

const ACTIVE = new Set(["starting", "working", "collecting", "review_starting", "reviewing", "repair_starting"]);
const statusNames: Record<Session["status"], string> = { starting: "Запускается", working: "В работе", collecting: "Читаем результат", review_starting: "Запускаем проверку", reviewing: "Независимая проверка", repair_starting: "Исправляем замечания", awaiting_approval: "Ждёт твоего решения", applied: "Досье обновлено", rejected: "Предложение отклонено", blocked: "Нужно внимание", cancelled: "Остановлена", completed: "Разбор завершён" };
function sessionLabel(session: Pick<Session, "mode" | "status"> & Partial<Pick<Session, "extractionRepair">>): string {
  if (session.mode !== "conversation") return statusNames[session.status];
  if (session.extractionRepair && ["collecting", "review_starting", "reviewing"].includes(session.status)) return "Исправляем разбор";
  return ({ working: "Разговор открыт", collecting: "Сохраняем разговор", review_starting: "Запускаем разбор", reviewing: "Разбираем разговор", applied: "Записи сохранены" } as Partial<Record<Session["status"], string>>)[session.status] ?? statusNames[session.status];
}
const factNames: Record<Dossier["facts"][number]["kind"], string> = { description: "Контекст", progress: "Продвижение", user_instruction: "Поручение", explicit_next_step: "Следующий шаг", decision: "Решение", open_question: "Вопрос", artifact: "Артефакт", constraint: "Ограничение", blocker: "Препятствие" };
const fieldNames = { title: "Название", urgent: "Срочность", important: "Важность", status: "Статус задачи", summary: "Сводка", nextStep: "Следующий шаг", openQuestions: "Открытые вопросы", blockers: "Препятствия", artifacts: "Артефакты" };
const taskStatusNames = { open: "Открыта", done: "Завершена", archived: "В архиве" };
const groups = [
  { key: "focus", title: "Сейчас", subtitle: "Срочно и важно", card: "border-red-500/25 border-l-red-500 bg-red-500/10 hover:bg-red-500/15", selected: "bg-red-500/15 ring-2 ring-inset ring-red-500/50", dot: "bg-red-500" },
  { key: "delegate", title: "Передать", subtitle: "Срочно, менее важно", card: "border-orange-500/25 border-l-orange-500 bg-orange-500/10 hover:bg-orange-500/15", selected: "bg-orange-500/15 ring-2 ring-inset ring-orange-500/50", dot: "bg-orange-500" },
  { key: "plan", title: "Запланировать", subtitle: "Важно, без спешки", card: "border-yellow-500/25 border-l-yellow-500 bg-yellow-500/10 hover:bg-yellow-500/15", selected: "bg-yellow-500/15 ring-2 ring-inset ring-yellow-500/50", dot: "bg-yellow-500" },
  { key: "later", title: "На потом", subtitle: "Без срочности и важности", card: "border-green-500/25 border-l-green-500 bg-green-500/10 hover:bg-green-500/15", selected: "bg-green-500/15 ring-2 ring-inset ring-green-500/50", dot: "bg-green-500" },
  { key: "inbox", title: "Разобрать", subtitle: "Приоритет ещё не выбран", card: "border-border bg-card hover:bg-muted/50", selected: "bg-muted/50 ring-2 ring-inset ring-border", dot: "bg-muted-foreground" },
] as const;
type GroupKey = typeof groups[number]["key"];
const groupFor = (task: TaskCard): GroupKey => task.planning.urgent === null || task.planning.important === null ? "inbox" : task.planning.urgent ? task.planning.important ? "focus" : "delegate" : task.planning.important ? "plan" : "later";
const date = (value: string) => new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
const textareaClass = "w-full resize-y rounded-lg border border-input bg-transparent px-3 py-2 text-sm leading-relaxed placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50";
const sourceNames: Record<SyncSource, string> = { gmail: "Gmail", slack: "Slack", jira: "Jira" };
const syncStatusNames: Record<SyncRun["status"], string> = { starting: "Запускается", working: "Проверяем источники", completed: "Проверка завершена", partial: "Проверено частично", blocked: "Проверка прервана", cancelled: "Остановлена" };
const syncActive = (run?: SyncRun) => Boolean(run && ["starting", "working"].includes(run.status));

function ErrorNotice({ error, retry }: { error: string | null; retry?: () => void }) {
  if (!error) return null;
  return <div role="alert" className="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm"><Icon name="AlertCircle" className="mt-0.5 size-4 shrink-0 text-destructive" /><p className="min-w-0 flex-1 whitespace-pre-wrap break-words">{error}</p>{retry && <Button size="sm" variant="ghost" onClick={retry}>Обновить</Button>}</div>;
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

function ThreadSessionControl({ threadId, isCompactViewport }: PluginThreadHeaderActionProps) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const load = useCallback(() => rpc.call("threadSession", { threadId }), [rpc, threadId]);
  const { data, error, refresh } = useSnapshot(load);
  const [busy, setBusy] = useState(false);
  const finishing = useRef(false);
  const session = data?.session;
  if (!session || session.workerThreadId !== threadId) return null;

  const canFinish = session.status === "working";
  const label = busy ? "Завершаем…" : error ? "Обновить сессию" : canFinish ? "Завершить сессию" : session.status === "awaiting_approval" ? "Предложения 247C" : "Досье сессии";
  async function finish() {
    if (!session || finishing.current) return;
    finishing.current = true; setBusy(true);
    try { await rpc.call("finish", { sessionId: session.id }); }
    catch (cause) { toast.error("Не удалось завершить сессию", { description: cause instanceof Error ? cause.message : String(cause) }); }
    finally { await refresh(); finishing.current = false; setBusy(false); }
  }
  return <Button type="button" size="sm" variant={canFinish ? "outline" : "ghost"}
    className={cn("h-7 shrink-0", isCompactViewport ? "w-7 px-0" : "px-2")}
    aria-label={label} aria-description={canFinish ? "Остановить текущий ответ и запустить разбор переписки" : sessionLabel(session)}
    disabled={busy} onClick={() => { if (error) void refresh(); else if (canFinish) void finish(); else navigate.toPluginPanel("desk", { subPath: session.taskId }); }}>
    <Icon name={canFinish ? "Check" : "Target"} />{!isCompactViewport && label}
  </Button>;
}

function ThreadSessionAction(props: PluginThreadHeaderActionProps) {
  return <ThreadSessionControl key={props.threadId} {...props} />;
}

function CreateTask({ done, cancel }: { done: (id: string) => void; cancel: () => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(crypto.randomUUID());
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!title.trim() || busy) return;
    setBusy(true); setError(null);
    try { const task = await rpc.call("create", { title, description, requestId: requestId.current }); done(task.id); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }
  return <form onSubmit={submit} className="rounded-xl border border-border bg-card p-5">
    <div className="mb-4 flex items-center justify-between"><h2 className="font-medium">Новая задача</h2><Button type="button" variant="ghost" size="icon" onClick={cancel} aria-label="Закрыть создание задачи"><Icon name="X" /></Button></div>
    <label className="mb-1.5 block text-sm" htmlFor="task-title">Какой результат нужен?</label>
    <Input id="task-title" autoFocus required maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Например, подготовить план переезда" />
    <label className="mb-1.5 mt-4 block text-sm" htmlFor="task-context">Что важно знать <span className="text-muted-foreground">· необязательно</span></label>
    <textarea id="task-context" className={textareaClass} rows={3} maxLength={12000} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Зачем это нужно, что уже известно, какие есть ограничения…" />
    <div className="mt-4"><ErrorNotice error={error} /></div>
    <div className="mt-4 flex justify-end gap-2"><Button type="button" variant="ghost" onClick={cancel} disabled={busy}>Отмена</Button><Button type="submit" disabled={busy || !title.trim()}>{busy ? "Сохраняем…" : "Создать задачу"}</Button></div>
  </form>;
}

function SyncCandidateCard({ candidate, currentTask, action, busy }: { candidate: SyncCandidate; currentTask?: Pick<TaskCard, "revision" | "status" | "activeSession">; action: (fn: () => Promise<unknown>) => Promise<boolean>; busy: boolean }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const pending = candidate.status === "pending";
  const stale = Boolean(candidate.taskId && (!currentTask || currentTask.revision !== candidate.baseRevision || currentTask.status !== "open"));
  const active = Boolean(currentTask?.activeSession && candidate.changes.status);
  const quotes = [...new Map(candidate.facts.flatMap((f) => f.citations).map((c) => [JSON.stringify([c.source, c.messageId, c.quote]), c])).values()];
  function value(field: string, raw: unknown) {
    if (field === "status" && typeof raw === "string") return taskStatusNames[raw as keyof typeof taskStatusNames];
    if ((field === "urgent" || field === "important") && typeof raw === "boolean") return raw ? "Да" : "Нет";
    return <DisplayValue value={raw} />;
  }
  return <article className="overflow-hidden rounded-xl border border-border bg-card">
    <div className="space-y-2 p-4"><div className="flex flex-wrap items-center gap-2"><Pill attention={pending}>{candidate.taskId ? "Обновление задачи" : "Новая задача"}</Pill><span className="text-xs text-muted-foreground">{[...new Set(quotes.map((q) => sourceNames[q.source]))].join(" · ")}</span>{!pending && <span className="text-xs text-muted-foreground">{candidate.status === "applied" ? "Принято" : candidate.status === "superseded" ? "Заменено новой проверкой" : "Отклонено"}</span>}</div><h3 className="break-words font-medium">{candidate.title}</h3><p className="whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">{candidate.rationale}</p></div>
    <div className="divide-y divide-border border-y border-border">{Object.entries(candidate.changes).map(([field, change]) => <div key={field} className="p-4"><p className="mb-2 text-xs font-medium">{fieldNames[field as keyof typeof fieldNames]}</p><div className={cn("grid gap-3 text-sm leading-relaxed", candidate.before && "md:grid-cols-2")}>{candidate.before && <div className="rounded-lg bg-muted/40 p-3"><p className="mb-1 text-xs text-muted-foreground">Было</p>{value(field, candidate.before[field as keyof typeof candidate.before])}</div>}<div className="rounded-lg bg-primary/5 p-3"><p className="mb-1 text-xs text-muted-foreground">Станет</p>{value(field, change?.value)}</div></div></div>)}</div>
    <details className="p-4"><summary className="cursor-pointer text-sm">Факты и цитаты · {quotes.length}</summary><ul className="mt-3 space-y-2 text-sm">{candidate.facts.map((fact, i) => <li key={i} className="whitespace-pre-wrap">{fact.text}</li>)}</ul><div className="mt-4 space-y-4">{quotes.map((quote, index) => <div key={index} className="border-l-2 border-border pl-3"><a href={quote.url} target="_blank" rel="noopener noreferrer" className="text-xs underline underline-offset-4">{sourceNames[quote.source]} · {date(quote.occurredAt)}</a><blockquote className="mt-1 whitespace-pre-wrap break-words text-sm leading-relaxed text-muted-foreground">{quote.quote}</blockquote></div>)}</div></details>
    <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border p-4">{(candidate.taskId ?? candidate.resultTaskId) && <Button size="sm" variant="ghost" onClick={() => navigate.toPluginPanel("desk", { subPath: candidate.taskId ?? candidate.resultTaskId! })}>Открыть задачу</Button>}{pending && <>{stale && <p className="w-full text-sm text-destructive">Досье изменилось после проверки. Проверь источники с прежней даты — новое предложение заменит устаревшее.</p>}{active && <p className="w-full text-sm text-muted-foreground">Изменить статус можно после завершения рабочей сессии.</p>}<Button variant="ghost" size="sm" disabled={busy} onClick={() => void action(() => rpc.call("syncReject", { candidateId: candidate.id }))}>Отклонить обновление</Button><Button size="sm" disabled={busy || stale || active} onClick={() => void action(() => rpc.call("syncAccept", { candidateId: candidate.id }))}>{candidate.taskId ? "Принять обновление" : "Создать задачу по предложению"}</Button></>}</div>
  </article>;
}

function SyncPage() {
  const rpc = useRpc<typeof rpcContract>();
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
  const candidates = data?.sync.candidates.filter((c) => history || c.status === "pending") ?? [];
  async function action(fn: () => Promise<unknown>): Promise<boolean> {
    if (locked.current) return false;
    locked.current = true; setBusy(true); setMutationError(null);
    try { await fn(); await refresh(); return true; }
    catch (cause) { setMutationError(cause instanceof Error ? cause.message : String(cause)); await refresh(); return false; }
    finally { locked.current = false; setBusy(false); }
  }
  async function start(request: NewThreadRequest) {
    setMutationError(null);
    try {
      if (manual && (!since || Number.isNaN(new Date(since).getTime()))) throw new Error("Выбери начальную дату и время.");
      const run = await rpc.call("syncStart", { requestId: requestId.current, since: manual ? new Date(since).toISOString() : null, request: request as unknown as StartInput["request"] });
      requestId.current = crypto.randomUUID(); setStarting(false); await refresh();
      if (run.error) setMutationError(run.error);
    } catch (cause) { setMutationError(cause instanceof Error ? cause.message : String(cause)); throw cause; }
  }
  return <div className="h-full min-h-0 overflow-y-auto"><div className="mx-auto max-w-5xl space-y-5 p-5 md:p-8">
    <Button variant="ghost" size="sm" className="-ml-3" onClick={() => navigate.toPluginPanel("desk")}><Icon name="ChevronLeft" /> Все задачи</Button>
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h1 className="text-2xl font-medium">Обновления из рабочих источников</h1><p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">Почта, Slack и Jira подскажут, что изменилось в задачах и где появились новые просьбы. Проверь предложения и прими нужные.</p></div>{!starting && !active && <Button onClick={() => setStarting(true)}>Проверить обновления</Button>}</div>
    <ErrorNotice error={mutationError ?? error} retry={() => void refresh()} />
    <div className="grid gap-3 md:grid-cols-3">{(["gmail", "slack", "jira"] as SyncSource[]).map((source) => {
      const report = latest?.reports.find((r) => r.source === source);
      const checkpoint = data?.sync.checkpoints[source];
      return <section key={source} className="rounded-xl border border-border bg-card p-4"><h2 className="font-medium">{sourceNames[source]}</h2><p className="mt-2 text-xs text-muted-foreground">{checkpoint ? `Полностью проверено до ${date(checkpoint)}` : latest && data ? `Не проверено с ${date(data.sync.nextSince[source])}` : "Первый запуск: последние 24 часа"}</p>{latest && <><p className={cn("mt-3 text-sm", report && report.status !== "complete" && "text-destructive")}>{active ? active.collection?.phase === "collecting" ? "Загружаем данные…" : "Модель анализирует выгрузку…" : report?.status === "complete" ? "Проверено" : report?.status === "partial" ? "Проверено частично" : report?.status === "unavailable" ? "Недоступен" : syncStatusNames[latest.status]}</p>{report && <p className="mt-1 whitespace-pre-wrap break-words text-xs leading-relaxed text-muted-foreground">{report.detail}<br />Кандидатов: {report.scanned} · чтений тредов/тикетов: {report.threadsRead}</p>}</>}</section>;
    })}</div>
    {starting && !active && <section className="space-y-4 rounded-xl border border-border p-4"><div className="flex items-center justify-between"><h2 className="font-medium">Начать проверку</h2><Button size="sm" variant="ghost" onClick={() => setStarting(false)}>Отмена</Button></div><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={manual} onChange={(e) => setManual(e.target.checked)} />Указать начальную дату</label>{manual ? <div><label htmlFor="sync-since" className="mb-1.5 block text-xs text-muted-foreground">С даты и времени · {Intl.DateTimeFormat().resolvedOptions().timeZone}</label><Input id="sync-since" type="datetime-local" value={since} onChange={(e) => setSince(e.target.value)} /></div> : <p className="text-sm text-muted-foreground">Продолжим с последней полной проверки каждого источника. Если источник был недоступен, его пропущенный интервал будет проверен.</p>}<p className="text-xs leading-relaxed text-muted-foreground">Источники загрузятся через корпоративный вход. Выбери любую доступную модель для анализа готовых данных; здесь можно уточнить, на что обратить внимание.</p><NewThreadComposer defaultProviderId="codex" defaultModel="gpt-5.6-sol" defaultReasoningLevel="medium" defaultPermissionMode="accept-edits" initialPrompt="Проанализируй обновления почты, Slack и Jira и подготовь предложения для задач 247C." placeholder="Дополнительные пожелания к проверке" layout="document" draftKey="247c-source-sync" onSubmit={start} /></section>}
    <CalendarStatus />
    {latest && <section className="flex flex-wrap items-center gap-3 rounded-xl border border-border p-4"><Pill attention={syncActive(latest) || latest.status === "partial" || latest.status === "blocked"}>{syncStatusNames[latest.status]}</Pill><span className="mr-auto text-xs text-muted-foreground">{date(latest.startedAt)}{latest.collection && ` · ${latest.collection.phase === "collecting" && syncActive(latest) ? "загружаем" : "загружено"} ${latest.collection.reads} тредов/тикетов за ${Math.round(latest.collection.elapsedMs / 1000)} с`} · предложений {latest.suggestions}{latest.duplicates ? ` · повторов ${latest.duplicates}` : ""}</span>{latest.threadId && <Button size="sm" variant="outline" onClick={() => navigate.toThread(latest.threadId!)}>Чат проверки</Button>}{active && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void action(() => rpc.call("syncCancel", { runId: active.id }))}>Остановить проверку</Button>}{latest.error && <p className="w-full text-sm text-destructive">{latest.error}</p>}{latest.manualSince && <p className="w-full text-xs text-muted-foreground">С {date(latest.manualSince)} по {date(latest.until)}. Ручная дата позже прежней отметки не сдвигает её, чтобы сохранить непроверенный промежуток.</p>}</section>}
    <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="font-medium">На рассмотрении · {data?.sync.pending ?? 0}</h2><Button variant="outline" size="sm" onClick={() => navigate.toPluginPanel("desk", { subPath: "proposals" })}>Все предложения</Button><label className="flex items-center gap-2 text-sm text-muted-foreground"><input type="checkbox" checked={history} onChange={(e) => setHistory(e.target.checked)} />Показывать рассмотренные</label></div>
    {candidates.map((candidate) => <SyncCandidateCard key={candidate.id} candidate={candidate} currentTask={data?.tasks.find((t) => t.id === candidate.taskId)} action={action} busy={busy} />)}
    {data && !candidates.length && <div className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">{latest ? "Предложений на рассмотрении пока нет." : "Начни проверку — находки появятся здесь."}</div>}
    {data && data.sync.pending > candidates.filter((c) => c.status === "pending").length && <p className="text-xs text-muted-foreground">Показана первая часть предложений. После рассмотрения появятся следующие.</p>}
    {data && data.sync.runs.length > 1 && <details className="rounded-xl border border-border p-4"><summary className="cursor-pointer text-sm">История проверок · {data.sync.runs.length}</summary><div className="mt-3 space-y-4">{data.sync.runs.slice(1).map((run) => <div key={run.id} className="border-t border-border pt-3"><div className="flex flex-wrap items-center gap-2 text-sm"><span>{date(run.startedAt)} · {syncStatusNames[run.status]} · предложений {run.suggestions}</span>{run.threadId && <Button size="sm" variant="ghost" onClick={() => navigate.toThread(run.threadId!)}>Открыть чат</Button>}</div>{run.reports.map((r) => <p key={r.source} className="mt-1 text-xs text-muted-foreground">{sourceNames[r.source]} · с {date(run.ranges[r.source].since)} по {date(run.until)} · {r.status === "complete" ? "проверено" : r.status === "partial" ? "частично" : "недоступен"}: {r.detail}</p>)}{run.error && <p className="mt-1 text-xs text-destructive">{run.error}</p>}</div>)}</div></details>}
  </div></div>;
}

function Desk() {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [history, setHistory] = useState(false);
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState<GroupKey | null>(null);
  const [creating, setCreating] = useState(false);
  const load = useCallback(() => rpc.call("list", { history }), [rpc, history]);
  const { data, error, refresh } = useSnapshot(load);
  const tasks = data?.tasks ?? [];
  const open = tasks.filter((t) => t.status === "open");
  const pending = data?.pendingTotal ?? 0;
  const visible = tasks.filter((t) => (!group || groupFor(t) === group) && `${t.title} ${t.summary ?? ""} ${t.nextStep ?? ""}`.toLocaleLowerCase("ru").includes(query.toLocaleLowerCase("ru")))
    .sort((a, b) => groups.findIndex((g) => g.key === groupFor(a)) - groups.findIndex((g) => g.key === groupFor(b)));
  return <div className="h-full min-h-0 overflow-y-auto"><div className="mx-auto max-w-6xl space-y-6 p-5 md:p-8">
    <div className="flex flex-wrap items-start justify-between gap-4"><div><h1 className="text-2xl font-medium tracking-tight">Чем займёмся дальше?</h1><p className="mt-1.5 text-sm text-muted-foreground">Задачи помнят контекст. Каждая сессия продолжает работу.</p></div><div className="flex flex-wrap gap-2"><Button variant="outline" onClick={() => navigate.toPluginPanel("desk", { subPath: `day/${localDay()}` })}>День</Button><Button variant={pending ? "default" : "outline"} onClick={() => navigate.toPluginPanel("desk", { subPath: "proposals" })}>Предложения{pending ? ` · ${pending}` : ""}</Button><Button variant="outline" onClick={() => navigate.toPluginPanel("desk", { subPath: "updates" })}>Проверить обновления</Button><Button variant="outline" onClick={() => navigate.toPluginPanel("desk", { subPath: "knowledge" })}>База знаний</Button><Button onClick={() => setCreating(true)}><span aria-hidden="true">＋</span> Новая задача</Button></div></div>
    <ErrorNotice error={error} retry={() => void refresh()} />
    {creating && <CreateTask cancel={() => setCreating(false)} done={(id) => navigate.toPluginPanel("desk", { subPath: id })} />}
    <div className="grid grid-cols-2 gap-2 lg:grid-cols-5" aria-label="Квадранты задач">
      {groups.map((g) => <button key={g.key} type="button" aria-pressed={group === g.key} onClick={() => setGroup(group === g.key ? null : g.key)} className={cn("rounded-xl border border-l-4 p-3.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", g.card, group === g.key && g.selected)}><div className="flex items-center justify-between gap-2"><span className="text-sm font-medium">{g.title}</span><span className="font-mono text-lg tabular-nums">{open.filter((t) => groupFor(t) === g.key).length}</span></div><p className="mt-1 text-xs text-muted-foreground">{g.subtitle}</p></button>)}
    </div>
    <div className="flex flex-wrap items-center gap-3"><div className="relative min-w-48 flex-1"><Icon name="Search" className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted-foreground" /><Input className="pl-9" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Найти задачу" aria-label="Найти задачу" /></div><label className="flex cursor-pointer items-center gap-2 text-sm text-muted-foreground"><input type="checkbox" checked={history} onChange={(e) => setHistory(e.target.checked)} className="accent-current" /> Показывать завершённые</label></div>
    {!data && !error ? <div role="status" className="py-16 text-center text-sm text-muted-foreground">Открываем рабочий стол…</div> : visible.length === 0 ? <div className="rounded-2xl border border-dashed border-border px-6 py-16 text-center"><div className="mx-auto mb-5 flex size-12 items-center justify-center rounded-xl bg-muted"><Icon name="Target" className="size-6 text-muted-foreground" /></div><h2 className="text-lg font-medium">{tasks.length ? "Здесь пока пусто" : "Место для того, что важно"}</h2><p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-muted-foreground">{tasks.length ? "Попробуй другой поиск или приоритет." : "Начни с одной задачи. Сохрани контекст, поручай работу агентам и возвращайся к результату без пересказов."}</p>{!tasks.length && !creating && <Button className="mt-6" variant="outline" onClick={() => setCreating(true)}>Добавить первую задачу</Button>}</div> : <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
      {visible.map((task) => { const quadrant = groups.find((g) => g.key === groupFor(task))!; return <button key={task.id} type="button" onClick={() => navigate.toPluginPanel("desk", { subPath: task.id })} className={cn("group flex min-h-44 flex-col rounded-xl border border-l-4 p-4 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", quadrant.card)}>
        <div className="mb-3 flex min-h-5 items-center gap-2 text-xs text-muted-foreground"><span aria-hidden="true" className={cn("size-2 shrink-0 rounded-full", quadrant.dot)} />{task.activeSession ? <><span className="size-1.5 animate-pulse rounded-full bg-primary" /> Сессия открыта</> : task.pendingCount ? <span className="text-primary">Ожидает решения · {task.pendingCount}</span> : task.status === "open" ? quadrant.subtitle : task.status === "done" ? "Завершена" : "В архиве"}</div>
        <h2 className={cn("break-words text-base font-medium leading-snug", task.status !== "open" && "text-muted-foreground")}>{task.title}</h2>
        {task.summary && <p className="mt-2 line-clamp-3 text-sm leading-relaxed text-muted-foreground">{task.summary}</p>}
        <div className="mt-auto pt-4">{task.nextStep ? <p className="line-clamp-2 text-xs"><span className="text-muted-foreground">Дальше: </span>{task.nextStep}</p> : <p className="text-xs text-muted-foreground">{date(task.updatedAt)}</p>}</div>
      </button>; })}
    </div>}
    {data && data.total > tasks.length && <p className="text-sm text-muted-foreground">Показаны последние {tasks.length} из {data.total} задач.</p>}
  </div></div>;
}

function DisplayValue({ value }: { value: unknown }) {
  if (value == null || value === "" || (Array.isArray(value) && value.length === 0)) return <span className="text-muted-foreground">Пока не указано</span>;
  if (Array.isArray(value)) return <ul className="space-y-1">{value.map((item, i) => <li key={i}>• {typeof item === "string" ? item : typeof item === "object" && item && "label" in item ? String(item.label) : JSON.stringify(item)}</li>)}</ul>;
  return <span className="whitespace-pre-wrap break-words">{String(value)}</span>;
}

function ProposalCard({ proposal, dossier, action, busy, discuss }: { discuss?: (sessionId: string) => void; proposal: Dossier["proposals"][number]; dossier: ReviewDossier; action: (fn: () => Promise<unknown>) => Promise<boolean>; busy: boolean }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const update = dossier.sessionUpdates.find((u) => u.proposalId === proposal.id);
  const pending = proposal.status === "pending" || proposal.status === "approved";
  const stale = proposal.baseRevision !== dossier.task.revision;
  const completing = proposal.changes.status?.value === "done";
  const discussing = dossier.sessions.some((s) => ACTIVE.has(s.status) && s.discussionProposalId === proposal.id);
  const changingStatusDuringWork = Boolean(proposal.changes.status) && dossier.sessions.some((s) => ACTIVE.has(s.status));
  const allEvidence = [...dossier.facts.map((f) => ({ ref: f.id, text: f.text })), ...proposal.evidence];
  const used = new Set(Object.values(proposal.changes).flatMap((change) => change?.evidenceRefs ?? []));
  return <article className="overflow-hidden rounded-xl border border-border bg-card">
    <div className="border-b border-border p-4"><div className="flex flex-wrap items-center justify-between gap-2"><Pill attention={pending}>{pending ? "Предложение" : proposal.status === "applied" ? "Принято" : proposal.status === "rejected" ? "Отклонено" : "Устарело"}</Pill><span className="text-xs text-muted-foreground">{date(proposal.createdAt)}</span></div><p className="mt-3 text-sm leading-relaxed">{proposal.rationale}</p></div>
    <div className="divide-y divide-border">{Object.entries(update ? update.extraction.changes ?? {} : proposal.changes).map(([field, change]) => <div key={field} className="p-4"><h3 className="mb-3 text-sm font-medium">{fieldNames[field as keyof typeof fieldNames]}</h3><div className="grid gap-4 sm:grid-cols-2"><div><p className="mb-1.5 text-xs text-muted-foreground">Сейчас</p><div className="text-sm leading-relaxed text-muted-foreground"><DisplayValue value={field === "status" ? taskStatusNames[dossier.task.status] : field === "title" ? dossier.task.title : field === "urgent" || field === "important" ? axisName(dossier.planning[field]) : dossier.projection[field as Exclude<keyof typeof fieldNames, "status" | "title" | "urgent" | "important">]} /></div></div><div className="rounded-lg bg-primary/5 p-3"><p className="mb-1.5 text-xs text-primary">Предлагается</p><div className="text-sm leading-relaxed"><DisplayValue value={field === "status" ? taskStatusNames[change?.value as keyof typeof taskStatusNames] : field === "urgent" || field === "important" ? axisName(change?.value as boolean | null) : change?.value} /></div></div></div></div>)}</div>
    {update && <div className="space-y-5 border-t border-border p-4">
      {update.extraction.facts.length > 0 && <section><h3 className="mb-3 text-sm font-medium">Записи в досье · {update.extraction.facts.length}</h3><div className="space-y-3">{update.extraction.facts.map((fact, i) => <div key={i} className="rounded-lg bg-muted/30 p-3"><p className="text-xs text-muted-foreground">{factNames[fact.kind]}</p><p className="mt-1 whitespace-pre-wrap break-words text-sm">{fact.text}</p><details className="mt-2"><summary className="cursor-pointer text-xs text-muted-foreground">Цитаты из разговора</summary>{fact.citations.map((citation, j) => <blockquote key={j} className="mt-2 border-l-2 border-border pl-3 text-sm"><p className="mb-1 text-xs text-muted-foreground">{update.speakers[citation.messageRef] === "user" ? "Ты" : update.speakers[citation.messageRef] === "assistant" ? "Ассистент" : "Контекст"}</p><p className="whitespace-pre-wrap break-words">{citation.quote}</p>{update.sources[citation.messageRef] && update.sources[citation.messageRef].threadId !== update.threadId && <Button variant="ghost" size="sm" onClick={() => navigate.toThread(update.sources[citation.messageRef].threadId)}>Из предыдущего разговора</Button>}</blockquote>)}</details></div>)}</div></section>}
      {update.extraction.knowledge.length > 0 && <section><h3 className="mb-3 text-sm font-medium">В базу знаний · {update.extraction.knowledge.length}</h3><div className="space-y-3">{update.extraction.knowledge.map((entry, i) => <article key={i} className="rounded-lg border border-primary/20 bg-primary/5 p-3"><h4 className="text-sm font-medium">{entry.title}</h4><p className="mt-2 whitespace-pre-wrap break-words text-sm leading-relaxed">{entry.body}</p>{entry.tags.length > 0 && <p className="mt-2 text-xs text-muted-foreground">{entry.tags.join(" · ")}</p>}</article>)}</div></section>}
      {update.warnings.map((warning) => <p key={warning} className="text-xs text-muted-foreground">{warning}</p>)}
      <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" onClick={() => navigate.toThread(update.threadId)}>Открыть исходный разговор</Button>{discuss && <Button size="sm" variant="outline" disabled={busy || dossier.sessions.some((s) => ACTIVE.has(s.status))} onClick={() => discuss(update.sessionId)}>Обсудить разбор</Button>}</div>
      {pending && <p className="text-xs text-muted-foreground">{completing ? "Одно подтверждение сохранит записи и знания и отметит задачу выполненной." : "«Принять изменения» сохранит поля досье, записи и базу знаний вместе."}</p>}
    </div>}
    <details className="border-t border-border px-4 py-3"><summary className="cursor-pointer text-xs text-muted-foreground">На чём основано · {used.size}</summary><ul className="mt-3 space-y-2">{allEvidence.filter((e) => used.has(e.ref)).map((e) => <li key={e.ref} className="whitespace-pre-wrap break-words rounded-lg bg-muted/40 p-3 text-sm leading-relaxed">{e.text}</li>)}</ul><p className="mt-3 break-words text-xs text-muted-foreground">{proposal.model}</p></details>
    {pending && <div className="border-t border-border p-4">{discussing && <p className="mb-3 text-sm text-muted-foreground">Открыто обсуждение разбора. Заверши его, чтобы получить уточнённое предложение.</p>}{stale && <p className="mb-3 text-sm text-destructive">Досье изменилось после подготовки. Нужен результат по новой версии.</p>}<div className="flex flex-wrap justify-end gap-2"><Button variant="ghost" disabled={busy} onClick={() => void action(() => rpc.call("reject", { proposalId: proposal.id }))}>Отклонить</Button><Button disabled={busy || stale || discussing || changingStatusDuringWork} onClick={() => void action(() => rpc.call("accept", { proposalId: proposal.id, revision: dossier.task.revision }))}><Icon name="Check" />{completing ? "Принять и завершить задачу" : proposal.changes.status?.value === "archived" ? "Принять и архивировать задачу" : "Принять изменения"}</Button></div></div>}
    {proposal.receipt && <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-3"><span className="text-xs text-muted-foreground">Принято {date(proposal.receipt.createdAt)} · версия {proposal.receipt.afterRevision}</span><Button variant="ghost" size="sm" disabled={busy} onClick={() => void action(() => rpc.call("revert", { proposalId: proposal.id }))}>{completing ? "Предложить отмену завершения и изменений" : update ? "Предложить отмену полей досье" : "Предложить отмену"}</Button>{update && <p className="w-full text-xs text-muted-foreground">Отмена сохраняет исторические записи разговора и базу знаний.</p>}</div>}
  </article>;
}

const axisName = (value: boolean | null) => value === null ? "Не выбрано" : value ? "Да" : "Нет";

function Axis({ label, value, disabled, change }: { label: string; value: boolean | null; disabled: boolean; change: (v: boolean | null) => void }) {
  return <label className="flex min-w-40 flex-1 items-center justify-between gap-3 rounded-lg border border-border px-3 py-2 text-sm"><span className="text-muted-foreground">{label}</span><select aria-label={label} disabled={disabled} className="max-w-36 bg-transparent text-sm focus-visible:outline-none" value={value === null ? "unknown" : value ? "yes" : "no"} onChange={(e) => change(e.target.value === "unknown" ? null : e.target.value === "yes")}><option value="unknown">Не выбрано</option><option value="yes">Да</option><option value="no">Нет</option></select></label>;
}

function TaskOverview({ dossier, action, busy, showWork }: { dossier: Dossier; action: (fn: () => Promise<unknown>) => Promise<boolean>; busy: boolean; showWork: () => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [note, setNote] = useState("");
  const [kind, setKind] = useState<Dossier["facts"][number]["kind"]>("description");
  const requestId = useRef(crypto.randomUUID());
  const active = dossier.sessions.some((s) => ACTIVE.has(s.status));
  const closed = dossier.task.status !== "open";
  async function addNote(event: FormEvent) {
    event.preventDefault();
    if (!note.trim()) return;
    if (await action(() => rpc.call("note", { taskId: dossier.task.id, revision: dossier.task.revision, kind, text: note, requestId: requestId.current }))) { setNote(""); requestId.current = crypto.randomUUID(); }
  }
  const proposeFact = (fact: Dossier["facts"][number], field: "summary" | "nextStep") => action(() => rpc.call("propose", { taskId: dossier.task.id, revision: dossier.task.revision, requestId: crypto.randomUUID(), draft: { rationale: field === "summary" ? "Использовать эту запись как текущую сводку задачи." : "Сохранить явно указанный следующий шаг.", confidence: 1, changes: { [field]: { value: fact.text, evidenceRefs: [fact.id] } } } }));
  return <div className="grid gap-6 lg:grid-cols-[minmax(0,1.5fr)_minmax(240px,1fr)]">
    <div className="space-y-5"><section className="rounded-xl border border-border bg-card p-5"><div className="mb-3 flex items-center gap-2"><Icon name="Target" className="size-4 text-muted-foreground" /><h2 className="text-sm font-medium">Где мы сейчас</h2></div>{dossier.projection.summary ? <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{dossier.projection.summary}</p> : <p className="text-sm leading-relaxed text-muted-foreground">Принятой сводки пока нет. Добавь контекст или начни рабочую сессию.</p>}<div className="mt-5 border-t border-border pt-4"><p className="mb-1.5 text-xs text-muted-foreground">Следующий шаг</p><p className="whitespace-pre-wrap text-sm leading-relaxed">{dossier.projection.nextStep ?? "Ещё не выбран"}</p></div>{!closed && <Button variant="outline" className="mt-5" onClick={showWork}><Icon name="MessageSquare" />{active ? "Открыть рабочий чат" : "Начать рабочую сессию"}</Button>}</section>
      {!closed && <form className="rounded-xl border border-border bg-card p-4" onSubmit={addNote}><div className="mb-3 flex flex-wrap items-center justify-between gap-2"><label className="text-sm font-medium" htmlFor="new-note">Добавить в контекст</label><select aria-label="Вид записи" className="rounded-md border border-input bg-transparent px-2 py-1 text-xs" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>{Object.entries(factNames).filter(([key]) => key !== "artifact").map(([key, title]) => <option key={key} value={key}>{title}</option>)}</select></div><textarea id="new-note" rows={3} maxLength={12000} className={textareaClass} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Факт, решение или важная деталь, которую нужно сохранить…" /><div className="mt-3 flex justify-end"><Button size="sm" disabled={busy || !note.trim()} type="submit">Сохранить запись</Button></div>{active && <p className="mt-2 text-xs text-muted-foreground">Новая запись изменит досье и остановит сессию со старым контекстом.</p>}</form>}
      <section><div className="mb-3 flex items-center justify-between"><h2 className="text-sm font-medium">Контекст и решения</h2><span className="text-xs text-muted-foreground">{dossier.facts.length} записей</span></div>{dossier.facts.length === 0 ? <p className="text-sm text-muted-foreground">Здесь сохранятся важные детали задачи.</p> : <ol className="space-y-3">{[...dossier.facts].reverse().map((fact) => <li key={fact.id} className="rounded-xl border border-border bg-card p-4"><div className="mb-2 flex justify-between gap-2 text-xs text-muted-foreground"><span>{factNames[fact.kind]}</span><time>{date(fact.createdAt)}</time></div><p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{fact.text}</p>{!closed && <div className="mt-2 flex flex-wrap justify-end gap-1"><Button variant="ghost" size="sm" disabled={busy} onClick={() => void proposeFact(fact, "summary")}>Предложить сводкой</Button>{["explicit_next_step", "user_instruction"].includes(fact.kind) && <Button variant="ghost" size="sm" disabled={busy} onClick={() => void proposeFact(fact, "nextStep")}>Предложить следующим шагом</Button>}</div>}</li>)}</ol>}</section>
    </div>
    <aside className="space-y-5"><section className="space-y-2"><h2 className="mb-3 text-sm font-medium">Приоритет</h2><Axis label="Срочно" value={dossier.planning.urgent} disabled={busy} change={(urgent) => void action(() => rpc.call("classify", { taskId: dossier.task.id, ...dossier.planning, urgent }))} /><Axis label="Важно" value={dossier.planning.important} disabled={busy} change={(important) => void action(() => rpc.call("classify", { taskId: dossier.task.id, ...dossier.planning, important }))} /></section>
      <section className="rounded-xl border border-border p-4"><h2 className="mb-3 text-sm font-medium">Открытые вопросы</h2><div className="text-sm leading-relaxed"><DisplayValue value={dossier.projection.openQuestions} /></div></section>
      <section className="rounded-xl border border-border p-4"><h2 className="mb-3 text-sm font-medium">Препятствия</h2><div className="text-sm leading-relaxed"><DisplayValue value={dossier.projection.blockers} /></div></section>
      <section className="rounded-xl border border-border p-4"><h2 className="mb-3 text-sm font-medium">Артефакты</h2>{!dossier.projection.artifacts.length ? <p className="text-sm text-muted-foreground">Появятся после принятия результата.</p> : <ul className="space-y-3">{dossier.projection.artifacts.map((artifact) => {
        const source = dossier.sessions.find((s) => s.hostId && s.artifacts.some((a) => { try { return new URL(artifact.uri).pathname === a.path || decodeURIComponent(new URL(artifact.uri).pathname) === a.path; } catch { return false; } }));
        if (source?.hostId && artifact.uri.startsWith("file:")) return <li key={artifact.uri}><FileLink className="break-words text-sm underline decoration-border underline-offset-4 hover:decoration-foreground" target={{ kind: "host", hostId: source.hostId, path: decodeURIComponent(new URL(artifact.uri).pathname) }}>{artifact.label}</FileLink></li>;
        return <li key={artifact.uri} className="break-words text-sm">{artifact.label}</li>;
      })}</ul>}</section>
    </aside>
  </div>;
}

function Work({ dossier, refresh, showProposals, discussionId }: { dossier: Dossier; refresh: () => Promise<void>; showProposals: () => void; discussionId: string | null }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [selected, setSelected] = useState<string | null>(null);
  const [starting, setStarting] = useState(Boolean(discussionId));
  const [continuing, setContinuing] = useState<string | null>(discussionId);
  const [reviewer, setReviewer] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const requestId = useRef(crypto.randomUUID());
  const active = dossier.sessions.find((s) => ACTIVE.has(s.status));
  const session = dossier.sessions.find((s) => s.id === selected) ?? active ?? dossier.sessions[0];
  const previous = dossier.sessions.find((s) => s.id === continuing);
  const showComposer = !active && (starting || !session) && (dossier.task.status === "open" || Boolean(previous));
  async function start(request: NewThreadRequest) {
    setError(null);
    try {
      const result = await rpc.call("start", { taskId: dossier.task.id, revision: dossier.task.revision, criteria: [], requestId: requestId.current, ...(continuing ? { continueSessionId: continuing } : {}), request: request as unknown as StartInput["request"] });
      setSelected(result.id); setStarting(false); setContinuing(null); setReviewer(false); requestId.current = crypto.randomUUID(); await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); throw cause; }
  }
  async function change(method: "finish" | "retry" | "cancel") {
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
  const canRetry = conversation && session.finishedAt && !dossier.sessions.some((s) => s.continuedFrom === session.id && s.proposalId) && (session.status === "blocked" || session.status === "rejected" || (session.status === "awaiting_approval" && session.baseRevision !== dossier.task.revision));
  return <div className="space-y-4"><ErrorNotice error={error} />
    <div className="flex flex-wrap items-center gap-2">{dossier.sessions.map((s, i) => <button type="button" key={s.id} className={cn("rounded-lg border px-3 py-2 text-xs", !showComposer && session?.id === s.id ? "border-primary/30 bg-primary/5" : "border-border text-muted-foreground")} onClick={() => { setSelected(s.id); setStarting(false); setContinuing(null); setReviewer(false); }}>Сессия {dossier.sessions.length - i} · {sessionLabel(s)}</button>)}{!active && dossier.task.status === "open" && session && <Button size="sm" variant="outline" onClick={() => { setContinuing(null); setStarting(true); }}>Новая сессия</Button>}</div>
    {showComposer ? <div className="space-y-5">
      <div className="max-w-3xl"><h2 className="text-lg font-medium">{previous ? "Обсудим разбор" : "Просто начни разговор"}</h2>{previous && <p className="mt-2 text-sm text-muted-foreground">Предыдущий разговор, разбор и его цитаты уже будут у ассистента. Напиши, что хочешь уточнить или исправить.</p>}<p className="mt-2 text-sm leading-relaxed text-muted-foreground">Досье уже будет у ассистента. Обсуждай задачу и продолжай работу столько, сколько нужно. Когда закончишь, нажми «Завершить сессию» — отдельная сессия прочитает диалог и предложит записи для досье и базы знаний.</p></div>
      <div className="min-h-80 overflow-hidden rounded-xl border border-border bg-card p-3 md:p-4"><NewThreadComposer key={`${dossier.task.id}-${continuing ?? "new"}`} defaultProviderId={previous?.workerProvider ?? "claude-work"} defaultModel={previous?.workerModel ?? "claude-opus-5[1m]"} defaultReasoningLevel="medium" defaultPermissionMode="accept-edits" initialPrompt={previous ? "Хочу обсудить разбор предыдущей сессии. " : ""} placeholder={previous ? "Что нужно уточнить в разборе?" : "С чего начнём?"} layout="document" draftKey={`247c-session-${dossier.task.id}-${continuing ?? "new"}`} onSubmit={start} /></div>
      <p className="text-xs leading-relaxed text-muted-foreground">Модель для разбора выбирается автоматически: после Claude — Codex Sol, после Codex — личный Sonnet. Подготовленные записи появятся в «Предложениях».</p>
    </div> : session ? <>
      <div className="rounded-xl border border-border bg-card p-4">
        <div className="flex flex-wrap items-center justify-between gap-3"><div className="flex items-center gap-2"><Pill attention={ACTIVE.has(session.status) || session.status === "awaiting_approval"}>{sessionLabel(session)}</Pill><span className="text-xs text-muted-foreground">{date(session.createdAt)}</span></div>
          <div className="flex flex-wrap items-center gap-2">
            {conversation && session.finishedAt && !ACTIVE.has(session.status) && <Button size="sm" variant="outline" disabled={busy || Boolean(active)} onClick={() => { setContinuing(session.id); setStarting(true); }}>Обсудить разбор</Button>}
            {canRetry && <Button size="sm" variant="outline" disabled={busy || Boolean(active)} onClick={() => void change("retry")}>Повторить разбор</Button>}
            {ACTIVE.has(session.status) && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void change("cancel")}>{conversation ? "Отменить сессию" : "Остановить сессию"}</Button>}
            {conversation && session.status === "working" && <Button size="sm" disabled={busy} onClick={() => void change("finish")}>{busy ? "Завершаем…" : "Завершить сессию"}</Button>}
          </div>
        </div>
        <details className="mt-3"><summary className="cursor-pointer text-xs text-muted-foreground">С чего начали</summary><p className="mt-2 whitespace-pre-wrap break-words text-sm leading-relaxed">{session.objective}</p></details>
        {!conversation && <details className="mt-3"><summary className="cursor-pointer text-xs text-muted-foreground">Условия готовности · {session.criteria.length}</summary><ol className="mt-2 list-inside list-decimal space-y-1 text-sm">{session.criteria.map((c, i) => <li key={i}>{c}</li>)}</ol></details>}
        {conversation && session.status === "working" && <p className="mt-3 text-xs text-muted-foreground">Можно продолжать разговор. «Завершить сессию» остановит текущий ответ и запустит разбор переписки. Модель выбирается автоматически; приоритет у Sol и Sonnet.</p>}
        {conversation && ["collecting", "review_starting", "reviewing"].includes(session.status) && <p className="mt-3 text-sm text-muted-foreground">{session.extractionRepair ? `Уточняем записи по переписке. Попытка ${session.extractionRepair.attempt} из ${Math.min(2, session.maximumRepairs)}. Предложения появятся здесь.` : "Сохраняем итог разговора. Предложения для досье и базы знаний появятся здесь."}</p>}
        {session.error && <div className="mt-4"><ErrorNotice error={session.error} /></div>}
        {session.review && <div className="mt-4 space-y-2 border-t border-border pt-3">{session.review.criteria.map((c) => <div key={c.index} className="flex items-start gap-2 text-sm"><Icon name={c.passed ? "Check" : "AlertCircle"} className={cn("mt-0.5 size-4 shrink-0", c.passed ? "text-primary" : "text-destructive")} /><div><p>{session.criteria[c.index]}</p><p className="mt-1 text-xs leading-relaxed text-muted-foreground">{c.reason}</p></div></div>)}</div>}
        {session.status === "completed" && <p className="mt-3 text-sm text-muted-foreground">{session.extraction?.rationale ?? "Разговор сохранён. Новых записей для базы нет."}</p>}
        {session.status === "awaiting_approval" && <div className="mt-4 flex flex-wrap items-center gap-3"><p className="text-sm">{conversation ? "Записи для досье и базы знаний готовы." : "Результат проверен."}</p><Button size="sm" onClick={showProposals}>Посмотреть предложения</Button></div>}
      </div>
      <div className="overflow-hidden rounded-xl border border-border"><div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-card px-3 py-2"><div className="flex items-center gap-1"><Button variant="ghost" size="sm" aria-pressed={!reviewer} onClick={() => setReviewer(false)}>{conversation ? "Разговор" : "Исполнитель"} · {session.workerModel}</Button>{session.reviewerThreadId && <Button variant="ghost" size="sm" aria-pressed={reviewer} onClick={() => setReviewer(true)}>{conversation ? "Разбор" : "Проверка"} · {session.reviewerModel}</Button>}</div>{threadId && <Button variant="ghost" size="sm" onClick={() => navigate.toThread(threadId)}>Открыть тред <Icon name="ChevronRight" /></Button>}</div>{threadId ? <div className="h-[min(70vh,760px)] min-h-96"><ThreadChat key={threadId} threadId={threadId} variant={!reviewer && session.status === "working" ? "full" : "timeline"} layout="contained" permissionPolicy="inherit" /></div> : <p className="p-6 text-sm text-muted-foreground">Чат ещё не создан. Причина запуска появится здесь.</p>}</div>
    </> : <p className="text-sm text-muted-foreground">У этой задачи пока нет рабочих сессий.</p>}
  </div>;
}

function TaskPage({ taskId, returnTo }: { taskId: string; returnTo?: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const backLabel = returnTo?.startsWith("report/") ? "К отчёту" : returnTo?.startsWith("day/") ? "К плану дня" : "Все задачи";
  const [discussionId, setDiscussionId] = useState<string | null>(null);
  const discuss = (sessionId: string) => { setDiscussionId(sessionId); setTab("work"); };
  const [tab, setTab] = useState<"overview" | "work" | "proposals" | "history">("overview");
  const [busy, setBusy] = useState(false);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const load = useCallback(() => rpc.call("detail", { id: taskId }), [rpc, taskId]);
  const { data: dossier, error, refresh } = useSnapshot(load);
  async function action(fn: () => Promise<unknown>): Promise<boolean> {
    if (busy) return false;
    setBusy(true); setMutationError(null);
    try { await fn(); await refresh(); return true; }
    catch (cause) { setMutationError(cause instanceof Error ? cause.message : String(cause)); await refresh(); return false; }
    finally { setBusy(false); }
  }
  if (!dossier) return <div className="space-y-4 p-6"><Button variant="ghost" onClick={() => navigate.toPluginPanel("desk", { subPath: returnTo ?? "" })}><Icon name="ChevronLeft" /> {backLabel}</Button>{error ? <ErrorNotice error={error} retry={() => void refresh()} /> : <p role="status" className="text-sm text-muted-foreground">Открываем досье…</p>}</div>;
  const pending = dossier.proposals.filter((p) => p.status === "pending" || p.status === "approved");
  const syncPending = dossier.syncUpdates.filter((p) => p.status === "pending");
  const pendingCount = pending.length + syncPending.length;
  const active = dossier.sessions.some((s) => ACTIVE.has(s.status));
  return <div className="h-full min-h-0 overflow-y-auto"><div className="mx-auto max-w-6xl space-y-5 p-5 md:p-8">
    <Button variant="ghost" size="sm" className="-ml-3" onClick={() => navigate.toPluginPanel("desk", { subPath: returnTo ?? "" })}><Icon name="ChevronLeft" /> {backLabel}</Button>
    <div className="flex flex-wrap items-start justify-between gap-4"><div className="min-w-0 flex-1"><div className="mb-2 flex items-center gap-2"><Pill>{dossier.task.status === "open" ? "Открыта" : dossier.task.status === "done" ? "Завершена" : "В архиве"}</Pill><span className="text-xs text-muted-foreground">Версия {dossier.task.revision}</span></div><h1 className="break-words text-2xl font-medium leading-snug tracking-tight">{dossier.task.title}</h1></div><div className="flex gap-2">{dossier.task.status === "open" ? <><Button variant="outline" size="sm" disabled={busy || active} onClick={() => void action(() => rpc.call("status", { taskId, status: "done", revision: dossier.task.revision }))}><Icon name="Check" /> Завершить</Button><Button variant="ghost" size="icon" aria-label="Архивировать задачу" disabled={busy || active} onClick={() => void action(() => rpc.call("status", { taskId, status: "archived", revision: dossier.task.revision }))}><Icon name="Archive" /></Button></> : <Button variant="outline" size="sm" disabled={busy} onClick={() => void action(() => rpc.call("status", { taskId, status: "open", revision: dossier.task.revision }))}>Вернуть в работу</Button>}</div></div>
    <TaskTimeSummary taskId={taskId} />
    <div role="tablist" aria-label="Разделы задачи" className="flex gap-1 overflow-x-auto border-b border-border">{([{ id: "overview", name: "Досье" }, { id: "work", name: "Работа" }, { id: "proposals", name: `Предложения${pendingCount ? ` · ${pendingCount}` : ""}` }, { id: "history", name: "История" }] as const).map((item) => <button key={item.id} type="button" role="tab" aria-selected={tab === item.id} onClick={() => { setDiscussionId(null); setTab(item.id); }} className={cn("whitespace-nowrap border-b-2 px-4 py-3 text-sm transition-colors", tab === item.id ? "border-foreground font-medium" : "border-transparent text-muted-foreground hover:text-foreground")}>{item.name}</button>)}</div>
    <ErrorNotice error={mutationError ?? error} retry={() => void refresh()} />
    {pendingCount > 0 && tab === "overview" && <button type="button" className="flex w-full items-center justify-between gap-4 rounded-xl border border-primary/20 bg-primary/5 p-4 text-left" onClick={() => setTab("proposals")}><div><p className="text-sm font-medium">Есть изменения на рассмотрение</p><p className="mt-1 text-xs text-muted-foreground">Проверь, что попадёт в постоянное досье.</p></div><Icon name="ChevronRight" className="size-4 shrink-0" /></button>}
    {tab === "overview" && <TaskOverview dossier={dossier} busy={busy} action={action} showWork={() => { setDiscussionId(null); setTab("work"); }} />}
    {tab === "work" && <Work key={discussionId ?? "work"} discussionId={discussionId} dossier={dossier} refresh={refresh} showProposals={() => setTab("proposals")} />}
    {tab === "proposals" && <div className="mx-auto max-w-4xl space-y-4">{syncPending.map((p) => <SyncCandidateCard key={p.id} candidate={p} currentTask={{ ...dossier.task, activeSession: active ? "active" : null }} action={action} busy={busy} />)}{pending.map((p) => <ProposalCard discuss={discuss} key={p.id} proposal={p} dossier={dossier} busy={busy} action={action} />)}{!pendingCount && <div className="rounded-xl border border-dashed border-border py-12 text-center"><Icon name="CircleCheck" className="mx-auto mb-3 size-7 text-muted-foreground" /><h2 className="text-sm font-medium">Всё рассмотрено</h2><p className="mt-1 text-sm text-muted-foreground">Новые результаты сессий появятся здесь.</p></div>}</div>}
    {tab === "history" && <div className="mx-auto max-w-4xl space-y-5"><h2 className="text-sm font-medium">Решения и принятые изменения</h2>{dossier.proposals.filter((p) => !["pending", "approved"].includes(p.status)).map((p) => <ProposalCard discuss={discuss} key={p.id} proposal={p} dossier={dossier} busy={busy} action={action} />)}<details className="rounded-xl border border-border p-4"><summary className="cursor-pointer text-sm">Журнал досье · последние {dossier.events.length} событий</summary><ol className="mt-3 space-y-3">{dossier.events.map((event) => <li key={event.id} className="text-xs"><span className="text-muted-foreground">{date(event.createdAt)}</span><span className="ml-2">{event.kind}</span></li>)}</ol></details></div>}
  </div></div>;
}

function KnowledgeBody({ entry }: { entry: KnowledgeEntry }) {
  const [expanded, setExpanded] = useState(false);
  const body = entry.kind === "file" ? entry.body.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "") : entry.body;
  const long = body.length > 1500;
  return <div className="mt-3 space-y-2">
    {long && !expanded ? <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{body.slice(0, 600).trimEnd()}…</p> : <Markdown content={body} className="break-words text-sm leading-relaxed" />}
    {long && <Button type="button" variant="ghost" size="sm" className="-ml-3" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? "Свернуть" : "Читать полностью"}</Button>}
  </div>;
}

function KnowledgePage() {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const [previousOffsets, setPreviousOffsets] = useState<number[]>([]);
  const load = useCallback(() => rpc.call("knowledge", { query, offset }), [rpc, query, offset]);
  const { data, error, refresh } = useSnapshot(load);
  return <div className="h-full min-h-0 overflow-y-auto"><div className="mx-auto max-w-4xl space-y-5 p-5 md:p-8">
    <Button variant="ghost" size="sm" className="-ml-3" onClick={() => navigate.toPluginPanel("desk")}><Icon name="ChevronLeft" /> Все задачи</Button>
    <div><h1 className="text-2xl font-medium">База знаний</h1><p className="mt-2 text-sm leading-relaxed text-muted-foreground">Справочники и заметки из файлов, а также принятые знания из рабочих разговоров. Доступны в следующих сессиях по любой задаче.</p></div>
    <Input aria-label="Поиск по базе знаний" placeholder="Найти правило, термин или способ решения" value={query} onChange={(event) => { setQuery(event.target.value); setOffset(0); setPreviousOffsets([]); }} />
    <ErrorNotice error={error} retry={() => void refresh()} />
    {!data ? <p role="status" className="text-sm text-muted-foreground">Открываем базу знаний…</p> : !data.entries.length ? <div className="rounded-xl border border-dashed border-border p-8 text-center"><h2 className="font-medium">{query ? "Совпадений нет" : "Знания появятся после разговора"}</h2><p className="mt-2 text-sm text-muted-foreground">{query ? "Попробуй другие слова." : "Заверши рабочую сессию и прими полезные записи в «Предложениях»."}</p></div> : <>
      <p className="text-xs text-muted-foreground">Записи {offset + 1}–{offset + data.entries.length} из {data.total}</p>
      <div className="space-y-4">{data.entries.map((entry) => <article key={entry.id} className="rounded-xl border border-border bg-card p-5"><h2 className="font-medium">{entry.title}</h2><KnowledgeBody entry={entry} />{entry.tags.length > 0 && <p className="mt-3 text-xs text-muted-foreground">{entry.tags.join(" · ")}</p>}<div className="mt-4 flex flex-wrap items-center gap-2 border-t border-border pt-3"><span className="mr-auto text-xs text-muted-foreground">{date(entry.createdAt)}</span>{entry.kind === "file" ? <FileLink className="text-xs underline underline-offset-4" target={{ kind: "host", hostId: entry.source.hostId, path: entry.source.path }}>Исходный файл</FileLink> : <><Button size="sm" variant="ghost" onClick={() => navigate.toPluginPanel("desk", { subPath: entry.taskId })}>Досье задачи</Button><Button size="sm" variant="ghost" onClick={() => navigate.toThread(entry.threadId)}>Исходный разговор</Button></>}</div><p className="mt-2 break-words text-xs text-muted-foreground">{entry.kind === "file" ? `${entry.source.label} · ${entry.source.relativePath}` : entry.taskTitle}</p></article>)}</div>
      {(offset > 0 || data.nextOffset !== null) && <div className="flex justify-between"><Button variant="outline" disabled={previousOffsets.length === 0} onClick={() => { setOffset(previousOffsets.at(-1) ?? 0); setPreviousOffsets(previousOffsets.slice(0, -1)); }}>Назад</Button><Button variant="outline" disabled={data.nextOffset === null} onClick={() => { if (data.nextOffset !== null) { setPreviousOffsets([...previousOffsets, offset]); setOffset(data.nextOffset); } }}>Дальше</Button></div>}
    </>}
  </div></div>;
}

const reviewKey = (item: ReviewItem) => `${item.kind}:${item.kind === "source" ? item.candidate.id : item.proposal.id}`;
const reviewTask = (item: ReviewItem) => item.kind === "source" ? item.candidate.taskId : item.proposal.taskId;
const reviewTitle = (item: ReviewItem) => item.kind === "source" ? item.candidate.title : item.dossier.task.title;
const reviewGroup = (item: ReviewItem) => item.kind === "proposal" ? "dossier" : item.candidate.taskId ? "updates" : "new";
const reviewSelection = (item: ReviewItem): ReviewSelection => ({ kind: item.kind, id: item.kind === "source" ? item.candidate.id : item.proposal.id, revision: item.kind === "source" ? item.candidate.baseRevision : item.proposal.baseRevision });
function ProposalInboxPage() {
  const rpc = useRpc<typeof rpcContract>(), navigate = useBbNavigate();
  const [offset, setOffset] = useState(0);
  const [previousOffsets, setPreviousOffsets] = useState<number[]>([]);
  const [filter, setFilter] = useState("all");
  const [selected, setSelected] = useState(new Set<string>());
  const [expanded, setExpanded] = useState(new Set<string>());
  const [busy, setBusy] = useState(false), locked = useRef(false);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const load = useCallback(() => rpc.call("proposalInbox", { offset }), [rpc, offset]);
  const { data, error, refresh } = useSnapshot(load);
  const items = data?.items ?? [];
  const visible = items.filter(item => filter === "all" || reviewGroup(item) === filter);
  const picked = items.filter(item => selected.has(reviewKey(item)) && !item.blockedReason);
  const taskCounts = new Map<string, number>();
  for (const item of items) { const id = reviewTask(item); if (id && !item.blockedReason) taskCounts.set(id, (taskCounts.get(id) ?? 0) + 1); }
  const eligible = visible.filter(item => !item.blockedReason && (!reviewTask(item) || taskCounts.get(reviewTask(item)!) === 1));
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
      const result = await rpc.call("acceptInbox", { items: snapshot.map(reviewSelection) });
      setSelected(new Set(result.failed.map(item => `${item.kind}:${item.id}`)));
      setNotice(`Принято: ${result.applied.length}.${result.failed.length ? ` Требуют внимания: ${result.failed.length}.` : ""}`);
      if (result.failed.length) setMutationError(result.failed.map(failure => `${reviewTitle(snapshot.find(item => reviewKey(item) === `${failure.kind}:${failure.id}`)!)}: ${failure.message}`).join("\n"));
    });
  }
  return <div className="h-full min-h-0 overflow-y-auto"><div className="mx-auto max-w-5xl space-y-5 p-5 md:p-8">
    <Button variant="ghost" size="sm" className="-ml-3" onClick={() => navigate.toPluginPanel("desk")}><Icon name="ChevronLeft" /> Все задачи</Button>
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h1 className="text-2xl font-medium">Предложения{data ? ` · ${data.total}` : ""}</h1><p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">Новые задачи, обновления и итоги сессий — всё на рассмотрении в одном месте. Проверь изменения и прими нужные.</p></div><Button variant="outline" onClick={() => navigate.toPluginPanel("desk", { subPath: "updates" })}>Проверить источники</Button></div>
    <div className="flex flex-wrap gap-2" aria-label="Виды предложений">{([{ id: "all", name: "Все" }, { id: "new", name: "Новые задачи" }, { id: "updates", name: "Обновления задач" }, { id: "dossier", name: "Досье и сессии" }]).map(group => <Button key={group.id} size="sm" variant={filter === group.id ? "default" : "outline"} aria-pressed={filter === group.id} disabled={busy} onClick={() => { setFilter(group.id); setSelected(new Set()); }}>{group.name} · {items.filter(item => group.id === "all" || reviewGroup(item) === group.id).length}</Button>)}</div>
    <div className="sticky top-0 z-10 flex flex-wrap items-center gap-3 rounded-xl border border-border bg-background p-3 shadow-sm">
      <label className="flex cursor-pointer items-center gap-2 text-sm"><input type="checkbox" aria-label={data?.nextOffset !== null && data?.nextOffset !== undefined || offset ? "Выбрать все на этой странице" : "Выбрать все"} checked={allSelected} disabled={busy || !eligible.length} onChange={selectAll} />{data?.nextOffset !== null && data?.nextOffset !== undefined || offset ? "Выбрать все на странице" : "Выбрать все"}</label>
      <Button size="sm" variant="ghost" disabled={!visible.length} onClick={() => setExpanded(previous => visible.every(item => previous.has(reviewKey(item))) ? new Set() : new Set(visible.map(reviewKey)))}>{visible.length > 0 && visible.every(item => expanded.has(reviewKey(item))) ? "Свернуть все" : "Раскрыть все"}</Button>
      <span className="mr-auto text-xs text-muted-foreground">Выбрано: {picked.length}{picked.some(item => reviewGroup(item) === "new") ? ` · новых задач: ${picked.filter(item => reviewGroup(item) === "new").length}` : ""}</span>
      <Button size="sm" disabled={busy || !picked.length} onClick={acceptSelected}><Icon name="Check" />{busy ? "Сохраняем…" : `Принять выбранные${picked.length ? ` · ${picked.length}` : ""}`}</Button>
    </div>
    {notice && <p role="status" className="rounded-lg bg-primary/5 p-3 text-sm">{notice}</p>}
    <ErrorNotice error={mutationError ?? error} retry={() => void refresh()} />
    {[...taskCounts.values()].some(count => count > 1) && <p className="text-sm text-muted-foreground">Для некоторых задач есть несколько предложений. Выбери нужное вручную — «Выбрать все» пропустит такие задачи.</p>}
    {!data && !error && <p role="status" className="py-12 text-center text-sm text-muted-foreground">Собираем предложения…</p>}
    {visible.map(item => {
      const key = reviewKey(item), title = reviewTitle(item), taskId = reviewTask(item);
      const draft = item.kind === "source" ? item.candidate : item.proposal;
      const changes = item.kind === "proposal" ? item.dossier.sessionUpdates[0]?.extraction.changes ?? draft.changes : draft.changes;
      const group = reviewGroup(item), open = expanded.has(key);
      const conflict = Boolean(taskId && picked.some(other => reviewKey(other) !== key && reviewTask(other) === taskId));
      return <section key={key} aria-label={`Предложение: ${title}`} className={cn("overflow-hidden rounded-xl border bg-card", selected.has(key) ? "border-primary/40" : "border-border")}>
        <div className="flex items-start gap-3 p-4"><input type="checkbox" className="mt-1 size-4 shrink-0" aria-label={`Выбрать: ${title}`} checked={selected.has(key)} disabled={busy || Boolean(item.blockedReason) || conflict} onChange={() => setSelected(previous => { const next = new Set(previous); next.has(key) ? next.delete(key) : next.add(key); return next; })} />
          <div className="min-w-0 flex-1"><div className="mb-2 flex flex-wrap items-center gap-2"><Pill attention={group === "new"}>{group === "new" ? "Новая задача" : group === "updates" ? "Изменения задачи" : item.kind === "proposal" && item.dossier.sessionUpdates.length ? "Итоги сессии" : "Изменения досье"}</Pill><span className="text-xs text-muted-foreground">{Object.keys(changes).map(field => fieldNames[field as keyof typeof fieldNames]).join(" · ")}</span></div>
            <button type="button" className="w-full text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-expanded={open} aria-label={`${open ? "Свернуть" : "Просмотреть"}: ${title}`} onClick={() => setExpanded(previous => { const next = new Set(previous); next.has(key) ? next.delete(key) : next.add(key); return next; })}><h2 className="break-words font-medium leading-snug">{title}</h2><p className="mt-2 line-clamp-2 text-sm leading-relaxed text-muted-foreground">{draft.rationale}</p></button>
            {!open && changes.nextStep?.value && <p className="mt-3 line-clamp-3 text-sm leading-relaxed"><span className="text-muted-foreground">Дальше: </span>{changes.nextStep.value}</p>}
            {!open && changes.status && <p className="mt-2 text-sm">Статус: {taskStatusNames[changes.status.value]}</p>}
            {item.blockedReason && <p className="mt-3 text-sm text-destructive">{item.blockedReason}</p>}{conflict && <p className="mt-3 text-xs text-muted-foreground">Уже выбрано другое предложение для этой задачи.</p>}
          </div><Button size="sm" variant="ghost" aria-label={`${open ? "Свернуть изменения" : "Показать изменения"}: ${title}`} onClick={() => setExpanded(previous => { const next = new Set(previous); next.has(key) ? next.delete(key) : next.add(key); return next; })}><Icon name={open ? "ChevronDown" : "ChevronRight"} /></Button>
        </div>
        {open && <div className="border-t border-border p-3 pt-0 md:p-4 md:pt-0">{item.kind === "source" ? <SyncCandidateCard candidate={item.candidate} currentTask={item.currentTask ?? undefined} action={action} busy={busy} /> : <><div className="flex justify-end py-2"><Button size="sm" variant="ghost" onClick={() => navigate.toPluginPanel("desk", { subPath: item.dossier.task.id })}>Открыть задачу</Button></div><ProposalCard proposal={item.proposal} dossier={item.dossier} action={action} busy={busy} /></>}</div>}
      </section>;
    })}
    {data && !visible.length && <div className="rounded-xl border border-dashed border-border p-10 text-center"><Icon name="CircleCheck" className="mx-auto mb-3 size-7 text-muted-foreground" /><h2 className="font-medium">{data.total ? "В этом разделе предложений нет" : "Всё рассмотрено"}</h2><p className="mt-2 text-sm text-muted-foreground">{data.total ? "Выбери другой вид предложений или следующую страницу." : "Новые предложения появятся после проверки источников или завершения сессий."}</p></div>}
    {data && (offset > 0 || data.nextOffset !== null) && <div className="flex flex-wrap items-center justify-between gap-3"><Button variant="outline" disabled={busy || !previousOffsets.length} onClick={() => { setOffset(previousOffsets.at(-1) ?? 0); setPreviousOffsets(previousOffsets.slice(0, -1)); setSelected(new Set()); }}>Назад</Button><span className="text-xs text-muted-foreground">На странице {items.length} из {data.total}. Остальные — на следующей.</span><Button variant="outline" disabled={busy || data.nextOffset === null} onClick={() => { if (data.nextOffset !== null) { setPreviousOffsets([...previousOffsets, offset]); setOffset(data.nextOffset); setSelected(new Set()); } }}>Дальше</Button></div>}
  </div></div>;
}

function Page({ subPath }: PluginNavPanelProps) {
  const path = subPath.replace(/^\/+|\/+$/g, "");
  if (path === "proposals") return <ProposalInboxPage />;
  if (path === "updates") return <SyncPage />;
  if (path === "knowledge") return <KnowledgePage />;
  const parts = path.split("/");
  if (parts[0] === "day" || parts[0] === "report") {
    const report = parts[0] === "report", period = parts[1] === "day" ? "day" : "week";
    const date = (report ? parts[2] : parts[1]) || localDay();
    if (!dayDateSchema.safeParse(date).success) return <div className="p-6"><ErrorNotice error="В ссылке указана неверная дата." /></div>;
    return <DayPage key={`${report}:${period}:${date}`} date={date} report={report} period={period} />;
  }
  const returnTo = path.match(/^[^/]+\/from\/((?:day|report\/(?:day|week))\/\d{4}-\d{2}-\d{2})$/)?.[1];
  return path ? <TaskPage key={parts[0]} taskId={parts[0]} returnTo={returnTo} /> : <Desk />;
}
function SidebarCount() {
  const rpc = useRpc<typeof rpcContract>();
  const load = useCallback(() => rpc.call("list", { history: false }), [rpc]);
  const { data } = useSnapshot(load);
  if (!data || !data.total && !data.pendingTotal) return null;
  const pendingLabel = `Предложения ждут решения: ${data.pendingTotal}`;
  return <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
    {data.total > 0 && <span className="font-mono text-xs tabular-nums text-muted-foreground" title={`Открытые задачи: ${data.total}`}>{data.total}</span>}
    {data.pendingTotal > 0 && <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-orange-500/20 px-1 text-[10px] font-semibold leading-none tabular-nums text-orange-700 dark:text-orange-300" title={pendingLabel} aria-label={pendingLabel}>{data.pendingTotal > 99 ? "99+" : data.pendingTotal}</span>}
  </span>;
}
export default definePluginApp((app) => {
  app.slots.navPanel({ id: "desk", title: "247C", icon: "Target", path: "desk", component: Page, experimental_sidebarAccessory: SidebarCount });
  app.slots.experimental_threadHeaderAction({ id: "session", title: "Сессия 247C", component: ThreadSessionAction });
});
