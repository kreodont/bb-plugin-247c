# 247C day planning and time journal

Planned and reported time are stored in 247C SQLite separately from the accepted task dossier. Time edits do not accept proposals, complete tasks or change priority.

## Tools

- `c247_day({date?})` reads a day with full entry IDs and revisions. The default is today in Europe/Athens.
- `c247_plan_add({requestId,date,taskId,step?,plannedMinutes?,reportedMinutes?})` adds an existing task to a date. Each task can have one entry per day. Closed tasks are also supported.
- `c247_time_edit({requestId,id,revision,plannedMinutes?,reportedMinutes?,operation?,...})` edits only supplied fields. `operation=set` replaces the total; `operation=add` adds minutes. `null` clears a field; `0` is an explicit zero. Planned and reported time are independent.
- `c247_plan_move({requestId,id,revision,date})` preserves time on the original date and creates a continuation with blank values. It cannot reschedule meetings.
- `c247_time_report({date?,period:day|week,taskId?})` reads an internal report. Weeks start on Monday.

Edit manual time only on explicit user instruction, in any language. Never infer it from chat duration, task completion, email, calendar descriptions or guesses. Distinguish “set the total to 3 hours” from “add 20 minutes.” If the task or date is unclear and context does not resolve it, clarify before writing.

Read the day before editing. Reuse one `requestId` when redelivering the same request to prevent duplicate additions. Changed requests need a new UUID. On revision conflict, reread the entry and do not automatically overwrite another edit. A worker can access only its task's entries; recorders and source analysts cannot edit manual time.

## Meetings

The calendar script uses the configured Claude profile, verifies the account in `sources` and reads its configured Google Calendar. `calendarMeetings` enables import during source checks; the day screen also supports a separate import. Times use Europe/Athens. The window starts on the selected week's Monday and ends seven days after the selected date, inclusive.

Import accepts individual occurrences of ordinary events with start and end times. All-day and special event types are excluded. If a previous event is missing from the list, its ID is read separately so a move is not mistaken for cancellation. A failed page or recheck prevents partial application. Reimport updates the same entries. Stopping the related source check or reloading the plugin cancels an unfinished import.

Each time field has its own automatic or manual mode. Automatic planned time equals calendar duration; reported time equals the current planned time after an active meeting ends. This is a reporting convention, not proof of attendance. A background check runs every 30 seconds while BB is running and when the plugin loads.

Manual reported time, including zero and blank values, survives updates. `restoreAuto=planned|reported|both` explicitly restores automatic behavior; send it separately from manual time and `reportedDate`. A moved meeting retains the previous manually reported date until explicitly edited. Cancellation, declining or conversion to an excluded event removes automatic hours while preserving manual reports. Do not create a separate task for a calendar event.

## Storage and history

Sequential migrations add `day_items`, `day_configs`, `day_item_events`, `day_config_events` and `calendar_sync_state`. Entries have their own revisions. Time changes, history and request keys are saved transactionally. History records actor, source, time and before/after values. Removing an entry from the plan preserves it and its reported time. Completing or archiving a task does not delete its hours. Reports are calculated from the saved journal rather than stored separately.
