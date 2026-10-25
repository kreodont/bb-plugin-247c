# Portable code and local configuration

The repository contains common features, fixes, schema migrations and generic setup guidance. Each installation keeps its own tasks, accounts, project routing and preferences outside Git.

247C stores a declarative settings patch at `<BB data directory>/plugins/247c/local.patch.json`, next to its database. This is separate from the installed code directory. On first load it captures effective BB plugin settings; each subsequent load validates and reapplies it **before** starting services or schedules. This includes reloads after `bb plugin update 247c`. There is no source diff to rebase or shell code to execute.

```sh
bb 247c local-patch --json
```

This reports the file location, setting names and whether they match BB, without printing private values. An unreadable, invalid or newer-format patch stops loading with an error and leaves the file unchanged. Repair it against the installed settings schema before retrying; an unknown setting is never silently discarded.

## Editing settings

Use the standard BB plugin settings or CLI. With the default managed patch, every change is mirrored into the patch with an atomic file replacement and owner-only file permissions where supported:

```sh
bb plugin config 247c set timeZone Europe/London
bb plugin config 247c set updateStartHour 9
bb plugin config 247c set updateEndHour 18
bb plugin config 247c set workProvider codex
bb plugin config 247c set workModel gpt-5.6-sol
```

You can also edit the JSON file directly, then run `bb plugin reload 247c`. While BB is running, unrelated changes made directly in the file are retained until reload. A patch has this shape; omitted fields use the installation's saved settings and are filled in on load:

```json
{
  "format": "247c-local-settings-v1",
  "settings": {
    "threadProjectId": "proj_example",
    "timeZone": "Europe/London",
    "updateStartHour": 9,
    "updateEndHour": 18,
    "hourlyUpdates": false,
    "workProvider": "codex",
    "workModel": "gpt-5.6-sol",
    "excludedReviewModels": "[]"
  }
}
```

The patch captures every declared plugin setting, including source account/profile references, watched channels, Jira scope, analysis instructions, calendar import, hourly checks, project ID, preferred work/check models, verification models and review limits. Source configuration and review exclusions retain their BB JSON-string representation. Do not add credentials; authentication stays in the provider's local credential store.

- `reportMeetingsWhenPlanned` fills automatic meeting reported time from planned time during import and planning, including upcoming meetings. The default is false (report after the meeting ends). Calendar duration changes and manual planned edits update automatic reported time; manual reported overrides always win. Cancelled or excluded meetings lose only their automatic hours. This preference is saved in the local patch.
- `timeZone` controls planning dates, midnight splits, calendar reads, UI dates and hourly slots. The previous planning zone remains the default for compatibility. Changing the zone affects future calculations; existing manual entries retain their saved dates.
- `updateStartHour` and `updateEndHour` are inclusive, in that zone. An end before the start covers an overnight window.
- `workProvider`/`workModel` and `syncProvider`/`syncModel` seed new native composers. Blank values leave selection to BB. Review discussions keep the previous worker selection. Hourly checks use nonblank `syncProvider`, `syncModel` and `syncReasoningLevel` settings on every launch. Unset fields, workspace and permissions are reused from the last successful check. Historical requests remain unchanged. For example, set `syncReasoningLevel` to `medium` to avoid inheriting a previous manual check's `max` setting. These choices are saved in the local patch and survive plugin updates.
- `excludedReviewModels` is a JSON array of exact provider/model pairs for account-specific availability restrictions. Model aliases, dated snapshots and context suffixes are normalized. An exclusion affects only its specified provider.

## Existing external patches

Installations already using `localSettingsPatch` keep their explicit external file as the only active patch. Its version-1 format and behavior remain supported: `{ "version": 1, "settings": { ... } }`. The plugin reads that file instead of creating or applying the managed patch. It does not rewrite a user-owned external file; GUI edits to listed keys remain temporary until the file is edited too. `null` restores a setting's descriptor default. Clear `localSettingsPatch` and reload to use the managed file again. See [external patch compatibility](local-settings.md).

The `composerDefaults` JSON setting provides a shared account/model choice for all native composers and takes precedence over the separate work/check defaults. External calendar readers, collector folders and existing day-planner IDs are also local settings; keep their scripts and automation definitions outside the managed checkout.

`threadInstructions` adds up to 1500 characters of installation-specific guidance
to all 247C work, review and source-check sessions, including older threads in
other projects. It also covers ordinary threads and forks in the configured
Thread project. Empty text adds nothing. The instructions supplement each role's
existing tool and output rules. Keep required machine formats and literal source
quotations intact when writing prose-style guidance. New provider sessions read
the current value; a running session retains its existing instructions until BB
constructs it again. The setting is saved in the active local patch like other
preferences, and the published default is empty.

`scopeAgentsToProject` limits 247C agent tools and their attached instructions to
the configured `threadProjectId` and conversations created by 247C, including
older workers, reviews and source analysts in other projects. Unrelated projects
receive no 247C agent tools or instructions. The panel and CLI remain available.
The default is false for compatibility. With the setting enabled and no project
selected, only 247C-created conversations receive the agent tools. This local
preference survives updates through the settings patch. BB applies it when the
provider session is next constructed; existing conversation text is not erased.

## Settings owned by BB and providers

Keep workspace-specific operating rules in `<workspace>/.bb/AGENTS.md`, rather
than the global `<BB data directory>/AGENTS.md`. BB loads that exact workspace
file for all providers; it does not search parent directories or use the project
name to locate it. Check the actual workspace of existing conversations before
moving instructions. Personal paths and account details belong only in local
files, outside the shared plugin repository.

**Pinned files** uses a separate local-settings store managed by
`local-settings.ts`: `<BB data directory>/plugins/247c/pinned-files.local.json`.
It contains only shortcut IDs, names, absolute paths and machine IDs. It is
atomically saved with owner-only permissions where supported. Updates preserve
it because installed code lives elsewhere. This store is deliberately separate
from `local.patch.json` and BB settings: neither the registry nor the files it
references are added to 247C backup/export payloads. Do not put file contents or
credentials in shortcut names. Adding and opening a shortcut never grants an
agent access to the file. BB's file preview and File Editor own file access.

Paths belong to the machine running BB. Windows installations accept native
Windows paths; WSL installations convert Windows paths with `wslpath -u` before
saving the shortcut. The stored Linux path is also passed to the file editor.
Custom drive mount locations are supported. If conversion fails, supply the
Linux path or check WSL's drive mount and `wslpath`; existing shortcuts stay
unchanged. No target-file access is needed to add a shortcut.

The referenced project's folder and environment, morning-planner automation, provider logins and read-permission allowlists remain in their native **local** BB/provider configuration. Plugin updates do not replace them. Browser preferences also remain local. Do not turn these into source-code edits or copy one computer's IDs to another. The setup agent must inspect the target installation and configure them there; see [the setup guide](setup-agent.md).

## Backups and another computer

Snapshots include the exact local patch separately as `settings/247c.local.patch.json`, as well as effective BB settings. Recovery produces `settings/247c.local.patch.for-restore.json` with source scheduling paused and the old project ID cleared. It leaves the original patch for reference and does not automatically activate it on another computer. Configure local account access, paths and IDs before using the prepared patch.

For an independent new database, install common code, select the local BB project and configure that computer's settings. 247C creates its own local patch. Keep actual patches and backup archives out of Git, even in a private repository. Only generic examples belong here.
