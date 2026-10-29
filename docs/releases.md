# 0.5.116

Pinned files uses an amber accent and a pin icon. In thread headers it appears
after the task actions with extra spacing, making it easier to distinguish from
the Source link. File opening and shortcut storage are unchanged.

# 0.5.115

Source proposals for tasks waiting for a response now include independent,
preselected actions to reopen the task and open its work chat with the update.
Acceptance reuses an existing conversation or creates one with the configured
work model. Messages queue behind active work and wait for active reviews.
Partial decisions survive proposal merging. Durable delivery receipts prevent
duplicate messages after retries or restarts; delivery status and chat links
remain visible with recently accepted tasks. Closing proposals are unchanged.

# 0.5.114

Source updates may propose reopening an archived task when a verified new request
postdates the task's last saved change. The proposal must include both status=open
and a specific new next step, with fresh source evidence for each. The task stays
archived until human acceptance. Old requests, missing evidence and updates that
do not propose reopening remain rejected. Pending follow-ups can be merged without
losing their original verified request or creating duplicate tasks.

# 0.5.113

Worker startup snapshots reserve space for accepted work, source links and recent
facts before long question or blocker lists. Oversized essential fields appear as
explicitly incomplete excerpts instead of disappearing. Workers are instructed to
read the complete current context before their first task answer or source search,
and compare incoming requests with accepted work. Existing conversations refresh
older snapshot versions on their next dispatch without losing history.

Dossier tool responses are limited to 12 KiB, including metadata and cursors, to
avoid provider-side file spill. Pagination preserves all evidence and Unicode;
large filter cursors are compressed with bounded decoding. Existing cursors remain
readable. No task data, approval rules or source collection settings change.

# 0.5.112

Session recorders receive message timestamps and evidence grouped by the planning
time zone, so a multi-day conversation can support a reported-time estimate for
the target day. Timestamps identify dates, never work durations. Legacy retries
and review discussions recover dates only from matching original messages without
rewriting frozen transcripts. Unknown dates stay unknown. Existing totals, manual
corrections, approval requirements and duplicate-time protection are preserved.

# 0.5.111

Finishing and retrying a session accept native Windows workspaces as well as
macOS and Linux paths. Artifact verification uses the workspace path format,
preserving containment checks across drives and UNC shares. Windows file paths
are compared without case sensitivity to prevent duplicate artifact entries.

# 0.5.110

The chat header Proposal button opens the session review in a modal over the chat.
Full and partial acceptance, rejection, stale-proposal recovery, evidence and
discussion use the existing review controls. Decisions and errors stay visible
without a page change; closing returns focus to the chat's Proposal button.
The full-page view remains available. No database migration or settings change
is required.

# 0.5.109

The thread header Terminal button starts the default shell selected by BB, including
PowerShell on Windows, instead of requiring ZSH. It keeps terminal reuse and the
thread workspace scope.

# 0.5.108

Knowledge export works in native Windows without administrator privileges or
Developer Mode. It uses directory junctions and restores the previous pointer if
publishing a replacement fails. Unchanged generations keep their existing pointer;
accepted content and previous generations are preserved. The Windows setup guide
now distinguishes the native BB desktop alpha from WSL2.

# 0.5.107

The original work chat now shows an amber proposal indicator in the thread list
when its review produces changes awaiting approval. It replaces the review spinner
and remains visible after opening the chat, partial decisions and BB restarts.
Accepting or rejecting the remaining changes clears it; reviews with no changes
leave no indicator. The existing Proposal button opens the exact session result.

# 0.5.106

Opt-in daily storage maintenance protects task history, pending proposals and unread intervals. Old source payloads retain cited receipts; local backups keep three verified recovery points with crash-safe BB snapshot bookkeeping. Drive archives use daily, weekly and monthly tiers. Only registered development caches and diagnostic logs expire.

## Optional project scope for agent context in 0.5.104

The local `scopeAgentsToProject` setting limits 247C tools and their instructions
to the configured thread project and 247C-created conversations. Other projects
keep access to the panel and CLI without receiving task-management context.
Existing worker, reviewer and analyst restrictions are preserved. The default
remains unrestricted, and the preference survives plugin updates.

## Successful updater runs with queued work in 0.5.103

The Updates panel now advances Last successful run after a successful check even when records remain queued for analysis. Queue depth stays visible separately, and the waiting message confirms that the latest check completed. Deferred analysis, failed runs and unresolved import errors do not advance the successful-run timestamp.

## Accepted task snapshots in 0.5.102

Work chats now receive the actual accepted task fields alongside the revision
marker. A version-only reminder could leave a resumed worker answering from an
old dossier. The bounded snapshot supplies the current summary and next step,
lists any omitted fields explicitly, and preserves existing conversation history.
Existing marker-only runtimes refresh on the next continuation.

Complete dossier reads now have a separate version receipt. Refreshing the
runtime or reading only part of a paged dossier does not count as a complete
read. No extra model turn, account change or database migration is required.

## Work chat context refresh in 0.5.101

Long-running task conversations now receive the current accepted dossier version
before continuing after a task update. The worker is instructed to reread changed
context, including primary-source changes, while preserving the same chat and
history. Active turns finish before refresh; the user's next message stays queued
until the idle runtime is ready to resume. Existing chats are upgraded on their
next continuation. No additional model turn is launched for synchronization.

Pending proposals remain unaccepted, unchanged dossiers are not repeatedly
reloaded, and recorder snapshots keep their existing semantics. No database
migration, account change or local configuration update is required.

## Source connection recovery in 0.5.98

The built-in collector retries a transient connection setup failure once with
a fresh MCP session. Failed sessions are closed before retrying; permission
errors, incompatible tool catalogs and cancellation are not retried. A shared
45-second setup budget bounds initialization and tool discovery, including the
retry delay. Existing per-request and collection limits remain in effect.

Connection warnings identify the failed stage and make clear that no source
data was read. Persistent provider failures remain visible and preserve unread
intervals. This improves recovery from brief interruptions; it does not repair
an unavailable remote connector or replace its account. No migration or local
configuration change is required.

## Missing Slack messages in 0.5.96

An explicit `thread_not_found` response no longer makes a source check incomplete
when another successful read in the same channel confirms access. When needed,
the collector performs one small channel access check. It retains the missing
message receipt and records a neutral skipped-message note; the failed read
cannot substantiate a proposal. Normal source checkpoints can advance.

Timeouts, rate limits, permission failures, inaccessible channels and incomplete
pagination still produce warnings. Existing native checks are displayed under
the same rules using their retained receipts, without rewriting saved runs,
exports, tasks or checkpoints and without starting a model. Missing messages
are tried again in future checks, so restored messages are not permanently lost.

## Source quote validation in 0.5.97

Visible source analysis threads now check citation text against its supplied
record before freezing a result. Rewritten speech, joined passages and quotations
from another record return a tool error in the same conversation, so the model
can correct its response without a replacement analysis run. Saved source bodies
remain private and survive plugin reloads. Existing jobs retain their original
validation contract. The importer still validates against the full source receipts.

No source, schedule, model or database migration changes are required.

## Source analysis coverage in 0.5.95

Visible source analysis threads now validate event coverage before saving a
result. Unknown or repeated skip IDs and omitted selected events return an
actionable tool error, allowing correction in the same conversation. Invalid
submissions remain unsaved; no replacement thread or automatic model retry is
started. A compact event ledger survives plugin reloads without storing source
bodies in KV. Older jobs and collectors without event identities retain their
existing import validation.

Source collection, schedules, model selection and human proposal approval are
unchanged. No database migration is required.

## Built-in file editor in 0.5.83

247C now ships the file editor and its lazy Monaco assets. Every new or updated
installation can edit text files without the separate `file-editor-save`
plugin. Save, auto-save, keyboard commands, syntax highlighting and guarded
conflict handling are preserved.

**Show in folder** opens the current file location on its actual machine in
Finder, Explorer (including WSL), or a Linux file manager. It does not save or
discard pending edits. A desktop session is required on that machine.

Save open edits before updating and disable an existing standalone editor
after verification. No database migrations or changes to source connections,
settings, pinned paths or task data are required.

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

## Missing chats in 0.5.93

Search no longer warns or repeatedly retries when BB explicitly reports that a
chat does not exist. Missing chats are excluded from coverage totals; accepted
tasks, dossiers and any indexed or saved conversation text remain intact. A
future host event can make a restored chat eligible for indexing again.

Temporary failures, permission errors and ambiguous HTTP errors remain visible
and retryable. An append-only migration records missing chats in the derived
search index and rechecks previously failed reads once.

## Message navigation in 0.5.92

Search results now use **Open message** to navigate through BB's thread routing
and its native message fragment. Native message IDs can differ from timeline
range starts; existing chat index entries are refreshed to correct that metadata.
The follow-up migration updates only the derived search checkpoint table.

## Full-text search in 0.5.91

Added **Search** to persistent navigation and **Search all** to the task filter.
Search covers accepted task fields, complete dossier history, saved conversations
and bound BB work/review chats, including closed tasks. Excerpts highlight matches;
results link to the task, chat and source message and distinguish current accepted
data from conversation history. Filters narrow the record type and task status.

An append-only migration adds derived FTS5 tables, a durable change queue and chat
pagination checkpoints. Existing task data, transcripts, source connections,
settings and manual time are unchanged. Backfill resumes after reload, active chats
refresh without model calls, and unavailable chats remain visible as incomplete
coverage. Search reads no pinned files, attachments or tool payloads. Queries and
result text are excluded from plugin logs and UX recording.

## Sent-reply verification in 0.5.90

Work agents now receive a shared rule to check the source when a user says they
replied or sent a message. Checks use targeted read-only access, verify the actual
message and destination, and compare substantive content with the agreed answer.
Agents should cite the source and suggest corrections when needed, while keeping
missing access and unverified delivery explicit. The rule does not authorize
external sends or edits, and sending a reply does not by itself complete a task.

The rule is injected for empty chats, ordinary conversations and criterion-based
workers, including resumed sessions. Source analysts and snapshot-only reviewers
do not receive a conflicting instruction to fetch sources. Recorders preserve the
distinction between a user's report and the worker's reported source check.
Empty-chat context stays within BB's instruction limit even with maximum local
instructions. No database migration or local settings change is required.

## Unobtrusive UX recording in 0.5.89

Removed the floating recording banner. The collector remains mounted and keeps
recording across navigation and reloads. Status, last saved time, feedback and
pause controls are available under **More → UX recording** and in settings.
Existing consent, recording history and retention rules are unchanged.

## Direct task and review navigation in 0.5.88

Task dossiers now keep **Open chat** or **New chat** in a sticky action bar,
with shortcuts to an in-progress review and pending changes. Opening a chat
navigates directly to its native BB thread without visiting the Work tab.

After a session proposal is fully accepted, the page shows a compact saved
confirmation with **Choose next task**, **Open chat** and **All proposals**.
Accepted details remain available in an expandable section. Partial acceptance
keeps the remaining proposal expanded. The cleared Proposals inbox also offers
**Choose next task**: selection opens the existing conversation or creates an
empty one using the saved defaults. No task is selected automatically.

Local UX recording now distinguishes task sections, context actions and these
navigation shortcuts using fixed action names. No task text or identifiers are
added to recording payloads. No database migration or settings changes are needed.

## Windows paths for pinned files in 0.5.87

Pinned files now accepts Windows paths when BB runs inside WSL. The plugin
converts the path through `wslpath`, honoring custom mount locations, and saves
the Linux path for the file editor. Native Windows, Linux and macOS paths remain
supported. Conversion uses no shell and does not read the target file.

Save failures now distinguish invalid paths, failed WSL conversion and local
settings errors, without displaying private subprocess output. Existing
shortcuts and file contents are unchanged; no data migration is required.

## Direct chat shortcuts after approval in 0.5.86

Each recently accepted task now has both **Open task** and **Open chat** actions.
Open chat returns to an existing work conversation or creates an empty one using
the saved defaults, then navigates directly to it. Duplicate clicks and uncertain
responses reuse the same launch request.

A user can also open a fresh conversation on a completed or archived task without
changing its status. The chat and its subsequent review preserve that status;
reopening the task still requires an explicit decision. No schema migration is
needed, and existing work sessions keep their previous status checks.

## Accepted task shortcuts in 0.5.85

The Proposals page keeps an **Accepted recently** list after approval, with a
direct **Open task** action on each row. It shows up to 50 distinct tasks
accepted in the last 24 hours, newest first, using their current titles and
statuses. Repeated approvals of one task share a single row.

The list comes from existing application receipts, so it survives page reloads,
navigation and BB restarts. Bulk, individual and partial approvals are included;
rejected, pending and failed proposals are excluded. No database or settings
migration is needed.

## Visible script analysis conversations in 0.5.84

External source updaters can launch their existing saved-batch analysis in a
visible conversation in the configured local 247C project. Updates links the
latest analysis and its recent history. Threads keep the supplied provider,
model and reasoning effort, receive a dated title and never open automatically.

Durable launch keys prevent duplicate model runs after retries or lost responses.
The result is frozen once submitted; the existing script still validates and
imports it as pending Proposals. The conversation remains available for discussion.
This adapter does not collect sources, schedule checks, select batches or start
models for empty checks. Existing integrations opt in explicitly; no settings or
database migration is required.

## Distinct chat header actions in 0.5.82

Chat header buttons now use consistent role accents: blue for the task, purple
for the terminal, cyan for reported time, amber for proposals and reviews, and
green for finishing a session. Review failures retain a red warning. Source and
pinned-file shortcuts use neutral surfaces. The colors follow BB's active theme;
labels and distinct icons remain available so color is never the only cue.

Buttons are slightly taller, with stronger labels and keyboard focus outlines.
Reported time includes a clock icon on wide screens as well as compact screens.
Navigation, review actions, time editing and local file handling are unchanged.
No data or settings migration is needed.

## Thread terminal shortcut in 0.5.81

The thread header's **Tasks** button is replaced by **ZSH**. It opens BB's
terminal panel with a login zsh on the thread's own machine and workspace.
Repeated clicks reopen the existing 247C shell; an exited shell is replaced.
Concurrent clicks share one creation request, and a late response cannot open
a terminal in a different chat. Other terminals are never sent commands or
restarted. The task switcher remains available through **247C: Switch task**
and Cmd/Ctrl+Shift+K; the plugin's Tasks page is unchanged.

This uses the public terminal-panel API in the current BB SDK. Older BB clients
without that API show an update message before creating a terminal. The thread's
machine must have zsh installed. No database or local-settings migration is needed.

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

## Queued analysis status in 0.5.94

Saved records waiting for an active or scheduled analysis now appear in a yellow
status banner. Normal queueing no longer shows the red exclamation badge or an
urgent popup. Paused checks, failures, import recovery and queues without a next
run keep their error presentation. No database migration or settings changes.

## Independent source collection in 0.5.100

Gmail, Slack and Jira start reading independently and have separate time, request
and receipt-size budgets. A slow Jira handshake no longer spends Gmail's reading
time. Completed connection attempts are saved immediately and shown in Updates
and Check history, with transport status and Retry-After where available. Failed
source checkpoints remain unchanged. Account selection and authentication are
unchanged; no database migration or local settings change is required.
