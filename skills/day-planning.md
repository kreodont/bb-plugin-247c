# 247C day planning and time journal

## Quick time entry from a conversation

Use **Open task → Log time → Return to thread**. The selected date defaults to today, or the date of the day plan that opened the task. **Log time** opens the task's day entry, highlights it and selects the Reported field. It creates a missing day entry with planned = 0 and reported unspecified, preserving an existing entry and its times. **Return to thread** saves pending time and day settings before opening the exact originating conversation; failed saves keep the day open with the draft intact. The origin and selected task are carried in the panel link, not in shared global navigation state. The UI never records manual minutes merely from opening these links. For a direct shortcut, click **Reported today** in the thread header to open today's task row and focus Reported, adding a missing row with planned = 0 and reported unspecified. The current date is resolved when clicked, and the link keeps the originating thread. The thread header's **Reported today** button reads the linked task's saved reported time for today in the configured planning time zone, including all its sessions. It preserves blank versus zero and labels estimates. Reads do not create time entries or change task state.

Planned, actual and reported time are stored in 247C SQLite separately from the accepted task dossier. Time edits do not accept proposals, complete tasks or change priority.

## Day task order

Use **Sort tasks** above the day entries to sort tasks by Planned, Reported or
Actual duration, shortest or longest first. Blank values stay last; zero is a
recorded duration. Meetings keep their calendar order. The selection is saved
locally in the browser and applies when opening other dates. Sorting changes only
the view, preserving time values, pending edits and the saved manual order.
Select **Manual order** to restore that order and use **Move up / Move down** in
an entry's Details.

## Tools

- `c247_day({date?})` reads a day with full entry IDs and revisions. The default is today in the configured planning time zone.
- `c247_plan_add({requestId,date,taskId,step?,plannedMinutes?,reportedMinutes?})` adds an existing task to a date. Each task can have one entry per day. Closed tasks are also supported.
- `c247_time_edit({requestId,id,revision,plannedMinutes?,reportedMinutes?,operation?,...})` edits only supplied fields. `operation=set` replaces the total; `operation=add` adds minutes. `null` clears a field; `0` is an explicit zero. Planned and reported time are independent.
- `c247_plan_move({requestId,id,revision,date})` preserves time on the original date and creates a continuation with blank values. It cannot reschedule meetings.
- `c247_time_report({date?,period:day|week,taskId?})` reads an internal report. Weeks start on Monday.

Edit manual time only on explicit user instruction, in any language. Never infer it from chat duration, task completion, email, calendar descriptions or guesses. Distinguish “set the total to 3 hours” from “add 20 minutes.” If the task or date is unclear and context does not resolve it, clarify before writing.

Read the day before editing. Reuse one `requestId` when redelivering the same request to prevent duplicate additions. Changed requests need a new UUID. On revision conflict, reread the entry and do not automatically overwrite another edit. A worker can access only its task's entries; recorders and source analysts cannot edit manual time.

## Manual planner launch

When `dayPlannerProjectId` and `dayPlannerAutomationId` are configured in local
247C settings, **Day → Create day plan** starts that existing BB automation.
The button is available for today in Europe/Athens, saves unsaved day edits first,
and shows progress or failures. `dayPlannerState` is a read-only RPC;
`dayPlannerStart({date, requestId})` is an explicit user action and forwards a
stable idempotency key through the Automations plugin's public RPC. The backend
selects the automation from settings; callers cannot supply another target.
The automation retains its own planning policy and repeat-run behavior.

## Meetings

The calendar script uses the configured Claude profile, verifies the account in `sources` and reads its configured Google Calendar. `calendarMeetings` enables import during source checks; the day screen also supports a separate import. Times use the configured planning time zone. The window starts on the selected week's Monday and ends seven days after the selected date, inclusive.

Import accepts individual occurrences of ordinary events with start and end times. All-day and special event types are excluded. If a previous event is missing from the list, its ID is read separately so a move is not mistaken for cancellation. A failed page or recheck prevents partial application. Reimport updates the same entries. Stopping the related source check or reloading the plugin cancels an unfinished import.

Planned and reported fields have their own automatic or manual mode. Actual always equals reported for a meeting, including a manual zero or corrected date. Automatic planned time equals calendar duration; reported time equals the current planned time after an active meeting ends. This is a reporting convention, not proof of attendance. A background check runs every 30 seconds while BB is running and when the plugin loads.

Enable the local `reportMeetingsWhenPlanned` setting to fill automatic meeting reported time from planned time immediately, including upcoming meetings. Duration changes keep automatic values aligned; manual reported corrections, including zero and blank, remain authoritative. The default waits until the meeting ends.

Manual reported time, including zero and blank values, survives updates. `restoreAuto=planned|reported|both` explicitly restores automatic behavior; send it separately from manual time and `reportedDate`. A moved meeting retains the previous manually reported date until explicitly edited. Cancellation, declining or conversion to an excluded event removes automatic hours while preserving manual reports. Do not create a separate task for a calendar event.

## Automatic agent time and reported estimates

Hourly source updates reconcile measured task work before source analysis, even when a previous source run is active. Tracking also catches up when BB restarts with hourly updates enabled. The panel's **Refresh agent time** uses the same process. Tracking begins with the current local day on its first run, including already completed work; it does not infer older untracked time.

`actualMinutes` is read-only. BB turn start/completion timestamps, recorded provider blocking interactions and per-agent workflow duration receipts supply the measurements. Completed runs are summed across linked worker/reviewer threads, embedded subagents and BB child threads, including hidden or archived ones. Known waits for provider approvals and questions are subtracted; idle gaps and unfinished runs are excluded. A running turn appears once completed. Missing start/end or subagent duration telemetry is not guessed. Parallel agents sum rather than being merged into wall-clock time. Fork-inherited receipts are excluded by their source thread identity. Source check chats and unrelated conversations never acquire a task association from title similarity.

An existing task gets at most one entry per date, with planned = 0 when the engine adds it. Existing planned time, day notes, state and removal choices are preserved. Measurements use durable event IDs/cursors and are recomputed as totals, not blindly added on each check. Cross-midnight runs split by the configured planning time zone, including DST. Failed reads retain the previous journal and show a measurement error.

Automatic reported values use `reportedMode=estimate`. They are draft estimates for the user's work report, not measured human effort or submitted timesheets. Measurements do not supply a default estimate or rescale reported time. The active source analyst has two additional tools:

- `c247_day_review({offset?})` reconciles work on page zero and lists eligible entries with dated accepted records and session results. Follow `nextOffset` until null. Context is bounded and may be incomplete; use `c247_read` for fuller task context. Session results may still await human approval.
- `c247_day_estimate({requestId,id,revision,reportedMinutes,reason})` sets the total estimated minutes for this task on this date. Estimate by the volume, complexity and type of work supported by evidence, allowing for human reading, understanding, checking and testing. Explain the concrete work and assumptions. Never multiply agent runtime, treat chat age as human time, or infer completion from objectives or planned steps. Do not charge the whole multi-day task to every day or duplicate parallel agents' results. If evidence is insufficient for a useful estimate, leave reported blank or preserve its previous estimate. The server enforces current revisions and rejects manual or removed entries. Skip unchanged estimates. Review before finalizing source analysis.

Estimates have no ratio floor or ceiling relative to actual. The UI labels estimates, displays their rationale and flags them in day/week reports. **Confirm reported** or an explicit manual correction locks the value, including zero or blank, against automation. **Request AI estimate** clears the override and queues the measured task entry for the next hourly analysis; it does not invent a replacement value. Manual reported time has no ratio limit or excess warning: it can include reading, checking and other human work that agent runtime does not measure. Existing manual values are preserved without clamping. Old factor-based estimate metadata and history remain readable, without further automatic rescaling. Manual time tools retain their explicit-user-instruction requirements and cannot edit actual.

## Storage and history

Sequential migrations add `day_items`, `day_configs`, `day_item_events`, `day_config_events` and `calendar_sync_state`. Additive agent-time migrations add `agent_time_state`, `agent_time_threads` and `agent_time_events`, containing measurement checkpoints and minimal timestamp/ID receipts rather than message contents. Full database backups preserve them. Entries have their own revisions. Time changes, history and request keys are saved transactionally. History records actor, source, time and before/after values. Removing an entry preserves its history and manually reported time. Removing a meeting clears calendar-generated reported time, which also clears its meeting actual time. Restoring that meeting resumes normal calendar accounting. Explicit manual meeting reports, including zero and blank, remain unchanged. Completing or archiving a task does not delete its hours. Reports are calculated from the saved journal rather than stored separately.

Hourly source checks reconcile measured work before deciding whether a model is needed. Their day-review pages include only new or changed work and explicit re-estimation requests. Unchanged AI estimates do not schedule themselves again; manual overrides remain excluded. An unread work item remains eligible on the next check.


## Reported work descriptions

Use `reportedWorkSummary` for a short plain English description of work actually
performed for that day. It can be saved with `c247_plan_add` or `c247_time_edit`,
including a summary-only correction using the current item ID and revision.
A description edit must not change minutes. Describe evidence from the conversation
or accepted results, not the task title or a future step. Write a concise sentence,
without bullets, emoji, markup or long dashes. Existing minute corrections preserve
the description. A session recorder supplies `reportedTime.workSummary` separately
from the estimate rationale; the normal proposal approval applies both together.
