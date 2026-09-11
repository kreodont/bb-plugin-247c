# Source configuration

The BB `sources` setting contains JSON following [sources.example.json](sources.example.json). Keep your completed configuration outside the repository. It configures searches and account identity; do not put tokens or passwords in it.

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
