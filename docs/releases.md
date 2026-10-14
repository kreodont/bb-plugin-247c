# Release and recovery checks

The production installation should use
`git:https://github.com/kreodont/bb-plugin-247c.git@main`. Development belongs in
a separate Git checkout. Do not edit the downloaded installation or copy an
uncommitted working tree into production as the final delivery.

Before an update, inspect `bb plugin source 247c --json`, fetch GitHub and check
the working tree. Preserve any local differences in a private backup and in Git
before reconciling them. Keep credentials, settings, databases and verification
transcripts outside the repository.

Run `npm run typecheck`, `npm test`, `python3 -m unittest discover -s tools` and
`npm run build`. On macOS, use `TMPDIR=/private/tmp npm test` to keep temporary
path spelling consistent. Review and commit the source and generated artifacts,
then publish an immutable version tag and the main branch. Never move old tags.

Save a [verified backup](recovery.md) before updating. With a managed installation,
run `bb plugin update 247c`. Compare the resulting source commit and installed
artifact hashes with the published revision; check plugin status, saved settings,
database integrity, tasks and manual time. A successful build or matching package
version alone does not establish that the live installation was updated.

## Automatic working-context compaction in 0.5.80

Large agent dossier reads now start with the current accepted state, protected
evidence and recent progress. Older progress and next-step records stay available
through keyword search, fact IDs, fact kinds or a full accepted read. Compaction
reports deferred history explicitly; it never rewrites facts, deletes records,
invents a summary or starts an extra model call. Critical evidence is kept even
when it exceeds the soft size target, with lossless paging as the fallback.
Search filters survive continuation pages, and ownership checks apply to every
read. No data or local settings migration is required.

See [Reading dossiers](dossier-reading.md) for thresholds and retrieval rules.

## Paged agent dossier reads in 0.5.79

`c247_read` returns accepted context separately from review and session history.
Responses are bounded to 64 KiB. Oversized sections, including individual large
records, are returned as lossless JSON fragments with continuation cursors.
Agents follow `nextCursor` until null; a changed section requires a fresh read,
so pages from different versions cannot be silently mixed. Task ownership checks
apply to every page. Existing task data and the panel remain unchanged.

See [Reading dossiers](dossier-reading.md) for the tool contract.

## Source gateway retries in 0.5.78

Source checks recognize HTTP statuses in transport-wrapped gateway error events,
including SSE responses with a top-level `message` and `status`. Temporary
502/503/504 failures now receive the existing bounded retries; 429 responses use
the rate-limit backoff. Permanent 403/404 errors are not retried, and nested
quota metadata does not determine retry behavior. If retries are exhausted, the
check remains partial and preserves the unread interval.

## Reported work summaries in 0.5.77

Day entries with reported time show an editable English work summary with autosave.
Session time proposals carry an optional short description of completed work,
separate from the estimation rationale; acceptance saves it with the day entry.
Manual minute corrections and removal/restoration preserve the description.
Calendar entries show their meeting title by default, and a continuation starts
with a blank summary. Existing proposals and time history remain readable without
a migration; missing descriptions are never inferred from planned work.

## Waiting duration in 0.5.76

Tasks waiting for a response show the number of calendar days in the current
waiting period in the task list, cards, task header and Day plan. Hover over the
label to see the exact start in the planning time zone. Counts refresh while the
page remains open and after returning to it.

The start comes from the accepted status history, including existing tasks.
Ordinary edits and repeated Waiting updates preserve it; resuming and entering
Waiting again starts a new period. Tasks without a recorded transition do not
show a guessed age. No data migration or local settings change is needed.

## Sidebar plugin links in 0.5.74–0.5.75

An optional local setting restores text links for visible plugin panels above
the chat list in BB 0.46's icon-rail layout. It follows rail ordering and
visibility, delegates navigation and split clicks to BB, and restores the 247C
proposal count, open task count, reported time and warning badges. The adapter
recovers after sidebar remounts and removes its elements when disabled. Older
BB layouts keep their existing navigation. No database migration is required.
Version 0.5.75 preserves plugin CSS scope when rendering the restored links
inside BB's sidebar, including badge colors and spacing.

## Reported day order in 0.5.72

Day now always sorts tasks and meetings together by reported minutes, longest
first, with blank values last and stable ties. Meetings previously kept their
calendar positions even when reported sorting was selected. The sort selector
and manual move buttons are removed; old browser sort preferences no longer
change the order. Rows update after time is saved without discarding editor
state. Saved time and ordinals are unchanged. No migration is required.

## Proposals in More in 0.5.71

Proposals moves into More, including its pending count. Today, Tasks and Updates
remain directly accessible. The sidebar still opens Proposals automatically when
there are pending proposals, and Tasks otherwise. Pending-edit navigation guards
and continuous UX recording are preserved.

## Continuous UX recording and direct Updates navigation in 0.5.70

Updates is a top-level navigation button beside Proposals, with the same pending
edit guards. UX recording can now run until explicitly paused. Upgrades and
restarts preserve consent; existing timed studies are not silently extended.
Pause is confirmed in the review page, and paused/error states remain visible.

Storage rotates at its raw log budget and retries temporary failures. Daily
counts survive raw event expiration for 90 days without retaining notes, client
IDs or coordinates. The last save and bounded control/recovery history explain
recording status. Recent browser-session buffers survive frontend reloads.
Compatible previous UI builds remain accepted; new events carry the package
version. Focus noise is coalesced, and chat, proposal-selection and reported-time
controls have distinct actions. No task data or settings migration is required.

Regression checks cover continuous recording beyond seven days and across reload,
legacy expiry and explicit pause, storage failures, full-budget rotation, retries
at hour boundaries, partial log writes, summary crash recovery, privacy validation,
dialog outcomes, and buffer restoration. Real BB restarts still require the app to
be reopened; recording cannot observe an application that is closed.

## Calendar button JSON input in 0.5.69

Check calendar on the Updates page now omits an unspecified date from the RPC
request. Previously it sent an undefined value, which BB rejected before the
calendar reader could start. Checking a selected day still sends that date.
Both page entry points are covered by UI regression tests. No data migration or
settings change is required.

## Jira reference scope in 0.5.68

Store and customer codes in task notes no longer establish a Jira project by
themselves. Without a project filter, bare keys require project evidence from a
Jira URL, search result or Jira notification. Keys seen before that evidence are
reconsidered when it arrives. Genuine unavailable issue links remain partial.

The installation-only `sources.jiraProjects` list restricts JQL searches, linked
issue reads and coverage to exact project keys. It also scopes the analyst's
handling of Jira notifications in other sources. Each native check saves its
project scope so later settings changes cannot alter its coverage at submission.
An empty list keeps automatic project discovery. Existing tasks, proposals and
source history are preserved; no database migration is required.

## Source error classification in 0.5.67

Source checks distinguish HTTP error status and diagnostic messages from quota
metadata. An unavailable Jira issue no longer becomes a false rate-limit error
merely because its response includes a `rateLimit` counter. Permanent errors
are reported with the requested issue and original diagnostic without retries;
actual rate limits and temporary failures retain bounded backoff and recovery.
Unread intervals remain preserved. No database or local settings migration.

## Slack evidence and source-check alerts in 0.5.66

Native source checks now feed the app-wide updater notification, sidebar warning
and persistent status banner, without requiring an external automation. Partial
or failed checks remain visible during retries and clear after successful
recovery. Native quick/custom checks remain available.

Slack citations must match the channel and message timestamp of the actual saved
read. A model cannot combine one channel with a message from another. When an
older saved link returns `thread_not_found`, the collector can recover its address
from that citation's verified receipt and read it again. Ambiguous, unavailable
or incomplete recovery remains partial. Original receipts, task data and pending
proposals are preserved; a historical receipt alone never advances coverage.

## Removed meeting accounting in 0.5.65

Removing a meeting from the day clears its automatically reported calendar time
from day, week and sidebar totals. Previously removal converted the automatic
value to manual time, so an unattended meeting kept contributing after it was
hidden. Restoring the meeting resumes calendar accounting. Explicit manual
reports and task time remain unchanged, and the audit history retains the
previous value. No database migration is required; existing manual values are
preserved and can be corrected explicitly.

## Native model defaults for empty chats in 0.5.64

New chat now checks that BB can persist the exact selected work model before
creating a session. Claude Code can accept unlisted IDs on a regular launch, but
BB's native thread-default update requires the model in the provider's catalog.
A missing entry or failed catalog read produces an actionable work-model error
before a thread is created. The selected model is never replaced, and ordinary
chats do not run a verification-model preflight. No data migration is required.

## Explicit Claude work models in 0.5.63

Opening a work chat no longer rejects an explicit Claude Code model merely
because it is missing from BB's catalog. The chosen ID reaches the provider
unchanged, including context-window suffixes. A normal conversation no longer
runs a misleading verification-model preflight. Account checks, separate result
verifier checks and provider errors remain in effect; no model is substituted.
No data or local settings migration is required.

## Day duration sorting in 0.5.62

The Day panel can sort tasks by Planned, Reported or Actual duration in either
direction and remembers the selection locally. Blank durations stay last and
meetings keep calendar order. Manual order remains available; sorting does not
rewrite saved entries or discard pending edits. No data or settings migration
is required.

## Default proposal selection in 0.5.61

Eligible proposals are selected by default on each inbox page, including newly
arriving proposals. Manual deselections survive refreshes and filter changes.
Bulk acceptance applies only to the visible page and proposal type. Blocked
entries remain unchecked, and competing proposals for one task still require
choosing one manually. Nothing is accepted until the user clicks Accept selected.
No database or local configuration migration is required.

## Request budget pauses in 0.5.60

Source cards can show an exhausted request budget as a planned collection pause,
with per-run and rolling daily counts, the earliest available request and the
remaining scan work. Actual errors remain visible alongside the budget. This does
not change limits, scheduling or full-coverage checkpoints and needs no migration.

## Review activity in 0.5.59

The main work chat shows a spinning sidebar indicator while its conversation is
being saved, its review is starting, or the reviewer is running. The indicator
uses BB's thread-row status API and remains visible across navigation. It clears
when review finishes, fails or is cancelled, and on plugin deactivation. Realtime
updates, reconnects and a lightweight fallback refresh keep it current without
starting another agent or changing the main chat's execution state. No database
or local configuration migration is required.

## Collection limits in 0.5.58

Collectors can distinguish finished scans of available chats from excluded chats,
unavailable channels and bounded history. The Updates card shows a neutral scan
result with separate access and history limits when no requests or queued messages
remain outstanding. Actual failures, unfinished scans and legacy snapshots retain
their warnings. Historical coverage and checkpoints are unchanged. No database or
local configuration migration is required.

## Day title alignment in 0.5.57

Long task titles in the day plan wrap alongside the open-chat marker instead of
pushing the title onto a separate row. No data or behavior changes.

## Open chat indicators in 0.5.56

Tasks with an open chat have a filled speech-bubble marker and a filled Open chat
button in task lists, cards and the day plan. New chat keeps its outlined button
and adds a plus icon. Priority colors and existing running-agent indicators are
preserved. There are no database, session or configuration changes.

## Sidebar entry in 0.5.55

Opening 247C from the sidebar checks the current pending proposal count and opens
Proposals when a decision is waiting, otherwise Tasks. Explicit Tasks navigation
always opens the list. Deep links and the originating thread are preserved, and
the entry redirect replaces its history entry so Back returns to the previous
page. There are no database or local configuration changes.

## Compatibility in 0.5.48

This release combines local navigation, review recovery, waiting status and
source-collection improvements with the customer field, ticket search and
protection against double-counting time entered from a session's conversation.

Two earlier code histories used migration 35 for different features: customer
and waiting status. The compatibility layer preserves the exact recorded
statement at 35 and adds the missing feature at 36. Both histories continue at
37. It never rewrites historical migration hashes; an unknown collision fails.

Source exports and historical check snapshots remain intact. Large databases
are supported by streaming backup verification, with a 16 GiB uncompressed
archive limit. This release does not delete source history to reduce file size.

## Source storage in 0.5.49

New source exports and frozen task/proposal snapshots are stored as gzip blobs.
Launch settings, analysis fingerprints and page receipts remain queryable JSON.
Reading an old check reconstructs the same complete export and context; source
citations, pending proposals, recovery and incremental checks retain their data.

An interruptible background service converts existing rows one at a time. Each
conversion verifies its round trip before atomically replacing the original,
and refuses to overwrite a row changed during compression. Plain and compressed
rows remain readable together. Reloading resumes the remaining work.

After conversion, SQLite compaction reclaims the freed pages. It waits while a
source check, review or calendar import is active, and when disk space is low.
No source history is expired or deleted. Future exports are compressed on write.

Keep a pre-update backup. Compressed source storage requires 0.5.49 or newer;
rolling back to an older plugin requires its matching pre-update database.
Normal backups include the blobs and the installed reader code unchanged.

## Source checks and session status in 0.5.50

Slack reports rate limits as a bare `ratelimited` payload, sometimes inside a
transport error. Earlier versions treated it as a permanent failure, so a
throttled thread read left every run partial and the Slack checkpoint did not
advance. Rate limits now wait 5, 15 and 30 seconds before retrying; other
transient errors keep the short retry. The wait ends early if the check is
stopped or reaches its time limit.

Task cards pulse only while an agent is running a review, collection or
worker session. An open conversation waiting for the user shows a static
"Chat open since" label. No database migration is involved.

## Slack reply links in 0.5.51

A dossier can cite a Slack reply by its permalink, which names the reply and
its parent thread. The collector reads the whole parent thread, but coverage
validation required the reply's own timestamp in that read. A reply deleted
after it was cited could never satisfy that rule, so every check stayed
partial and the Slack checkpoint did not advance. Validation now requires the
complete parent thread, the same unit the collector reads.

## Task switcher in 0.5.52

Recorded navigation showed most moves between work chats going back through
the task list. A switcher now opens from **Tasks** in a work chat's header and
from the command palette as **247C: Switch task** (default Cmd+Shift+K).
Open chats come first, then other open tasks; filtering, arrow keys and Enter
jump straight to a chat, and a task without one gets a new empty chat. Task
cards expose the active chat's thread for this. No database migration.

## Pinned files in 0.5.53

Every thread and the 247C page header offer a shared **Pinned files** list.
Opening an entry sends only its explicit machine/path target to BB's existing
file panel; File Editor handles editing. The plugin does not read pinned
contents or add them to conversations, logs, UX recordings or exports.
Shortcuts are stored in a private installation-only settings file, survive
plugin updates and are omitted from recovery archives. Task schemas and saved
settings are unchanged.

## File Editor routing in 0.5.54

Opening a pinned file requires a thread on the file’s machine. Before opening,
247C checks only the shortcut and thread/environment metadata. This prevents
File Editor from resolving a path on a different machine or without an
environment. The 247C page still supports managing the shared shortcut list.
