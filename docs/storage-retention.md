# Storage retention

Retention is opt-in and runs without a model. Conversations, uploaded attachments,
task dossiers, day plans, accepted facts and source links are not deleted.

## Source payloads

The `sourceRetention` RPC accepts `{ "days": 14, "apply": false }`. Preview is
read-only. Set `apply` to `true` only after approving the policy. Inspect it with
`bb plugin rpc inspect 247c sourceRetention`; call it through the BB CLI or SDK.

Only completed intervals older than the cutoff are eligible. Active checks,
unread intervals, pending proposals and their referenced exports, the latest
incremental analysis baseline, and the latest three exports are protected.
Cleanup pauses while a source check is active. Old full exports and frozen task
context are retired. Receipts cited by any saved proposal are retained, including
the data needed to recover Slack thread addresses. Check history records when its
full export expired; reports, errors, findings and citations remain available.
SQLite compaction waits until source checks, reviews and calendar imports finish.

## Recovery archives

`tools/backup.py create --retention` keeps seven daily recovery points, four older
weekly points, and three older monthly points. Multiple snapshots in the same
period do not consume extra slots. The newest archive is always retained.
Pruning follows a complete verified backup. Google Drive pruning additionally
requires confirmed upload through macOS File Provider. An unavailable connector,
permission error or transient thread export failure prevents pruning. A BB
`thread_not_found` result is recorded as an explicit deleted-thread tombstone;
it is not silently presented as saved history.
If an upload was still pending during backup creation, a later deterministic job
can run `tools/backup.py prune --destination /absolute/backups --machine NAME`.
It revalidates the latest archive and upload before removing older recovery points.

## Local maintenance (macOS and Linux)

`tools/storage_maintenance.py --config /absolute/private/policy.json` previews
the policy. `--apply` performs it; `--quiet` suppresses ordinary successful output.
The config stays outside the repository. It contains `version: 1`, `dataDir`,
`stateDir`, `pluginId`, optional `bb`, `sourceDays: 14`, `localBackupCount: 3`,
`minimumFreeBytes: 21474836480`, explicit `manualBackups`, `scratch`, and `logs`.
Do not use a cloud-synced state directory: snapshot quarantine needs atomic rename
on the same local filesystem as the BB database.

Native snapshot records and explicitly registered manual database copies share
three distinct verified recovery points. Recent snapshots have a one-hour safety
grace. A pending install or rollback, unknown schema, altered file identity, or
insufficient valid backups cancels snapshot cleanup. Native snapshot pruning uses
a SQLite write transaction and a recoverable rename journal so files and BB's
snapshot registry stay consistent. It never changes tasks, BB conversations,
plugin settings or credentials. It checks the actual schema each time, including
after BB upgrades. Kept native snapshots are pinned against BB's age-based GC;
this policy removes them only when newer verified recovery points replace them.

Manual backup entries require a path and `identity` containing device, inode,
size and nanosecond modification time. Only explicitly inventoried copies are
eligible. The live plugin database can never be a manual backup candidate.
Register a new manual copy with `--register-backup /absolute/backup.db`.

Register development work when it starts and finishes:

```sh
python3 tools/storage_maintenance.py --config /absolute/private/policy.json --register /absolute/workspace --active
python3 tools/storage_maintenance.py --config /absolute/private/policy.json --register /absolute/workspace
```

Three days after completion, only `node_modules`, `.turbo`, `.pytest_cache` and
`__pycache__` can be removed. Installed plugin roots, process working directories,
running commands and dirty Git workspaces are excluded. Source files and entire
checkouts never expire. A process-inspection failure skips dependency cleanup.

Explicit diagnostic logs rotate daily, retain at most 10 MiB per daily file, and
expire after 14 days. Cleanup reports contain paths, sizes and decisions, never
source content, and expire after 30 days. On macOS, less than 20 GiB free triggers
a local notification. Disk pressure never overrides protected data.

Schedule the tool as a daily BB script automation after the regular backup.
The launcher should resolve the tool from the currently installed 247C root,
so plugin and BB updates do not pin it to an obsolete cache directory. Keep
automatic thread archive/deletion disabled; this maintenance does not need it.

UX recording already retains raw events for seven days with a 16 MiB cap and
aggregate summaries for 90 days. Its recording state is not changed by cleanup.
