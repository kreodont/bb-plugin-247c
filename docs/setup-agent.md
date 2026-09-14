# Setup-agent guide

Use this guide when installing 247C on another computer or restoring an
installation. Each computer has an independent database. Configure source
connections using [Source configuration](sources.md); restore existing data only
when requested, using [Backup and recovery](recovery.md).

On Windows, follow [the WSL2 installation guide](windows.md). BB and the model
provider CLIs run inside the same Linux distribution.

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

## Automatic day-plan accounting

With `hourlyUpdates` enabled, each hourly check also reconciles the day plan with completed work in linked 247C task chats and their agents. Actual sums measured agent runtime; reported estimates are marked for user review and capped at 3 × actual. Existing manual values are preserved. On a fresh machine, tracking starts with that local day and its own BB history. See [Time journal rules](../skills/day-planning.md) for measurement boundaries, manual overrides and recovery behavior.

## Weekday morning planning

The optional BB agent automation uses [the weekday planning prompt](../automation-prompts/weekday-day-plan.md) to save a short day plan from accepted task context, current meetings and unfinished daily steps. It preserves existing entries and time values. It does not estimate manual hours or execute the planned work.

During an authorized setup, inspect `bb automation list --project <project-id>` first and update an existing planner instead of creating a duplicate. Schedule `30 7 * * 1-5` with timezone `Europe/Athens`. Choose an available provider/model on that computer; Codex Sol with medium reasoning is a suitable default. Use the local 247C project and a ready environment in its project folder, with permission mode `auto`. Omit `--target-thread` so each occurrence creates a separate conversation.

For example, run this from the repository after replacing the generic local IDs:

```python
from pathlib import Path
import subprocess

subprocess.run([
    "bb", "automation", "create", "--project", "proj_example",
    "--name", "247C weekday day plan",
    "--cron", "30 7 * * 1-5", "--timezone", "Europe/Athens",
    "--provider", "codex", "--model", "gpt-5.6-sol", "--reasoning", "medium",
    "--permission-mode", "auto", "--environment", "env_example",
    "--prompt", Path("automation-prompts/weekday-day-plan.md").read_text(),
    "--json",
], check=True)
```

Verify the saved timezone, next run, project, model and environment with `bb automation show <automation-id> --project <project-id> --json`. BB must be running for scheduled work to launch. BB stores a copy of the prompt; after editing the portable prompt, explicitly update the existing automation with `--prompt`. The automation and its local IDs belong to BB's private settings, not Git; configure it separately on each computer rather than copying another machine's IDs.

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
