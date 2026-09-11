# Source configuration

The BB `sources` setting contains JSON following [sources.example.json](sources.example.json). Keep your completed configuration outside the repository. It configures searches and account identity; do not put tokens or passwords in it.

For corporate conversations, also follow the [setup-agent guide](setup-agent.md) to preauthorize source reads in the provider's local profile. These permissions are separate from the plugin's `sources` JSON and its approval workflow for task records. The repository contains the setup policy, not an installed permission allowlist.

The plugin reads the saved Claude login from `profilePath`: through Keychain on macOS, or the file created by Claude on other systems. Sign in to that profile with the standard Claude CLI and connect the required integrations. `expectedEmail` is required; the plugin verifies the account matches. Set `profilePath` explicitly to your configured profile; no personal profile path is bundled. Login refresh requires `claude` on the BB server's PATH.

`jiraSite` restricts reads to one Jira site. `jiraScope` is the JQL condition within the time interval. `slackChannels` lists channel names to search; `slackGroups` lists group chat IDs whose history should be read. `mailFilters` is appended to general email searches; unread inbox messages are checked separately. `analysisContext` explains the account owner's responsibilities to the analysis model and must not contain secrets. `calendarId` selects the calendar; `primary` resolves to `expectedEmail`.

Apply a local configuration file without shell interpolation:

```python
import json, subprocess
from pathlib import Path
profile = json.loads(Path("/path/to/sources.private.json").read_text())
subprocess.run(["bb", "plugin", "config", "247c", "set", "sources", json.dumps(profile)], check=True)
```

The setting is also available under Extensions → Plugins → 247C. Run a manual source check with an available model and workspace. You can then enable `hourlyUpdates`: daily 08:00–20:00 in Europe/Athens. `calendarMeetings` controls calendar import. Models and connected accounts remain subject to the selected provider's billing and limits.

Changing calendars does not modify earlier meetings from another calendar. An incorrect account or missing login preserves existing data and shows an error. Installing the code on another computer does not transfer this profile or synchronize databases.

Gmail permalinks can identify a message rather than its thread. The collector resolves message IDs from already loaded threads or with the read-only `get_message` metadata operation, then reads the full conversation once. Connector errors include the requested ID and the source's error text.

Jira link discovery excludes UUID fragments and bare `Q-…` quote numbers. An explicit Jira `/browse/Q-…` URL still identifies a Jira issue. Collection and coverage validation use the same reference rules; unavailable real issues continue to make the check partial.

Issue-shaped examples whose number consists entirely of zeros, such as `CASE-000000`, are excluded from link discovery, including in Jira URLs. Their original source text remains in the export. Positive issue numbers continue to be checked, and actual access errors still make the result partial.

The collector follows newly discovered links until the queue is exhausted, subject to the existing time, request and export-size limits. Linked issue chains are not cut off after a fixed number of hops. Hitting a limit or failing to read a real issue still preserves the previous source checkpoint.

## Missed update checks

Each check takes a complete snapshot of unreviewed source proposals, including pending new tasks, and rechecks their linked sources alongside open tasks. The analyst combines relevant new findings with all matching pending proposals from earlier checks. Unrelated requests remain separate; one unchanged proposal is kept without creating another approval.

A combined proposal preserves earlier facts, quotations and untouched proposed fields. Changed summaries and arrays describe the complete current result. Conflicting or stale field changes must be reconciled explicitly. Previous proposals become superseded history only after the combined result validates and is saved atomically with a new approval ID. Tasks still change only through human acceptance.

Concurrent acceptance, rejection or dossier edits block a stale replacement. Rejected findings are not revived by an unchanged replay. Old receipts may substantiate unchanged carried facts, but never count as fresh source coverage; unavailable sources still produce a partial result. Oversized analyses or combined proposals fail without removing the pending backlog.
