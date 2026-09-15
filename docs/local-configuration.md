# Portable code and local configuration

The repository contains common features, fixes, schema migrations and generic setup guidance. Each installation keeps its own tasks, accounts, project routing and preferences outside Git.

247C stores a declarative settings patch at `<BB data directory>/plugins/247c/local.patch.json`, next to its database. This is separate from the installed code directory. On first load it captures effective BB plugin settings; each subsequent load validates and reapplies it **before** starting services or schedules. This includes reloads after `bb plugin update 247c`. There is no source diff to rebase or shell code to execute.

```sh
bb 247c local-patch --json
```

This reports the file location, setting names and whether they match BB, without printing private values. An unreadable, invalid or newer-format patch stops loading with an error and leaves the file unchanged. Repair it against the installed settings schema before retrying; an unknown setting is never silently discarded.

## Editing settings

Use the standard BB plugin settings or CLI. Every change is mirrored into the patch with an atomic file replacement and owner-only file permissions where supported:

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

- `timeZone` controls planning dates, midnight splits, calendar reads, UI dates and hourly slots. The previous planning zone remains the default for compatibility. Changing the zone affects future calculations; existing manual entries retain their saved dates.
- `updateStartHour` and `updateEndHour` are inclusive, in that zone. An end before the start covers an overnight window.
- `workProvider`/`workModel` and `syncProvider`/`syncModel` seed new native composers. Blank values leave selection to BB. Review discussions keep the previous worker selection. Hourly checks continue to reuse the last successful check's execution request, which is local database state.
- `excludedReviewModels` is a JSON array of exact provider/model pairs for account-specific availability restrictions. Model aliases, dated snapshots and context suffixes are normalized. An exclusion affects only its specified provider.

## Settings owned by BB and providers

The referenced project's folder and environment, morning-planner automation, provider logins and read-permission allowlists remain in their native **local** BB/provider configuration. Plugin updates do not replace them. Browser preferences also remain local. Do not turn these into source-code edits or copy one computer's IDs to another. The setup agent must inspect the target installation and configure them there; see [the setup guide](setup-agent.md).

## Backups and another computer

Snapshots include the exact local patch separately as `settings/247c.local.patch.json`, as well as effective BB settings. Recovery produces `settings/247c.local.patch.for-restore.json` with source scheduling paused and the old project ID cleared. It leaves the original patch for reference and does not automatically activate it on another computer. Configure local account access, paths and IDs before using the prepared patch.

For an independent new database, install common code, select the local BB project and configure that computer's settings. 247C creates its own local patch. Keep actual patches and backup archives out of Git, even in a private repository. Only generic examples belong here.
