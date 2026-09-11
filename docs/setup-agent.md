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
