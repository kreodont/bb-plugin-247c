# 247C for BB

Local tasks, durable dossiers, shared knowledge, work conversations and day planning. Each computer has its own independent SQLite database.

## Install on another computer

Requires BB ≥ 0.42 with Plugin SDK ≥ 0.4.47 and a login for your chosen model provider. Compatible with the stable BB 0.42.1 npm release. Installation and startup are verified on macOS and confirmed by user testing on Windows with Ubuntu/WSL. Configure and verify source integrations and backups on each computer.

This repository is currently private. Authenticate Git with a GitHub account that has access before installing; with GitHub CLI, run `gh auth login` and `gh auth setup-git` once on the new computer.

```sh
bb plugin install git:https://github.com/kreodont/bb-plugin-247c.git@v0.5.1
```

The package includes source code and a ready build. It contains no author tasks, history, accounts or personal settings. **247C** appears in the sidebar with an empty database. Configure Gmail, Slack, Jira and calendar access separately; tasks, dossiers and conversations work without those integrations. The interface and public documentation are in English. Existing task content and conversations retain their original language.

- [Source configuration](docs/sources.md)
- [Setup-agent guide and local read permissions](docs/setup-agent.md)
- [Windows installation with WSL2](docs/windows.md)
- [Backups, Google Drive and recovery](docs/recovery.md)
- [Third-party notices](THIRD_PARTY_NOTICES.md)

To update, install a newer release through BB's supported update mechanism. Make a backup before changing versions. Each release tag identifies one immutable code version.

If an accepted next step has been completed or canceled, a review can propose clearing it based on a result or decision in the conversation, even while the overall task remains open. Assigning a new next step requires an explicit user instruction. All proposed changes require acceptance.

After an error, **Retry review** first revalidates saved responses from the same session against the current rules. A response can be recovered without new generation only when the transcript and accepted dossier are unchanged. Previously proposed or rejected responses are not reused. The result still awaits your acceptance. If no suitable response exists, or you explicitly selected a model, a new review starts.

Use **Sort by** above the task cards to choose **Recently updated** (default), **Oldest update**, or **Priority**. The choice is remembered in this browser and works with search, priority filters and completed tasks. Each card shows its last saved update time, including when it has a next step. Pending proposals and time-journal updates do not change the task's saved update timestamp.

## Day planning and time

Open **247C → Day** to see **Planned**, **Actual** and **Reported** time. Planned time is your intention; actual time sums completed agent runs linked to the task, including parallel agents. Reported time is an editable work-report value. Enter manual time as `10m`, `3h`, `1h 20m` or `1:20`; a blank field differs from an explicit zero. Save with the button, Enter, or navigation. The task title opens its dossier; **Back to day plan** returns to the selected date.

Hourly updates also reconcile the day plan. Work on an existing task outside the plan adds an entry with planned = 0; existing planned values are preserved. Measurement starts with the day tracking is first enabled, including work already completed that day, and catches up after restarts. **Refresh agent time** runs the same check immediately. No empty plan or new task is created merely to represent a chat.

Actual uses BB start/completion receipts, subtracts recorded provider approval/question waits, and splits runs at local midnight. Idle chat gaps and unfinished runs are excluded; unfinished work appears after completion. Parallel agents are added, so actual is agent runtime rather than elapsed human working time. Only explicitly linked task threads and their descendants count. Missing telemetry stays unknown; source-analysis chats and unrelated conversations are excluded. Provider workflow agents count when BB supplies per-agent start and duration receipts; cached work is excluded.

Automatic reported values are clearly labeled **estimate · review**, with a rationale. A provisional allowance starts at actual × 1.25; the hourly analyst can adjust it for the work type. Estimates stay above actual and at most 3 × actual, including rounding. They are estimates for review, never measurements of the user's hours. **Confirm reported** or a manual edit locks the value; later updates preserve it, including zero and blank. **Use automatic estimate** restores estimation. New manual reported corrections cannot exceed 3 × known actual; earlier manual values are preserved and flagged if they exceed the limit after measurement arrives.

**Report → By day / By week** and task totals include all three time types. Reports flag automatic estimates so they can be reviewed before external use. Weeks start Monday; dates use Europe/Athens. You can edit past dates and closed tasks. The checkbox marks only the daily step. **Continue on another day** preserves original time and creates a continuation with blank values. **Remove from plan** preserves actual and reported time. Entry details include a history of measured updates, estimates and manual corrections.

The assistant records manual time only from an explicit instruction, such as “Set this task's reported time for September 10 to 20 minutes” or “Add another 5 minutes.” Measurement and labeled estimates have separate automatic paths. The time journal does not change dossier revisions or make task proposals stale.

During **Check for updates**, a script independently reads the work Google Calendar selected by `sources.calendarId`. It imports meetings from the Monday of the selected week through seven days after the selected date. The day screen also has a separate **Check calendar** button. Import uses the connected configured calendar without running a model. All-day events, focus time, out-of-office events and declined invitations do not receive automatic hours.

A meeting's planned time defaults to its calendar duration. After it ends, reported time automatically equals planned time. Actual always equals reported, including manual corrections and zero attendance. Planned and reported fields can be edited independently; calendar updates preserve manual overrides. **Did not attend** sets reported time to zero. **Planned from calendar** and **Automatic reported time** restore the respective field's automatic calculation. If a meeting moves, manually reported time retains its original date, which can be edited separately. Cancellation removes automatic hours while preserving manual reports and history. Connection errors preserve existing meetings.

[Time journal rules and assistant tools](skills/day-planning.md).

## Gmail, Slack and Jira updates

Click **Check for updates** on the home screen. Each source resumes from the exact time of its last complete run; a first run covers the last 24 hours. For a different interval, enable **Set a start date** and choose a date and time. Select any available analysis model in BB's native composer; the default is Codex Sol.

Since 0.2.16, a script collects changes, full threads and Jira comments in parallel through configured connectors, using the saved login for the configured Claude profile on the BB server. Collection does not run a corporate model or consume its generation quota. The panel shows threads read and elapsed time. The selected model then receives the exported data and task snapshot, analyzes them and prepares proposals. Quotes are checked against the script's saved responses.

Since 0.2.17, export pages are limited to 24 KB including JSON so models receive complete pages. Proposals are saved in batches. Invalid task IDs and quotes are listed in the response, and completing the check requires a separate explicit submission. Missing proposals from a completed run can be recovered from saved analysis without new generation; they still await approval in the panel.

An orange badge beside **247C** in the sidebar counts pending session and source proposals. It updates automatically and disappears at zero. Counts above 99 display `99+`, with the exact number in the tooltip. BB hides extra sidebar indicators on compact screens; the proposal count remains available on the 247C home page.

**247C → Proposals** brings together new tasks, source updates and session outcomes. The count includes proposals that do not yet have a task. Expand all changes, inspect facts and quotes, select individual proposals or all eligible proposals, and accept them together. A new task is created only after acceptance. Bulk acceptance respects the part selection inside each expanded proposal, including after collapsing it. Stale proposals require individual attention; if a task has multiple alternatives, Select all skips it. One failed acceptance does not undo successful ones, and each result is retained.

Proposals are also available in **Updates** and the task's **Proposals** tab, with Before/After fields, facts, verbatim quotes and links. **Create task from proposal** creates a new task. All fields and records are selected by default. Accepting an update saves the selected fields and records with a single receipt; dossier history supports undoing fields.

Source statuses are independent. Errors, incomplete pagination or unread linked threads preserve the previous interval. Even the first failed run retains its start when retried days later. The interval end is fixed at the run's start. A manual date later than the previous checkpoint does not close the unchecked gap. Repeated findings are deduplicated by message. A new check can replace a stale proposal after the dossier changes.

The **Check updates every hour, daily 08:00–20:00 (Athens)** setting runs checks at 08:00, 09:00, …, 20:00 every day, including weekends, while BB is running. Europe/Athens handles daylight saving time. It uses the account, model and reasoning level from the last successful check. The workspace follows **Thread project** when configured; otherwise it uses the saved workspace. If a check is still running, that scheduled start is skipped; the next run resumes from saved checkpoints. Proposals continue to require acceptance.

Collection starts only on request or through the enabled schedule. It does not modify email, messages or Jira. [Tools, intervals and limits](skills/source-sync.md).

## Getting started

A durable task retains context, accepted results, its next step and history across BB work sessions. Work happens in ordinary BB threads with your chosen model. Set **Thread project** in plugin settings to group all new work conversations, review discussions, recorders, verification threads and source checks in one BB project using its default local folder. The composer opens in that project. Existing threads keep their original project. See the [setup-agent guide](docs/setup-agent.md#project-for-247c-threads) for configuration and recovery.

Open **247C** in BB's sidebar. Create a task and add its initial context. The dossier can hold observations, decisions, constraints and an explicitly agreed next step. Importance and urgency are separate choices; an unknown priority remains unclassified.

Use **Back** and **Forward** in the navigation bar at the top of every 247C page. They follow BB's browser history, including transitions between tasks, proposals, the day plan, reports, knowledge and threads. New visits after going back follow the browser's usual history behavior. Before either button leaves the day plan, pending time and day-setting edits are saved; a validation error or conflicting edit keeps the page open for correction.

The **Sources** bar directly below the task title opens the original Gmail message, Slack message or Jira issue in a new tab. Original task sources come first, followed by links from accepted records and changes. Repeated URLs appear once; use **+N more** to expand longer lists. Saved source links also appear on existing tasks, without a new check or approval. Pending or rejected suggestions do not add links to this bar.

Task cards show a blue **New** badge until first opened, or **Updated** after accepted changes since the last visit. Opening the visible dossier clears its badge. Pending proposals retain their separate approval count; they do not trigger **Updated**. Background checks and agent reads never mark a task as viewed. View state is stored in the local database and included in backups. Tracking starts with version 0.4.6: existing tasks begin without badges because earlier visits were not recorded.

Cards and filters use quadrant colors: red for urgent and important, orange for urgent and less important, yellow for important without urgency, and green for neither. The main list follows that order. Colors update with importance and urgency; unclassified tasks stay neutral.

Choose an available provider and model in the native composer when starting a conversation. A review discussion uses the original session's account and model, which you can change in the composer before sending.

In Threads, the work conversation is named **247C · task title**, making its dossier easy to identify. Manually edited thread titles are preserved. Click **Open task** in the thread header to return to its dossier at any time, including during work and after completion. This button also appears on linked review and verification threads. On narrow screens it becomes a target icon with the same tooltip. Opening the task does not finish the session or accept changes.

In the **Work** tab, start a conversation using BB's embedded composer: choose an account, model and workspace, then send your first message. No acceptance criteria are required. The assistant receives the dossier and responds normally. You can keep talking between responses and after pauses, without a conversation time limit.

When finished, click **Finish session** in the **Work** tab or on the right side of the 247C work thread header, beside **Open task**. On narrow screens the finish button becomes a checkmark. After completion, **Open task** remains available. Finishing stops the current response, closes the chat to new messages and saves the full text conversation, including answers to BB questions. A separate session prepares dossier and knowledge records.

The review model is selected automatically from those available in BB: Codex Sol after any Claude model (Sonnet, Opus or Fable), and personal Sonnet after Codex. Spark, Luna, Haiku, mini/nano and unknown models are excluded, including as fallbacks or prior manual choices. Selection uses the model active when the conversation finishes; changing an account, alias or context window does not count as changing the model. Sol and Sonnet remain preferred on retries, even when that uses the worker's model family. Terra is the first fallback, followed by Fable, Opus or Astra. Models outside this explicit list are never substituted automatically. Reasoning is set to low when supported. The selected model appears in the review tab and the selection reason in task history.

Automatic selection uses personal Claude and Codex. A corporate account may review only a corporate conversation. Provider-specific eligibility rules can exclude models listed in a catalog. Failure to load one catalog does not prevent choosing from another. If no model is available, the conversation stays open so you can retry finishing after access is restored. A catalog listing does not guarantee available account quota.

The **Proposals** tab shows changed fields, new records, quotes and knowledge. All parts are selected by default: **Accept changes** saves the whole proposal in one operation. Uncheck parts to accept or reject only the selected fields, individual records or knowledge notes. Unchecked parts remain pending in a separate proposal based on the resulting dossier revision. **Reject** leaves permanent records unchanged. If a review fails or the dossier changes, **Retry review** uses the saved conversation and current dossier. JSON, citation and proposal structure errors can trigger up to two automatic repair attempts with precise feedback and the same transcript snapshot. The repair count is configurable; zero disables repairs. Repairs do not extend the overall review deadline. Access or storage errors, cancellation and dossier changes do not trigger automatic repairs. After an error, another available option is preferred: Sol → Sonnet or Sonnet → Sol.

The recorder receives the 247C workflow, priorities, dossier and session list. It can propose **title, status, urgency, importance, summary, next step, questions, blockers, artifacts and knowledge**. Title and priority changes require a user decision; archiving and reopening also require an explicit decision in the conversation. For example, “reduce urgency and importance, but keep the task open” produces two separate **Yes → No** changes while keeping the task open. Mentioning priority only in the summary does not change its fields. Manual priority edits advance the dossier revision, so an old proposal cannot overwrite the new choice. Any accepted fields, including title and priority, can be reversed through a compensating proposal in history.

**Discuss review** is available beside a proposal and in a finished session's **Work** tab. It opens the composer for a new linked conversation. Send a clarification; the assistant receives the original transcript, previous review and current dossier. After the discussion ends, the new review considers both conversations, later corrections and the actual authors of quoted messages. An unaccepted earlier proposal is replaced only after a valid new one is ready; cancellation or failure preserves it. The proposal cannot be accepted while its discussion is open. A closed task can be discussed without reopening it. Accepting the revised results also archives finished source conversations in that chain. A review superseded by a later discussion cannot be retried; retry the latest review to preserve corrections.

Resolving a session review with at least one accepted part automatically archives its thread in Threads, even while the task stays open. The conversation remains accessible from task history; continue working in a new session from the dossier. This also applies to previously accepted sessions. Temporary archival failures are retried in the background. If you manually restore a successfully archived thread, subsequent updates to an open task do not hide it again.

When the whole task is complete, the review proposes **Task status: Open → Done** with supporting evidence. **Accept and complete task** saves records, knowledge and status together; the same proposal may clear a completed next step. Ending a conversation or completing one stage does not by itself complete the task. The review considers later corrections and outstanding required actions. If completion is supported by the assistant's reported recheck, the quote and author make that attribution visible for your review.

Task status stays unchanged until acceptance. Any failure rolls back the entire operation, including status. Repeated acceptance does not apply changes twice. Finish any other open work session first. After acceptance, find the task in history; **History → Propose undoing completion and changes** prepares restoration of its previous status and fields while preserving historical facts and knowledge.

Completing or archiving a task archives all its finished work and review chats, including earlier sessions. An open discussion of a closed task remains in Threads until it ends. Transcripts and 247C history links are preserved. This works for proposal acceptance and manual status changes. The plugin also handles tasks closed before an update and retries temporary archival failures. Reopening a task does not resume old sessions; start a new conversation.

The **Knowledge base** stores accepted conversation knowledge and imported Markdown documents. Search full text, titles, tags and paths. Use **Read in full** to expand large documents. Conversation records link to their dossier and source thread; documents link to the original file on the appropriate computer. Assistants search with `c247_knowledge` and paginate with `nextOffset`.

When explicitly requested, documents can be copied through the `importKnowledge` RPC. Full text is preserved with its source path, modification time and SHA-256. Reimporting the same path updates its copy without duplicates. Later source-file changes do not sync automatically. Import creates no tasks or sessions and does not approve conversation proposals. [Import format and verification](skills/knowledge-import.md).

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
