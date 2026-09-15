# Local settings patches

Shared features belong in the plugin repository. Project IDs, model choices,
account configuration, trusted script paths and automation IDs belong to each
installation. Keep those values in a JSON patch outside the Git checkout so
updating the plugin cannot replace it.

Copy [the generic example](local-settings.example.json) to a private location,
replace the examples with local values, and register its absolute path:

```sh
bb plugin config 247c set localSettingsPatch /absolute/private/247c/settings.patch.json
bb plugin reload 247c
```

The patch format is `{ "version": 1, "settings": { ... } }`. Values use the same
types as BB settings. Settings that contain JSON, such as `composerDefaults` and
`calendarReaderCommand`, remain JSON strings. `null` unsets a stored value and
restores its descriptor default. Only listed keys are changed. The patch cannot
set `localSettingsPatch` itself.

Every plugin load reads this file and validates the entire update with BB before
persisting it. This includes restarts, reloads and `bb plugin update 247c`; the
path is itself a persistent BB setting. The plugin log records a content hash and
key count, without logging values. The file must be a regular file, at most
64 KiB, on the BB server's filesystem. On WSL, use its Linux or mounted path.

Edit the patch for changes that should persist across updates. GUI edits to a
key listed in the patch are temporary until the patch is changed too. Removing a
key stops overriding it; it does not erase its saved value. Clear the
`localSettingsPatch` setting to stop applying the file. Keep the file in a private
backup and keep credentials in their provider's credential storage.

A missing file, invalid JSON, unknown key or invalid setting rejects activation
with an error. Invalid patches do not partially update settings. Correct the file
or clear its path and reload. If a future plugin version removes a setting,
update the patch explicitly; incompatible values are never silently discarded.

The patch affects 247C settings only. BB project folders, provider profiles,
read-tool permissions and existing automation schedules live in their own
persistent BB/provider configuration. External collector scripts and planning
instructions must also stay outside the managed checkout. Reference them by
local paths or automation IDs; updating 247C does not replace these files or
create duplicate automations. Restore these dependencies separately when moving
to a different computer.
