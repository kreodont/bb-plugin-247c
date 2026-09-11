# 247C backup and recovery

`tools/backup.py` requires Python 3.11+ and uses only the standard library. BB and 247C must be running to create a complete archive, and the `bb` CLI must be available. SQLite snapshots use the [Online Backup API](https://www.sqlite.org/backup.html), including committed WAL changes, rather than copying a live `data.db` file directly.

## Included data

- A consistent snapshot of the entire 247C database: tasks, fields, facts, proposals, approvals, knowledge, time journal, calendar and saved exports.
- Installed source code and build output, plus source code for related local provider plugins.
- Plugin settings excluding secret fields.
- Event exports for related BB threads, including open conversations, and text artifacts previously embedded in 247C.
- Versions, checksums, table counts and a standalone copy of `restore.py`.

The archive excludes OAuth logins, Keychain, other applications' data and arbitrary workspace files. Attachments and files merely linked from a chat require separate backups. Imported Markdown documents are already stored in full in the database. SQLite and BB history are captured sequentially at separate times.

## Create a backup

Find the data directory with `bb status --json`. The example assumes the standard `~/.bb` directory and an already connected Google Drive folder. Use a separate subfolder and `--machine` name for each independent installation.

```sh
python3 tools/backup.py create --data-dir "$HOME/.bb" \
  --destination "/path/to/Google Drive/247C/backups/my-mac" --machine my-mac
```

The archive is assembled and verified locally, then copied to the destination as one ZIP file with SHA-256 verification. The temporary destination file has a `.partial` suffix; its final name appears only after copying completes. The result is saved to `latest-<machine>.json`.

`--daily` avoids another successful backup on the same day, using Europe/Athens by default or the timezone supplied with `--timezone`. `--retention` keeps snapshots for 90 days: all snapshots, including manual extras, for the latest seven days, then the latest snapshot per day. Only archives matching this utility's filename format for the same machine are removed, after a successful new snapshot with all available history.

An OS scheduler can run the command daily. On macOS, use `python3 tools/schedule_macos.py --help` to prepare or install a LaunchAgent. The schedule uses the Mac's local time. Actual execution while the computer is asleep or powered off depends on the OS scheduler and Drive availability. Errors go to a separate log; a stale `latest` file means the latest backup needs checking.

Use the intended personal Google Drive account and a folder that is not shared. Archives contain personal and work text. Publish source code to GitHub separately; do not publish backups there. On macOS, the utility also checks Google Drive's File Provider upload status and records `cloudUploadVerified`. If status is unavailable or upload is pending, check Drive synchronization and the file's presence in the web interface. A local checksum alone does not prove cloud upload. You can also copy completed ZIP files to another medium for independence from Google.

## Verify and restore

```sh
python3 tools/backup.py verify /path/to/247c-snapshot.zip
python3 tools/backup.py restore /path/to/247c-snapshot.zip --destination /new/recovery-folder
```

If the original computer is lost, download the ZIP from Drive. It includes `restore.py`, which supports the same commands without the original installation. The recovery directory must not already exist. Verification checks every file, ZIP structure, SQLite integrity and foreign keys.

`database/data.db` preserves the original snapshot unchanged. `prepared-bb/plugins/247c/data.db` is prepared for a new installation: unfinished sessions are marked as requiring a new conversation, and active source checks are stopped. Tasks, facts, approvals and time remain unchanged. Automatic launch settings in `settings/247c.for-restore.json` are disabled until the first manual check. The prepared settings also clear `threadProjectId`, because project IDs belong to the original BB installation.

1. Install a compatible BB, required providers and the code in `plugins/247c`. For source installation, run `npm ci --include=dev`, then `bb plugin install .`.
2. On the new installation with an empty database, run `bb plugin disable 247c`. Confirm it is disabled with `bb plugin list`.
3. Copy the prepared database to `<dataDir>/plugins/247c/data.db`. Do not overwrite a running or populated installation; back up any existing data separately first.
4. Restore non-secret settings with `bb plugin config`, then run `bb plugin enable 247c`. Sign in to providers again and choose new local workspaces. To group 247C threads, configure **Thread project** with a project ID from this installation. Rebuild corporate source-read permissions in the target provider's local profile using the [setup-agent guide](setup-agent.md); provider profile permissions are not included in this backup.
5. Compare tasks, knowledge and the day plan with `manifest.json`. Old BB thread, host and environment IDs are historical references. Exported `threads/` files remain readable, but the former agent process cannot resume. Start a new conversation to continue work.
6. Check sources manually. Then enable `hourlyUpdates` if desired, and configure daily backups using the new computer's name.

`RESTORE-REPORT.json` lists prepared files and next actions. The recovery utility never changes a running BB or executes code from the archive.
