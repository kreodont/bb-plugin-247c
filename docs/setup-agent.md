# Setup-agent guide

Use this guide when installing 247C on another computer or restoring an
installation. Each computer has an independent database. Configure source
connections using [Source configuration](sources.md); restore existing data only
when requested, using [Backup and recovery](recovery.md).

On Windows, follow [the WSL2 installation guide](windows.md). BB and the model
provider CLIs run inside the same Linux distribution.

## Local configuration patch

Follow [local configuration](local-configuration.md). Inspect `bb 247c local-patch --json` and configure the installation through BB settings. By default, the plugin mirrors every declared setting into its local patch and reapplies it after updates. If `localSettingsPatch` is configured, preserve that explicit file instead; it is authoritative and is not automatically rewritten. Keep real patches, profiles, account details, work rules and permission files out of Git. Preserve the current machine's planning time zone, hourly window and preferred models during migration. Select them explicitly on a new machine.

BB project folders, automations and provider permissions stay in their native local stores and survive plugin updates. Configure those through their supported tools; do not embed actual IDs or account-specific exceptions in the shared code or prompt template.

## Project for 247C threads

To keep 247C conversations together, create or select a standard BB project with
the local folder requested by the user. Set its project ID in the plugin's
**Thread project** setting (`threadProjectId`). Find the ID with `bb project list`.

```sh
bb plugin config 247c set threadProjectId proj_example
```

New work conversations, review discussions, recorders, verification threads and
manual or scheduled source checks all use that project's default local folder.
The native composer opens with the configured project selected. The setting
overrides older saved workspace choices while preserving account, model,
reasoning and permission selections. If the project is unavailable, the launch
fails with a configuration error. Existing threads remain in their original
projects; this setting does not migrate BB history.

Leave the setting empty to use the composer's workspace for work and source
checks, with personal workspaces for reviews. Store the actual project ID and
folder only in local BB settings. On another computer, create or select a project
there and configure its new ID. Prepared recovery settings clear the old ID.

## Account and model for new conversations

The native composer offers GPT (Codex), personal Claude and corporate Claude when
those providers are available in BB. Optional `composerDefaults` JSON selects the
initial account and model for work, review discussions and source checks:

```sh
bb plugin config 247c set composerDefaults '{"providerId":"codex","model":"gpt-5.6-sol"}'
```

Set both fields together. `{}` leaves new work to BB's native selection, retains
the previous conversation's selection for review discussions, and uses the
source check's standard default. Users can change the selection before launch;
the displayed choice is submitted explicitly. This setting does not change the
automatic recorder policy or models already saved with a session.

Claude Code launches with a first message can pass explicit model IDs outside
BB's catalog unchanged, including context-window variants. **New chat** also
saves native thread defaults before the user sends the first message, and BB
requires an exact catalog entry for that update. Register the desired model in
the selected provider's catalog first. 247C checks this before creating an empty
chat, preserves the chosen ID and never substitutes a model. Account availability
is still checked. Ordinary chats select their recorder on Finish; opening them
does not require a verification model. Assignments with acceptance criteria still
check their separate verifier before starting the worker.

For corporate use, register `claude-work` as a separate BB provider and verify its
login profile and account. Do not redirect personal `claude-code`. Account
identities, profile paths and chosen defaults belong in local configuration.

## Settings that survive updates

Keep installation-specific values in a private JSON settings patch outside the
plugin checkout. Follow [Local settings patches](local-settings.md) to register
its path once. Every subsequent plugin load, including a native Git update,
validates and reapplies the named values through BB's settings API. No changes to
the downloaded source are needed. Unlisted settings keep their saved values.

## Automatic day-plan accounting

With `hourlyUpdates` enabled, each hourly check also reconciles the day plan with completed work in linked 247C task chats and their agents. Actual sums measured agent runtime; reported estimates use the volume and type of work, including human reading and checking, and are marked for user review without a ratio limit relative to actual. Existing manual values are preserved. On a fresh machine, tracking starts with that local day and its own BB history. See [Time journal rules](../skills/day-planning.md) for measurement boundaries, manual overrides and recovery behavior.

## Weekday morning planning

The optional BB agent automation uses [the weekday planning prompt](../automation-prompts/weekday-day-plan.md) to save a short day plan from accepted task context, current meetings and unfinished daily steps. It preserves existing entries and time values. It does not estimate manual hours or execute the planned work.

During an authorized setup, inspect `bb automation list --project <project-id>` first and update an existing planner instead of creating a duplicate. Use the user's local schedule and planning time zone; `30 7 * * 1-5` is an example weekday schedule. Choose an available provider/model on that computer; Codex Sol with medium reasoning is a suitable default. Use the local 247C project and a ready environment in its project folder, with permission mode `auto`. Omit `--target-thread` so each occurrence creates a separate conversation.

For example, run this from the repository after replacing the generic IDs, time zone and execution preferences:

```python
from pathlib import Path
import subprocess

subprocess.run([
    "bb", "automation", "create", "--project", "proj_example",
    "--name", "247C weekday day plan",
    "--cron", "30 7 * * 1-5", "--timezone", "Europe/London",
    "--provider", "codex", "--model", "gpt-5.6-sol", "--reasoning", "medium",
    "--permission-mode", "auto", "--environment", "env_example",
    "--prompt", Path("automation-prompts/weekday-day-plan.md").read_text(),
    "--json",
], check=True)
```

Verify the saved timezone, next run, project, model and environment with `bb automation show <automation-id> --project <project-id> --json`. BB must be running for scheduled work to launch. BB stores a copy of the prompt; after editing the portable prompt, explicitly update the existing automation with `--prompt`. The automation and its local IDs belong to BB's private settings, not Git; configure it separately on each computer rather than copying another machine's IDs.

## Manual day planning in the GUI

Connect the existing planner to the Day page through local 247C settings:

```sh
bb plugin config 247c set dayPlannerProjectId proj_example
bb plugin config 247c set dayPlannerAutomationId auto_example
```

The **Create day plan** button saves pending day edits before starting the
configured automation for today in Europe/Athens. It keeps the automation's
provider, model, prompt or script, schedule and duplicate-run behavior. Run
status appears next to the button, and saved entries refresh automatically.
Entry time and day settings save after a short pause or when leaving the field.
The inputs remain editable while saving. Failed saves preserve the draft and
offer a retry; conflicting revisions require an explicit decision.
Opening another date never launches a plan for today by accident. Clearing
either setting hides the control. No automation is created or run by setup.

A script planner can report a no-op with a single JSON output object containing
`kind: "247c-day-planner"`, an ISO `date`, and `outcome: "already-planned"` or
`"already-running"`. The panel shows a readable explanation for these outcomes.
Legacy runs skipped with `wakeAgent false` show a neutral message because their
original reason was not retained.

## Corporate source-read policy

During an authorized corporate setup, configure new corporate conversations to
start with reads from the connected sources already permitted. Reading records,
searching, listing and retrieving existing content should not require a new
permission grant in each conversation. This policy does not grant automatic
permission to send messages, change records, share files, authenticate accounts,
or run arbitrary code.

These are local provider permissions. They are separate from the plugin's
`sources` JSON, source authentication, and human approval of 247C task proposals.
The plugin installer does not apply them automatically.

1. Identify the corporate provider, its actual profile directory, and its signed-in
   account on the target computer. Inspect the provider configuration instead of
   assuming a profile name or home-directory path. Preserve the personal profile.
2. Enumerate the connected sources and their current canonical tool names. Read
   tool metadata rather than exporting business content. Review trusted read-only
   annotations and tool behavior; an authentication tool can be labeled read-only
   while still requiring user interaction. For missing or ambiguous annotations,
   check the tool schema and documentation or implementation. Leave unverified
   tools subject to approval and report the remaining gap.
3. Merge exact, reviewed read-tool names into the corporate profile's native
   allow rules. For Claude Code, use `permissions.allow` in that profile's local
   `settings.json`, following the [permission documentation](https://code.claude.com/docs/en/permissions).
   Discover names on the target machine; do not copy an allowlist from another
   installation. Do not use server-wide wildcards, permission-bypass modes,
   generic tool routers, or blanket shell or network grants to implement this
   source-read policy.
4. Preserve existing deny and ask rules, permission modes, credentials and
   unrelated settings. Save a private local rollback copy before changing the
   file. Explicit organization restrictions continue to apply. Do not treat a
   read permission as a substitute for signing in or reconnecting an expired
   source session.
5. Verify that a fresh corporate session loads the saved profile rules. Use
   isolated local fixtures where possible: representative read tools should run
   without a permission callback, while send, edit, delete, share, authentication
   and generic execution tools should retain their existing approval behavior.
   Never execute real mutations or send messages merely to test permissions.
   Record the checks and any unsupported tools locally.

Recheck this policy when adding a source, changing accounts, or upgrading a
provider. New tools and disconnected integrations do not inherit permission
merely because this guide exists.

## Keep installation data out of Git

Commit this policy and generic setup instructions only. Keep the following
outside the checkout, or in its ignored `local/` directory:

- Actual profile settings and generated permission allowlists.
- Account identities, profile paths and source inventories.
- Installed project IDs and local workspace paths.
- Credentials, tokens, login state and completed source configurations.
- Rollback copies, verification transcripts, database snapshots and backups.

This separation applies even while the repository is private. Never copy an
existing user's profile into a release or an example. Git ignore rules do not
remove files that are already tracked: inspect the staged diff and tracked file
list before committing or publishing.

Script planners can use [planning_eligibility.py](../automation-prompts/planning_eligibility.py)
to exclude explicit approval and response waits in the current accepted projection.
Apply the check before model selection, when validating its result, and immediately
before adding each task. A missing match does not establish authorization: the
planning prompt must still require an actionable assignment for the relevant stage.
Ignore historical waiting facts once current accepted context supersedes them, and
invalidate cached plans when introducing this policy. Keep installation-specific
scripts and task data in the local configuration area.

## Script collection coverage

An external updater can include an optional `sourceCoverage` array in its local
version 1 health snapshot (`sourceUpdaterStatusFile`). Each entry supplies
`source`, ISO UTC `collectedAt` and `since`, nullable `fullyCheckedThrough`,
`status` (`complete`, `partial`, or `unavailable`), `savedRecords`, and `gaps`.
Optional `scannedChats` and `discoveredChats` explain chat coverage. Include at
most six sources and ten gap messages per source, each at most 1,000 characters.
The entire snapshot remains limited to 64 KB. Do not include source bodies.

Collectors may separate known access and history limits into optional
`limitations` (up to ten strings, each at most 1,000 characters), retaining
request failures and unfinished work in `gaps`. Optional `chatScan` supplies
nonnegative `checked`, `available`, `excluded` and `pendingMessages` counts.
`available` excludes deliberately skipped chats; `checked` must not exceed it.
When all available chat lists have been checked, their queue is empty and no
gaps remain, the card shows a neutral "Available chats checked" status with
limits in a separate section. A partial collection remains partial and its
full-coverage checkpoint does not advance. Unknown failures must stay in gaps.
Legacy snapshots keep their existing display.

For a configured request limit, an optional `budgetPause` provides `usedThisRun`,
`perRun`, `usedLast24Hours`, `per24Hours`, nullable ISO UTC `resumesAt`, and optional
`deferredTasks` / `deferredDocuments`. At least one limit must be exhausted.
The card explains the planned pause and remaining scan work when no other gaps
remain. The resume timestamp is the earliest released request, not a promise
that the scan will finish then. Preserve other failures in `gaps` and historical
coverage as incomplete. These fields neither increase budgets nor trigger checks.

The Updates page displays these collection dates and gaps separately from
proposal analysis. The last complete collection checkpoint must only advance
when source collection confirms full coverage; a successful analysis of a
subset does not establish that coverage. These metadata do not change native
sync checkpoints or receipt validation. Without them, the page retains native
source reports. Analysis errors remain visible even when collection succeeds.

A newer successful analysis snapshot clears an earlier analysis failure when no
unfinished batches, attention batches or analysis errors remain. Unassigned
records may still be queued: the panel reports that queue and the next scheduled
run instead of retaining the resolved error. Collection failures, newer failures
and paused automations remain visible.

An unavailable source keeps an attention warning visible after successful
analysis and during subsequent checks. The warning includes the first reported
gap for each unavailable source; checks can continue for available sources.
Paused, failed and overdue checks still take precedence over this warning.

When `sourceUpdaterProjectId` and `sourceUpdaterAutomationId` are configured,
**Check for updates** runs that existing automation with its saved source and
model settings. It reuses an active run and passes an idempotency key on launch.
It does not open the built-in source composer or change the schedule. Native
`syncStart` requests are refused in this configuration, including from stale
browser tabs. Without an external updater configured, the built-in composer
remains available. Previous built-in runs remain in Check history.

The task list's search includes accepted ticket references, source URLs and
artifact labels, independently of the task title. References from pending or
rejected proposals do not affect search. This lets a task retain the original
source title even when the source's custom ticket ID differs from a number in
that title.

Tasks have an optional Customer field, independent of their title. Set it when
creating a task or edit it in the task overview; edits save automatically after a
short pause or when leaving the field. The task list shows the accepted customer
and supports filtering by customer or No customer, together with search and
priority. Source updates and conversation reviews propose customer changes in
the ordinary review inbox. Use explicit source fields or user instructions,
preserve manual choices, and leave unknown customers unspecified. Existing tasks
retain their data with an empty customer until edited or a proposal is accepted.

## File editor

The editor ships with 247C, including its syntax grammars and worker assets.
Do not install a separate editor plugin. On an upgraded machine that already
has `file-editor-save`, save open edits, update 247C, verify a synthetic text
file opens and saves with **247C File Editor**, then disable the old plugin.
If a client pinned the old opener, select **247C File Editor** in its file-opener
preference. **Show in folder** opens the file manager on the file’s host and
requires a desktop session there. Pinned paths remain installation-specific.
