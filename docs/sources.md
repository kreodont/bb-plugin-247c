# Source configuration

The BB `sources` setting contains JSON following [sources.example.json](sources.example.json). Keep your completed configuration outside the repository. It configures searches and account identity; do not put tokens or passwords in it.

For corporate conversations, also follow the [setup-agent guide](setup-agent.md) to preauthorize source reads in the provider's local profile. These permissions are separate from the plugin's `sources` JSON and its approval workflow for task records. The repository contains the setup policy, not an installed permission allowlist.

The plugin reads the saved Claude login from `profilePath`: through Keychain on macOS, or the file created by Claude on other systems. Sign in to that profile with the standard Claude CLI and connect the required integrations. `expectedEmail` is required; the plugin verifies the account matches. Set `profilePath` explicitly to your configured profile; no personal profile path is bundled. Login refresh requires `claude` on the BB server's PATH.

`jiraSite` restricts reads to one Jira site. `jiraScope` is the JQL condition within the time interval. `jiraProjects` optionally lists exact allowed project keys, for example `["APP", "OPS"]`: it restricts searches and linked reads, including direct URLs from other sources. An empty list keeps automatic discovery. Store this preference in the installation settings or local settings patch, not in the repository. Each native check freezes this scope for coverage validation; excluded projects do not create missing-read warnings. Existing task records are preserved. `slackChannels` lists channel names to search; `slackGroups` lists group chat IDs whose history should be read. Set `slackUserId` to the account owner's Slack member ID: the collector searches the literal `<@USER_ID>` mention across accessible channels, including channels outside `slackChannels`. The `to:me` search alone can miss these mentions. `mailFilters` is appended to general email searches; unread inbox messages are checked separately. `analysisContext` explains the account owner's responsibilities to the analysis model and must not contain secrets. `calendarId` selects the calendar; `primary` resolves to `expectedEmail`.

Apply a local configuration file without shell interpolation:

```python
import json, subprocess
from pathlib import Path
profile = json.loads(Path("/path/to/sources.private.json").read_text())
subprocess.run(["bb", "plugin", "config", "247c", "set", "sources", json.dumps(profile)], check=True)
```

The setting is also available under Extensions → Plugins → 247C. Run a manual source check with an available model and workspace. You can then enable `hourlyUpdates`: between `updateStartHour` and `updateEndHour` in `timeZone`. Enable `updateWeekdaysOnly` locally to skip Saturday and Sunday; by default every day is eligible. The local calendar date determines the weekday, including overnight hour windows. Skipped days do not advance source checkpoints: the next check includes the intervening events. Manual checks remain available every day. Set `syncProvider`, `syncModel` and `syncReasoningLevel` to choose the hourly execution settings independently of the last manual check; blank fields reuse that check's selection. `calendarMeetings` controls calendar import. Models and connected accounts remain subject to the selected provider's billing and limits.

Changing calendars does not modify earlier meetings from another calendar. An incorrect account or missing login preserves existing data and shows an error. Installing the code on another computer does not transfer this profile or synchronize databases.

For a calendar collected by a local script, set `calendarReaderCommand` to a JSON
argument array, for example `["/usr/bin/python3", "/private/calendar-reader.py"]`.
The executable must use an absolute path; it runs without a shell. Its stdin is
`{"from":"YYYY-MM-DD","through":"YYYY-MM-DD","known":[...]}`. Both dates are
inclusive, and `known` contains existing normalized calendar events. Return exactly
`{"events":[...],"readCount":0}` on stdout, with events following
`calendarEventSchema` in `day-contracts.ts`. Use stable keys, offset-bearing
timestamps, HTTPS event links and explicit cancellation/decline states. The
reader must verify account identity, finish pagination and recheck missing known
occurrences. Partial reads must exit nonzero, preserving saved meetings. Store
receipts locally; never include credentials in output. The plugin validates the
whole response before merging and preserves manual time overrides. The script
has a five-minute timeout and an 8 MiB output limit. `[]` keeps the default
Google Calendar reader. `calendarMeetings` controls either reader.

An external day planner should call `calendarSync` and wait for `calendarState`
to finish before reading the day. Refresh the calendar even when the day's task
plan is already saved. Meetings remain calendar rows; do not create task dossiers
to represent them.

Gmail permalinks can identify a message rather than its thread. The collector resolves message IDs from already loaded threads or with the read-only `get_message` metadata operation, then reads the full conversation once. Connector errors include the requested ID and the source's error text.

Without a configured project list, a bare issue-shaped string requires project evidence from a Jira URL, Jira search result or Jira notification subject. Store and customer codes in saved notes cannot establish a Jira project. Keys discovered before project evidence are reconsidered when that evidence arrives.

Jira link discovery excludes UUID fragments and bare `Q-…` quote numbers. An explicit Jira `/browse/Q-…` URL still identifies a Jira issue. Collection and coverage validation use the same reference rules; unavailable real issues continue to make the check partial.

Issue-shaped examples whose number consists entirely of zeros, such as `CASE-000000`, are excluded from link discovery, including in Jira URLs. Their original source text remains in the export. Positive issue numbers continue to be checked, and actual access errors still make the result partial.

The collector follows newly discovered links until the queue is exhausted, subject to the existing time, request and export-size limits. Linked issue chains are not cut off after a fixed number of hops. Hitting a limit or failing to read a real issue still preserves the previous source checkpoint.

## Missed update checks

A new substantive request on a completed task can produce a proposal to reopen that same task with a new next step. The analyst checks the full conversation for later replies and preserves the accepted completed work. Status and next-step evidence must be newer than the task's last saved change and within the current source interval. Reopening happens only after human acceptance. Old reminders, acknowledgments and missing telemetry do not reopen tasks; archived tasks remain excluded.

When adopting this rule, incremental analysis revisits available sources linked to completed tasks once. Unrelated unchanged documents retain their baseline; the update does not require a full analysis of every source.

Each check takes a complete snapshot of unreviewed source proposals, including pending new tasks, and rechecks their linked sources alongside open tasks. The analyst combines relevant new findings with all matching pending proposals from earlier checks. Unrelated requests remain separate; one unchanged proposal is kept without creating another approval.

A combined proposal preserves earlier facts, quotations and untouched proposed fields. Changed summaries and arrays describe the complete current result. Conflicting or stale field changes must be reconciled explicitly. Previous proposals become superseded history only after the combined result validates and is saved atomically with a new approval ID. Tasks still change only through human acceptance.

Concurrent acceptance, rejection or dossier edits block a stale replacement. Rejected findings are not revived by an unchanged replay. Old receipts may substantiate unchanged carried facts, but never count as fresh source coverage; unavailable sources still produce a partial result. Oversized analyses or combined proposals fail without removing the pending backlog.

The collector also searches `from:me` across accessible Slack channels so user-authored work updates and review requests are not limited to watched channels. It reads each full thread and reconciles the work with existing tasks and pending proposals. Acknowledgments alone do not create tasks, and colleagues' approval actions remain theirs.


Pull requests belong to the underlying work item. For a newly discovered PR URL that is absent from task dossiers, the collector searches older Gmail threads by that exact URL, reads their full bodies, and follows related issue keys. This context lookup has no lower time bound; it is subject to the existing export limits and interval end. Older messages identify the work but do not count as new progress. Already linked PRs reuse dossier context without repeating that lookup.

Before proposing a separate PR task, compare its title, issue and parent-story keys, and implementation scope with every task and pending proposal. A reviewer comment normally updates the existing task. If the export contains only a number/link and a short reply, report the unresolved association instead of treating it as unrelated work. The server rejects a new-task proposal that reuses a PR URL already present in an accepted dossier, including closed tasks. Repository names or shared participants alone are insufficient evidence of ownership.

## Discussing a finished check

You can continue a check conversation after it completes, fails or is cancelled to ask about its findings. The analyst can read the retained export, receipts and accepted task context. This does not reopen the run or change its proposals or source checkpoints. Start a separate check in the Updates panel to analyze fresh sources. There is no need to disable 247C to discuss an earlier check.

## Incremental hourly analysis

Scheduled checks still collect fresh source receipts and follow pagination every hour. Before launching a model, 247C compares each full thread/issue with a previously completed analysis, using its source, read arguments and content hash. Run-specific receipt IDs do not count as changes. Only new or changed documents enter the default analysis pages. A changed accepted task also revisits its linked source context; a task without stable source links or an analysis-policy change requires a full pass. The first scheduled check after installing this feature establishes the baseline.

The complete current export remains saved for auditing, coverage checks, exact citations and recovery. The analyst can find and read extra context with `c247_sync_context` when needed. It must read every primary analysis page before submission; unchanged context does not need to be read routinely. Omitted documents are never used as proof that a source was checked: current connector receipts still determine coverage and checkpoints.

When there are no documents requiring analysis and no new work to review in the day plan, the check finishes without creating a model conversation. The Updates panel reports that the model was not used. Calendar import and measured agent-time reconciliation still run. Partial source coverage stays partial and does not advance that source's checkpoint.

Day-plan analysis is also incremental: new measured work, changed evidence and explicit requests for a new estimate become eligible. An AI estimate itself does not trigger another review of unchanged work. Only entries actually returned to the analyst are remembered as reviewed; an unread entry stays eligible for the next check. Manual time is never overwritten by this mechanism.

Cancelled, blocked and unfinished analyses do not establish a baseline. Successful partial runs can retain their analyzed documents while keeping incomplete source intervals open. State survives plugin reloads in the local database. A manual check remains a full analysis, including custom focus instructions; it does not replace the general hourly baseline. Source-policy changes invalidate reuse, and analysis-rule changes must bump the cache version in `source-analysis.ts`.

Slack thread comparison ignores the moving upper time bound of a read. The thread identity and its content still determine whether it needs analysis: new replies, edits and read-scope changes are not suppressed. Existing completed analyses are reindexed from their saved exports so an upgrade does not require a full model pass. Raw receipts and source coverage checks are unchanged.

## Independent account-pool login

An installation may configure `accountPool` in its local `sources` setting instead of reading a native Claude profile:

```json
{
  "expectedEmail": "owner@example.com",
  "accountPool": {
    "pluginId": "example-account-pool",
    "accountId": "11111111-1111-4111-8111-111111111111",
    "organizationUuid": "22222222-2222-4222-8222-222222222222"
  }
}
```

The installed pool must implement `source-auth.v1.prepare`, accepting `accountId`, `expectedEmail` and `organizationUuid`. It validates an enabled independently authorized OAuth account and refreshes it when needed. Its response contains `credentialFile` (an absolute private file path), `accountEmail`, `organizationUuid` and `expiresAt` (epoch milliseconds). The file contains `kind: "oauth"`, `accessToken` and `expiresAt`. Tokens must never appear in the RPC response.

247C reads the credential in memory without copying or refreshing it. The pool remains its sole refresh owner. Both source collection and calendar imports use this setting. An unavailable pool or mismatched identity fails the check without falling back to Keychain, another organization or a personal account. The selected organization is independent of the pool's inference failover. Keep real identifiers and paths in local settings; never commit them. Without `accountPool`, existing profile-based installations retain their behavior.

## Independent source budgets and connection diagnostics

Native Gmail, Slack and Jira reads start as soon as their own connection is
ready. Each source gets 180 seconds of active reading time, including retries,
with up to 600 operations and a 32 MiB receipt ceiling. Concurrent reads share
that source's clock. Connection setup and idle waits for links from other
sources do not consume it. The existing 45-second setup budget and two-attempt
limit apply separately to each connector. Shared account authentication and
catalog discovery still precede those connections.

A timeout or exhausted allowance keeps that source incomplete and preserves its
checkpoint. Other sources can finish and advance their own checkpoints. Stopping
a check cancels all sources. More independent work can make a check take longer
than the former shared three-minute deadline; it remains bounded by each
source's allowance.

**Connection diagnostics** appears on Updates and in Check history. Each attempt
is saved immediately, including failed attempts followed by success. Records
include time, duration, setup stage, outcome, failure category, HTTP statuses,
parsed Retry-After and an allowlisted rate-limit reason when supplied by the
transport. HTTP 200 alone does not prove that MCP initialization or tool discovery
completed, and a timeout alone does not establish a rate limit. Diagnostics omit
request URLs, credentials, arbitrary headers, response bodies and source content.
Existing checks have no retroactive diagnostics. No database migration is needed.
