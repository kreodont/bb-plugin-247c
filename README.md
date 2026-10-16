# 247C for BB

Local tasks, durable dossiers, shared knowledge, work conversations and day planning. Each computer has its own independent SQLite database.

## Install on another computer

Requires BB ≥ 0.43.4 with Plugin SDK ≥ 0.5.9 and a login for your chosen model provider. Installation and startup are verified on macOS; Windows uses Ubuntu/WSL. Configure and verify source integrations and backups on each computer.

This repository is currently private. Authenticate Git with a GitHub account that has access before installing; with GitHub CLI, run `gh auth login` and `gh auth setup-git` once on the new computer.

```sh
bb plugin install git:https://github.com/kreodont/bb-plugin-247c.git@main
```

The package includes source code and a ready build. It contains no author tasks, history, accounts or personal settings. **247C** appears in the sidebar with an empty database. Configure Gmail, Slack, Jira and calendar access separately; tasks, dossiers and conversations work without those integrations. The interface and public documentation are in English. Existing task content and conversations retain their original language.

Saved source exports and check snapshots use lossless compression. Existing
history is converted in the background and database space is reclaimed when
checks and reviews are idle. Task records, evidence and recovery remain available;
no retention cutoff deletes old exports. See [storage compatibility](docs/releases.md).

Click **247C** in the sidebar to open **Proposals** when any proposals await a decision, or **Tasks** when none remain. The **Tasks** tab and **All tasks** links always open the task list. The proposal count remains a direct shortcut and also works with Enter or Space when focused; the panel options menu remains available to its right.

In BB's icon-rail layout, enable **Show plugin links above chats** in 247C settings to restore text shortcuts above the chat list. The shortcuts follow the visible plugin panels and their order in **Customize rail**. The 247C row also shows proposal and task counts, reported time, and review/source warnings. This preference defaults to off and is preserved in the installation's local settings patch.

Tasks with an open chat show a filled speech-bubble icon and a filled **Open chat** button in the list, cards and day plan. Priority colors stay visible. The marker means a chat is open; only a running agent uses the activity pulse.

- [Source updater health warnings](skills/updater-health.md)
- [Local OpenKnowledge export and search](skills/knowledge-search.md)
- [Local configuration and update patches](docs/local-configuration.md)
- [Source configuration](docs/sources.md)
- [Setup-agent guide and local read permissions](docs/setup-agent.md)
- [Windows installation with WSL2](docs/windows.md)
- [Backups, Google Drive and recovery](docs/recovery.md)
- [Third-party notices](THIRD_PARTY_NOTICES.md)

To update an installation tracking `main`, run `bb plugin update 247c`. The local settings patch is automatically reapplied when the updated plugin loads. Make a backup before changing versions. Each release tag identifies one immutable code version.

Use `bb plugin source 247c --json` to confirm the installed commit. A `path:`
installation loads that folder directly and does not track GitHub updates.
Keep development in a separate Git checkout and install published builds from
the managed Git source. See [release and recovery checks](docs/releases.md).

If an accepted next step has been completed or canceled, a review can propose clearing it based on a result or decision in the conversation, even while the overall task remains open. Assigning a new next step requires an explicit user instruction. All proposed changes require acceptance.

After an error, **Retry review** first revalidates saved responses from the same session against the current rules. A response can be recovered without new generation only when the transcript and accepted dossier are unchanged. Previously proposed or rejected responses are not reused. The result still awaits your acceptance. If no suitable response exists, or you explicitly selected a model, a new review starts.

**ZSH** in the chat header opens BB's terminal panel in that thread's workspace. It starts a login zsh on the thread's machine and reuses the same 247C terminal on subsequent clicks. Closing the terminal tab ends that terminal; the next click starts a new one. The machine needs zsh, and older BB clients without the terminal-panel API show an update message.

**247C: Switch task** in BB's command palette (default shortcut Cmd+Shift+K, rebindable in BB) opens a task switcher. Open chats are listed first, most recently updated on top, followed by other open tasks. Type to filter by title or customer; arrow keys and Enter open the chat, and a task without one gets a new chat.

Use **Sort by** above the task cards to choose **Recently updated** (default), **Oldest update**, or **Priority**. The choice is remembered in this browser and works with search, priority filters and completed tasks. Each card shows its last saved update time, including when it has a next step. Pending proposals and time-journal updates do not change the task's saved update timestamp.

Installation-specific project IDs, model preferences, collector paths and planner
references can be kept in a [local settings patch](docs/local-settings.md). The
plugin reapplies it when loading after an update; actual values stay outside Git.

## Day planning and time

Open **247C → Today** to see **Planned**, **Actual** and **Reported** time. Planned time is your intention; actual time sums completed agent runs linked to the task, including parallel agents. Reported time is an editable work-report value. Enter manual time as `10m`, `3h`, `1h 20m` or `1:20`; a blank field differs from an explicit zero. Save with the button, Enter, or navigation. The task title opens its dossier; **Back to day plan** returns to the selected date.

Hourly updates also reconcile the day plan. Work on an existing task outside the plan adds an entry with planned = 0; existing planned values are preserved. Measurement starts with the day tracking is first enabled, including work already completed that day, and catches up after restarts. **Refresh agent time** runs the same check immediately. No empty plan or new task is created merely to represent a chat.

Actual uses BB start/completion receipts, subtracts recorded provider approval/question waits, and splits runs at local midnight. Idle chat gaps and unfinished runs are excluded; unfinished work appears after completion. Parallel agents are added, so actual is agent runtime rather than elapsed human working time. Only explicitly linked task threads and their descendants count. Missing telemetry stays unknown; source-analysis chats and unrelated conversations are excluded. Provider workflow agents count when BB supplies per-agent start and duration receipts; cached work is excluded.

Automatic reported values are clearly labeled **estimate · review**, with a rationale. The hourly analyst proposes minutes from the volume, complexity and type of work, including the user's likely reading, understanding and checking of the results. These estimates are independent of agent runtime: there is no multiplier, ratio floor or ceiling. Measurements leave reported blank until there is enough work evidence for an estimate and never rescale existing estimates. Estimates are drafts for review, never measurements of the user's hours. **Confirm reported** or a manual edit locks the value; later updates preserve it, including zero and blank. **Request AI estimate** clears a manual override and makes the entry eligible for the next hourly review. Manual reported time has no ratio limit or excess warning. Previously saved estimates and their history remain readable; eligible estimates can be revised by the analyst under the new rules.

**Report → By day / By week** and task totals include all three time types. Reports flag automatic estimates so they can be reviewed before external use. Weeks start Monday; dates use the configured planning time zone. You can edit past dates and closed tasks. The checkbox marks only the daily step. **Continue on another day** preserves original time and creates a continuation with blank values. **Remove from day** excludes planned and reported time from day, week and task totals. Saved manual reported values and history remain available through **Show removed**; **Restore to day** includes those values again. Measured actual time remains in reports. Entry details include a history of measured updates, estimates and manual corrections.

Each reported Day entry has a short **Work summary** in English. Edit it directly in Day; it saves automatically and does not change minutes. Session reviews propose a concise description of completed work separately from the time-estimate rationale, and accepting the time part adds that description to the day. Later minute corrections preserve it. Meetings default to a neutral label based on their calendar title, without inventing discussion outcomes. Older entries without a saved description remain editable; planned steps are never presented as completed work. Continuing on another day starts with a blank description.

The assistant records manual time only from an explicit instruction, such as “Set this task's reported time for September 10 to 20 minutes” or “Add another 5 minutes.” Measurement and labeled estimates have separate automatic paths. The time journal does not change dossier revisions or make task proposals stale.

During **Check for updates**, a script independently reads the work Google Calendar selected by `sources.calendarId`. It imports meetings from the Monday of the selected week through seven days after the selected date. The day screen also has a separate **Check calendar** button. Import uses the connected configured calendar without running a model. All-day events, focus time, out-of-office events and declined invitations do not receive automatic hours.

A meeting's planned time defaults to its calendar duration. After it ends, reported time automatically equals planned time. Actual always equals reported, including manual corrections and zero attendance. Planned and reported fields can be edited independently; calendar updates preserve manual overrides. **Did not attend** sets reported time to zero. **Planned from calendar** and **Automatic reported time** restore the respective field's automatic calculation. If a meeting moves, manually reported time retains its original date, which can be edited separately. Cancellation removes automatic hours while preserving manual reports and history. Connection errors preserve existing meetings.

Enable the local `reportMeetingsWhenPlanned` setting to fill automatic meeting reported time from planned time immediately, including upcoming meetings. Duration changes keep automatic values aligned; manual reported corrections, including zero and blank, remain authoritative. The default waits until the meeting ends.

[Time journal rules and assistant tools](skills/day-planning.md).

## Gmail, Slack and Jira updates

Open **Updates** from the home screen, then click **Check for updates** to start immediately with the saved analysis settings. Progress appears on the same page; repeated clicks do not start a second check. Each source resumes from the exact time of its last complete run. As with scheduled checks, unchanged documents are reused and the model is skipped when there is no new source or day-plan work to analyze.

Use **Custom check…** to choose an analysis model in BB's native composer, add instructions or enable **Set a start date** for a different interval. On a fresh installation, complete one custom check to save the account and workspace for future one-click checks. A first run covers the last 24 hours unless a start date is selected.

Since 0.2.16, a script collects changes, full threads and Jira comments in parallel through configured connectors, using the saved login for the configured Claude profile on the BB server. Collection does not run a corporate model or consume its generation quota. The panel shows threads read and elapsed time. The selected model then receives the exported data and task snapshot, analyzes them and prepares proposals. Quotes are checked against the script's saved responses.

Since 0.2.17, export pages are limited to 24 KB including JSON so models receive complete pages. Proposals are saved in batches. Invalid task IDs and quotes are listed in the response, and completing the check requires a separate explicit submission. Missing proposals from a completed run can be recovered from saved analysis without new generation; they still await approval in the panel.

An orange badge beside **247C** in the sidebar counts pending session and source proposals. It appears first, followed by the open task count and today's reported time, so the notification stays visible in BB's narrow sidebar indicator. It updates automatically and disappears at zero. Counts above 9 display `9+`, with the exact number in the tooltip. BB hides extra sidebar indicators on compact screens; the proposal count remains available on the 247C home page.

**247C → Proposals** brings together new tasks, source updates and session outcomes. The count includes proposals that do not yet have a task. Expand all changes, inspect facts and quotes, select individual proposals or all eligible proposals, and accept them together. A new task is created only after acceptance. Bulk acceptance respects the part selection inside each expanded proposal, including after collapsing it. Stale proposals require individual attention; if a task has multiple alternatives, Select all skips it. One failed acceptance does not undo successful ones, and each result is retained.

After acceptance, **Accepted recently** keeps **Open task** and **Open chat** shortcuts for the affected tasks on the Proposals page. Open chat returns to the existing conversation or creates an empty one and opens it immediately. Completed and archived tasks keep their status when a new conversation opens. The list shows up to 50 distinct tasks approved in the last 24 hours, including partial approvals, and survives navigation, page reloads and BB restarts.

Proposals are also available in **Updates** and the task's **Proposals** tab, with Before/After fields, facts, verbatim quotes and links. **Create task from proposal** creates a new task. All fields and records are selected by default. Accepting an update saves the selected fields and records with a single receipt; dossier history supports undoing fields.

Source statuses are independent. Errors, incomplete pagination or unread linked threads preserve the previous interval. Even the first failed run retains its start when retried days later. The interval end is fixed at the run's start. A manual date later than the previous checkpoint does not close the unchecked gap. Repeated findings are deduplicated by message. A new check can replace a stale proposal after the dossier changes.

The **Check sources on the configured hourly schedule** setting runs checks every day, including weekends, while BB is running. The inclusive hour window and IANA time zone are local settings; daylight saving time follows that zone. It uses the account, model and reasoning level from the last successful check. The workspace follows **Thread project** when configured; otherwise it uses the saved workspace. If a check is still running, that scheduled start is skipped; the next run resumes from saved checkpoints. Proposals continue to require acceptance.

Collection starts only on request or through the enabled schedule. It does not modify email, messages or Jira. [Tools, intervals and limits](skills/source-sync.md).

Configured [local collectors](docs/local-source-collector.md) can also submit
Teams, Outlook and ClickUp findings into the same Proposals inbox. Their saved
receipts substantiate quotes, and users review changes before applying them.
The Day page can use an external calendar reader and run an existing planner
through **Create day plan**; see the [setup guide](docs/setup-agent.md).

## Getting started

A durable task retains context, accepted results, its next step and history across BB work sessions. Work happens in ordinary BB threads with your chosen model. Set **Thread project** in plugin settings to group all new work conversations, review discussions, recorders, verification threads and source checks in one BB project using its default local folder. The composer opens in that project. Existing threads keep their original project. See the [setup-agent guide](docs/setup-agent.md#project-for-247c-threads) for configuration and recovery.

Open **247C** in BB's sidebar. Create a task and add its initial context. The dossier can hold observations, decisions, constraints and an explicitly agreed next step. Set priority with one of four buttons, ordered green, yellow, orange, red: neither urgent nor important, important only, urgent only, or both. Each click saves both values together. The current choice has a checkmark and outline; an unknown priority stays unclassified until you choose a button.

Use **Back** and **Forward** in the navigation bar at the top of every 247C page. They follow BB's browser history, including transitions between tasks, proposals, the day plan, reports, knowledge and threads. New visits after going back follow the browser's usual history behavior. Before either button leaves the day plan, pending time and day-setting edits are saved; a validation error or conflicting edit keeps the page open for correction.

For a quick time entry, use **Open task** in a linked thread, choose a date in the task's time section (today by default), then click **Log time**. The day plan scrolls to that task and focuses its Reported field. If the task is missing from that day, this action adds it with planned = 0 and leaves reported blank. Existing time is preserved. **Return to thread** stays visible at the top of the task and day plan, saves pending time and day settings, and returns directly to the originating conversation. The return destination travels with the link, so different tabs and conversations keep their own destination. Opening a task from a day plan also retains that date when logging time.

The **Sources** bar directly below the task title opens the original Gmail message, Slack message or Jira issue in a new tab. Original task sources come first, followed by links from accepted records and changes. Repeated URLs appear once; use **+N more** to expand longer lists. Saved source links also appear on existing tasks, without a new check or approval. Pending or rejected suggestions do not add links to this bar.

Click **Source** beside **Open task** in any linked thread to open the task's primary source directly. The tooltip identifies the service and URL; compact headers show an external-link icon. The optional **Primary source** field on the new-task form, or `primarySourceUrl` in `c247_create`, saves the originating message, issue or document. Tasks created by accepting source proposals pin their first accepted original source. Existing tasks use the first original source, or their earliest accepted source when no original source is available. Use **Make primary** beside another accepted link in the task's **Sources** bar to change the shortcut. The choice persists across updates and backups, appears first in the bar, and refreshes in linked work and review threads. Choosing or opening a source does not change task revisions, approve proposals, record time or run a model. Tasks without a source show no shortcut.

Legacy migration records also expose their saved ClickUp source fields here, including workspace-specific URLs and explicitly listed related tickets. A ClickUp URL kept only in imported notes appears when its ticket ID matches the task title. This derives links from the existing migration context without changing task records, priorities or revisions.

Task cards show a blue **New** badge until first opened, or **Updated** after accepted changes since the last visit. Opening the visible dossier clears its badge. Pending proposals retain their separate approval count; they do not trigger **Updated**. Background checks and agent reads never mark a task as viewed. View state is stored in the local database and included in backups. Tracking starts with version 0.4.6: existing tasks begin without badges because earlier visits were not recorded.

Cards and filters use quadrant colors: red for urgent and important, orange for urgent and less important, yellow for important without urgency, and green for neither. The main list follows that order. Colors update with importance and urgency; unclassified tasks stay neutral.

Choose an available provider and model in the native composer when starting a conversation. A review discussion uses the original session's account and model, which you can change in the composer before sending.

In Threads, the work conversation is named **247C · task title**, making its dossier easy to identify. Manually edited thread titles are preserved. Click **Open task** in the thread header to return to its dossier at any time, including during work and after completion. This button also appears on linked review and verification threads. On narrow screens it becomes a target icon with the same tooltip. Opening the task does not finish the session or accept changes. The header also shows a clickable **Reported today** value for the linked task across all its sessions, using the day plan's configured time zone. Click the value to set the day's reported total in a small editor without leaving the thread. Opening or canceling the editor does not create an entry. Saving a missing entry adds it with planned = 0; existing planned values are preserved. The adjacent arrow opens today's Day Plan at that task, adding a missing row with planned = 0 and reported left blank. **Return to thread** leads back to the originating conversation. Concurrent edits are reported instead of overwritten. It refreshes after time edits, on reconnect and when returning to the window. Blank time is shown as an em dash, explicit zero as **0m**, and unconfirmed AI values carry an **estimate** label. A failed refresh shows **unavailable** instead of presenting stale time as current.

Click **Proposal** beside **Open task** to open the proposal from that exact session, with **Return to thread** available at the top. The shortcut appears when the session has a proposal, follows the remaining parts after a partial review or a refreshed draft, and still opens the decision after acceptance or rejection. It updates automatically when the review finishes and uses a checklist icon on narrow screens. Opening it does not run an agent or accept changes.

In the **Work** tab, start a conversation using BB's embedded composer: choose an account, model and workspace, then send your first message. No acceptance criteria are required. The assistant receives the dossier and responds normally. You can keep talking between responses and after pauses, without a conversation time limit.

A failed conversation review shows a notification anywhere in BB, a red **!** beside 247C and **Review failed** on the affected task and thread. **Failed reviews** in 247C navigation lists unresolved failures, including failures before a recorder thread was created. **Open failed review** opens that exact session in Work, where **Retry review** is available. Dismissing the popup keeps the persistent indicators. Repeated failures after a retry notify again; successful recovery clears the warning. Alerts survive reloads and disconnections. Closed tasks keep old failures in their Work history; explicit review discussions on closed tasks still notify.

A failed background read of BB's chat status leaves the conversation open and retries automatically. If an earlier error already blocked an unfinished conversation, use **Open task → Work → Resume chat**. This checks that the original chat is available and re-enables it with its existing context. It does not send a message or create another agent. Cancelled sessions and finished, frozen conversations cannot be resumed; finished conversations use **Retry review** or **Discuss review**.

When finished, click **Finish session** in the **Work** tab or on the right side of the 247C work thread header, beside **Open task**. On narrow screens the finish button becomes a checkmark. After completion, **Open task** remains available. Finishing stops the current response, closes the chat to new messages and saves the full text conversation, including answers to BB questions. A separate session prepares dossier and knowledge records.

While the recorder is running, **Open review** in the original work chat opens its current review chat directly. Before that chat is ready, the disabled button says **Starting review…**. Automatic repairs and retries update the destination; the link is checked again when clicked. Once review finishes, **Proposal** opens the prepared changes, or **Review failed** opens a failed attempt. Opening the review does not send a message or start another agent.

If BB reports `HTTP 502: Runtime shutting down` while stopping the original chat, 247C retries that stop at most twice, after brief delays. It confirms that the chat has settled before saving the transcript and starting one recorder. This recovery does not resend messages, change the selected review model or repeat model work. Other errors and persistent shutdown failures still produce the review-failure notification. An uncertain recorder launch is never automatically repeated.

The review model is selected automatically from those available in BB: Codex Sol after any Claude model (Sonnet, Opus or Fable), and personal Sonnet after Codex. Spark, Luna, Haiku, mini/nano and unknown models are excluded, including as fallbacks or prior manual choices. Selection uses the model active when the conversation finishes; changing an account, alias or context window does not count as changing the model. Sol and Sonnet remain preferred on retries, even when that uses the worker's model family. Terra is the first fallback, followed by Fable, Opus or Astra. Models outside this explicit list are never substituted automatically. Reasoning is set to low when supported. The selected model appears in the review tab and the selection reason in task history.

Automatic selection uses personal Claude and Codex. A corporate account may review only a corporate conversation. Provider-specific eligibility rules can exclude models listed in a catalog. Failure to load one catalog does not prevent choosing from another. If no model is available, the conversation stays open so you can retry finishing after access is restored. A catalog listing does not guarantee available account quota.

The **Proposals** tab shows changed fields, new records, quotes and knowledge. All parts are selected by default: **Accept changes** saves the whole proposal in one operation. Uncheck parts to accept or reject only the selected fields, individual records or knowledge notes. Unchecked parts remain pending in a separate proposal based on the resulting dossier revision. **Reject** leaves permanent records unchanged. If a review fails or the dossier changes, **Retry review** uses the saved conversation and current dossier. JSON, citation and proposal structure errors can trigger up to two automatic repair attempts with precise feedback and the same transcript snapshot. The repair count is configurable; zero disables repairs. Repairs do not extend the overall review deadline. Access or storage errors, cancellation and dossier changes do not trigger automatic repairs. After an error, another available option is preferred: Sol → Sonnet or Sonnet → Sol.

A stale dossier proposal can be recovered in its card: **Refresh proposal** handles a priority-only change without a model call; **Review current task** lets you reconcile selected parts with the latest task. Both prepare a new pending proposal for separate acceptance and preserve the original in history. See [partial review and conflict recovery](docs/partial-review.md).

**Waiting for response** is a light-blue status for unfinished tasks awaiting a reply. Use the button at the top of the task; **Resume task** returns it to Open. Waiting tasks have their own filter, retain urgency and importance, and remain available to chats, updates and Day Plan. Switching between Open and Waiting leaves the current chat running. Agents can propose the transition with evidence; only accepting a proposal applies it.

The recorder receives the 247C workflow, priorities, dossier and session list. It can propose **title, status, urgency, importance, summary, next step, questions, blockers, artifacts and knowledge**. Title and priority changes require a user decision; archiving and reopening also require an explicit decision in the conversation. For example, “reduce urgency and importance, but keep the task open” produces two separate **Yes → No** changes while keeping the task open. Mentioning priority only in the summary does not change its fields. Manual priority edits advance the dossier revision, so an old proposal cannot overwrite the new choice. Any accepted fields, including title and priority, can be reversed through a compensating proposal in history.

**Discuss review** is available beside a proposal and in a finished session's **Work** tab. It opens the composer for a new linked conversation. Send a clarification; the assistant receives the original transcript, previous review and current dossier. After the discussion ends, the new review considers both conversations, later corrections and the actual authors of quoted messages. An unaccepted earlier proposal is replaced only after a valid new one is ready; cancellation or failure preserves it. The proposal cannot be accepted while its discussion is open. A closed task can be discussed without reopening it. Accepting the revised results also archives finished source conversations in that chain. A review superseded by a later discussion cannot be retried; retry the latest review to preserve corrections.

Resolving a session review with at least one accepted part automatically archives its thread in Threads, even while the task stays open. The conversation remains accessible from task history; continue working in a new session from the dossier. This also applies to previously accepted sessions. Temporary archival failures are retried in the background. If you manually restore a successfully archived thread, subsequent updates to an open task do not hide it again.

When the whole task is complete, the review proposes **Task status: Open → Done** with supporting evidence. **Accept and complete task** saves records, knowledge and status together; the same proposal may clear a completed next step. Ending a conversation or completing one stage does not by itself complete the task. The review considers later corrections and outstanding required actions. If completion is supported by the assistant's reported recheck, the quote and author make that attribution visible for your review.

Task status stays unchanged until acceptance. Any failure rolls back the entire operation, including status. Repeated acceptance does not apply changes twice. Finish any other open work session first. After acceptance, find the task in history; **History → Propose undoing completion and changes** prepares restoration of its previous status and fields while preserving historical facts and knowledge.

Completing or archiving a task archives all its finished work and review chats, including earlier sessions. An open discussion of a closed task remains in Threads until it ends. Transcripts and 247C history links are preserved. This works for proposal acceptance and manual status changes. The plugin also handles tasks closed before an update and retries temporary archival failures. Reopening a task does not resume old sessions; start a new conversation.

The **Knowledge base** stores accepted conversation knowledge and imported Markdown documents. Search full text, titles, tags and paths. Use **Read in full** to expand large documents. Conversation records link to their dossier and source thread; documents link to the original file on the appropriate computer. Assistants search with `c247_knowledge` and paginate with `nextOffset`.

When explicitly requested, documents can be copied through the `importKnowledge` RPC. Full text is preserved with its source path, modification time and SHA-256. Reimporting the same path updates its copy without duplicates. Later source-file changes do not sync automatically. Import creates no tasks or sessions and does not approve conversation proposals. [Import format and verification](skills/knowledge-import.md).

## Navigation and local UX recording

**Pinned files** is available in every thread header and the 247C page header.
Pin an existing file by absolute path (or `~/...`) and give it an optional name.
In a thread, click a shortcut to open BB's side-panel preview; enable the installed **File
Editor** plugin to edit supported files there. Unpinning removes only the
shortcut. 247C never opens, reads, copies, indexes or attaches the target file.
Names, paths and the owning machine ID are stored only in the installation's
`pinned-files.local.json`, outside task data and exported settings. The list
survives updates but is excluded from 247C backups, source exports and UX
recording. Configure shortcuts separately on each computer. The 247C page manages the
list; opening requires a thread with a workspace on the file’s machine.

The persistent **Today · Tasks · Updates** navigation keeps daily work within reach. **More** contains Proposals, Failed reviews, Knowledge base and UX recording. Opening 247C from the sidebar still goes straight to Proposals while proposals await a decision, and to Tasks otherwise. Navigation waits for pending day edits and stays on the page if saving fails. Tasks default to a compact list; **Cards** restores the wider view. The display choice stays in browser-local storage. Both layouts offer **New chat** for open tasks without an active session. One click creates an empty native BB thread in the configured project and opens it immediately, using the saved work account and model (or BB project defaults). Write the first message in that thread; no starter message or task action is sent on your behalf. The task binding and instructions survive restarts, and the assistant reads the accepted dossier before task work. **Open chat** continues an existing active task conversation without starting a session. Day Plan has the same chat shortcuts beside each open task; they save pending time edits before navigating and keep the draft visible if saving fails. Chats created from the task’s **Work** tab also open their thread automatically after submission. Day Plan places entries first, with planning, calendar and measurement controls in a collapsed section below.

**More → UX recording** (also available in the plugin's settings) provides a local, optional usability recorder. It is off by default. **Start continuous recording** records until an explicit pause, across plugin updates and BB restarts. Existing timed studies keep their original deadline until you explicitly start continuous recording. The visible recording bar offers **Review** and **Something feels awkward** to mark a moment with an optional comment; paused and unavailable states remain visible. Pause requires confirmation on the recording page. Control and recovery history shows when recording was started, paused, cleared or interrupted by storage errors. **Delete recording** stops recording and clears raw events and daily counts.

The recorder stores page types, predefined action identifiers, click/scroll coordinates, viewport dimensions, task layout, UI build, sparse pointer positions (at most once per second), focus changes and selected action outcomes/durations. It records only 247C surfaces and its own controls in linked threads. It does not capture chat text, task titles, raw task/thread IDs, field values, keystrokes, screenshots, DOM snapshots or external URLs. Only a deliberately submitted feedback comment contains free text. Browsers declaring WebDriver automation are excluded. No model is invoked and no analytics service is contacted.

State and bounded JSONL chunks live beside the plugin database in `ux-recording/`, separately from task records and source exports. Files are private to the local account (directory 0700, files 0600). Each chunk is at most 512 KB; raw logs rotate oldest first at 16 MB instead of stopping. Events expire within seven days, with the oldest partial hour removed early. Anonymous daily counts (actions, outcomes and errors, without coordinates, client IDs or feedback text) survive rotation for up to 90 days. Cleanup runs at startup and at least once per minute while running; a closed BB cannot record or clean up. The UI reports the last successful save. Temporary storage failures retry automatically without resetting opt-in. A bounded browser-session buffer retries recent events after frontend reload, with the same batch ID. New batches carry the actual plugin version and compatible older clients remain accepted after updates. Repeated focus changes are coalesced, and clicks and outcomes are shown separately from pointer and focus samples. Recording never blocks task operations. Long outages or a browser crash can still lose buffered samples; this is diagnostic sampling, not a complete session replay.

The report summarizes common actions, page transitions, operation outcomes, rapid repeat clicks and marked moments. It keeps browser sessions separate and preserves the UI build to compare later changes. Repeated clicks and pauses need interpretation; neither cursor position nor time on a page proves user attention or frustration. Raw coordinates are retained for targeted inspection, not displayed as a heatmap. Reports are read locally on demand; there is no scheduled agent analysis.

## Stored data

- Tasks, statuses and separate importance and urgency classifications.
- Immutable facts with sources; accepted summary, next step, questions, blockers and artifacts.
- Evidence-backed proposals tied to an exact base revision. Stale changes cannot be applied; repeated acceptance does not duplicate effects.
- Application receipts and undo through new proposals. Original drafts, exact selected subsets and decisions remain in history. See [partial review behavior](docs/partial-review.md).
- Frozen finished transcripts, proposed records with exact quotes, and accepted knowledge with provenance.
- For legacy sessions with acceptance criteria: criteria, observed files with SHA-256 and independent review findings.

BB manages the plugin's own SQLite database. The original dossier kernel was ported from the 247C project; provenance is recorded in `core/UPSTREAM.json`. Installation does not automatically import BB projects, an older 247C database or chats, and does not start agents.

## Boundaries and compatibility

Reviews read the entire text conversation, not just the final response. BB pagination is followed to the beginning without silent truncation. A review supports up to 512 KiB of text and 4,000 messages. Attachment contents and command execution are not independently verified; proposals disclose attachment presence. A conversation citation establishes the source of a claim, not the truth of every assistant statement.

In work conversations, a new next step requires an explicit user instruction. Source checks may propose a translated request from email, Slack or Jira, retaining its external provenance and original quote for human acceptance. Task completion may also clear a fulfilled step using the same completion evidence. Summaries may paraphrase cited facts; word overlap is not used as a semantic check. The user reviews meaning and caveats before acceptance. Each new record requires real quotes, and proposals can be saved only against the current dossier revision. Accepted facts are immutable. Undo creates a compensating proposal and preserves historical conversation records and knowledge.

A new conversation needs only the selected available provider: Codex, Claude Code or corporate Claude. The configurable 1–60 minute limit, default 20, applies to reviews rather than conversations. Each model run uses the chosen provider's quota. Legacy sessions created with acceptance criteria continue their independent verification workflow using another model family; their data and proposals remain compatible.

Open conversations survive plugin reloads. If a reload interrupts a review, **Retry review** processes the saved transcript. Canceling a session stops it without preparing updates; it does not undo actions performed in the work chat.

Plugin tools and instructions define a workflow, not isolation from an agent with full computer access. Approval governs 247C records. The plugin does not automatically read unrelated conversations or import projects or old databases on installation.

## Workspace selection compatibility

Since 0.2.4, the plugin accepts BB's provider environment format (`type: "provider"`) for personal folders, projects and worktrees. With **Thread project** unset, the chosen environment is passed unchanged to BB. When configured, all new threads use that project's default local folder, including launches from older saved requests. Account and model availability are checked on the target machine. Legacy `host`, `reuse` and `project-default` options are also supported.

## CLI and development

```sh
bb 247c list --json
bb 247c show <task-id>
bb 247c knowledge "invoice booked"
bb 247c new "Prepare a plan"
```

Source layout: `app.tsx` is the panel, `server.ts` exposes BB surfaces, `repository.ts` handles storage, `runtime.ts` manages sessions, `recorder.ts` selects review models, `conversation.ts` reads transcripts and validates sources, and `core/` contains the dossier kernel.

```sh
npm ci --include=dev
npm run typecheck
npm test
bb plugin build
bb plugin install . --yes
```

For an installed plugin, use `bb plugin dev`, or build and run `bb plugin reload 247c`. Reloads preserve open conversations; interrupted reviews require a retry. Inspect status with `bb plugin list` and logs with `bb plugin logs 247c`.

Tests cover multi-turn conversations, finishing with the button, pagination, provenance, atomic saves, cancellation, retry and reload. They use the official `@get-bb/plugin-sdk/testing`, real SQLite and the frontend harness to verify revisions, evidence, apply/undo behavior, session boundaries, model changes, repairs, cancellation during file reads and core UI workflows. Requires BB ≥ 0.42 and the pinned Plugin SDK 0.4.47.

Build release artifacts with the stable BB 0.42.1 CLI so their SDK metadata
matches the minimum supported runtime. A development BB can have a newer SDK
even when its BB version number is the same. On macOS or Linux, bypass a
development runtime's `BB_CLI` override when building a release:

```sh
env -u BB_CLI -u BB_CLI_DIR npx --package=bb-app@0.42.1 bb plugin build
```

Check that both `dist/server.meta.json` and `dist/app.meta.json` report
`sdkVersion: "0.4.47"`, then verify installation in a separate stable BB instance
before tagging the release. Keep runtime data and verification logs outside Git.

Finishing a conversation can include an optional, evidence-backed reported-time estimate in its normal proposal. Each time part is reviewed independently and is applied only on acceptance. See [Session reported time](docs/session-reported-time.md).

## Built-in file editor

247C includes the file editor on every installation. Open a supported text file
from a chat, workspace or pinned shortcut to edit it in BB. Auto-save is on by
default; Save and Command/Ctrl+S are also available. Conflicting disk changes
require Reload or an explicit Overwrite. **Show in folder** opens Finder, Windows
Explorer (including WSL) or the Linux file manager on the file’s machine; that
machine needs an active desktop session. Linux falls back to opening the parent
folder when file selection is unavailable.

Update 247C normally on each computer. If the separate `file-editor-save` plugin
is installed, save open edits and disable it after updating. A client with an
explicit file-opener preference can select **247C File Editor**. Files and pinned
shortcuts remain on their original machines; installation does not sync them.

Developers: run `npm ci --include=dev` and `npm run build`. The build packages the
lazy Monaco editor and its worker into `dist/monaco`; installations use those
shipped assets and do not need a separate editor or a build toolchain.
