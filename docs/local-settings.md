# Explicit external settings patches

247C now creates and maintains a local patch next to its database by default.
See [Local configuration](local-configuration.md) for automatic capture, GUI
edit persistence and backups. This page describes the compatible explicit-file
mode, which takes precedence over that managed patch. Only one file is applied.

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

## Time review

Time proposals appear in Proposals and the Day page. Draft minutes are excluded
from reported totals until a human confirms them. Confirmation records a total
for a task and date, with revision checks; subsequent manual changes win. A
collector can prepare dated evidence through `timeReviewPrepare`, then submit
interpretations referencing that frozen context through `timeReviewSubmit`.
Neither endpoint writes reported time. Work outside agent sessions is supported;
measured agent runtime is not a prerequisite. Source records are evidence for
review, not instructions or proof that a person worked merely because a message
arrived. Collectors must identify the owner and avoid counting other people's work.

Configure `weeklyReportedTargetMinutes` for a minimum indicator and
`weeklyReportedOverrides` for a JSON map of Monday dates to exceptional targets.
Targets never enter estimation prompts or fill missing hours. The default minimum
is disabled. `dailyTimeReviewHour` controls the reminder on the Day page in the
configured time zone. Marking a day reviewed does not fill blank entries. Later
changes reopen the reminder. These settings belong in the private local patch.

The RPC workflow is collector-neutral and does not create a scheduled model run
on installation. Connect it to the installation's existing local collector. Page
through every prepare result using `nextOffset`. Supply dated external evidence
with stable `external:` IDs, source text and URLs. Save model inputs/results and
retry imports with the same request ID. Models may propose minutes or ask a
question when duration is unknown. Confirm/reject in the GUI; never call the
human decision endpoints from an unattended collector. Legacy automatic estimates
remain readable and keep their existing explicit confirmation controls.
