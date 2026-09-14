#!/usr/bin/env python3
"""Move an existing managed 247C installation to main, preserving local state."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

from backup import check_db, copy_code, copy_database, readonly

SOURCE = "git:https://github.com/kreodont/bb-plugin-247c.git@main"
URL = "https://github.com/kreodont/bb-plugin-247c.git"
CANONICAL = (
    "tasks", "task_facts", "task_projections", "planning", "kernel_events",
    "proposals", "proposal_evidence", "proposal_approvals", "application_receipts",
    "application_snapshots", "knowledge_entries", "knowledge_files",
    "session_transcripts", "session_threads", "session_updates", "day_configs",
)


def bb(binary, *args):
    result = subprocess.run([binary, *args], capture_output=True, text=True, timeout=900)
    if result.returncode:
        # Settings may contain private account context; never echo their values.
        if args[:3] == ("plugin", "config", "247c"):
            raise RuntimeError("Could not save or read 247C settings")
        raise RuntimeError(f"bb {' '.join(args[:3])} failed: {result.stderr.strip()[:2000]}")
    return json.loads(result.stdout) if result.stdout.strip() else None


def setting(binary, key, value):
    text = str(value).lower() if isinstance(value, bool) else str(value)
    return bb(binary, "plugin", "config", "247c", "set", key, text, "--json")


def installed(binary):
    return next((p for p in bb(binary, "plugin", "list", "--json")["plugins"] if p["id"] == "247c"), None)


def save(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")
    path.chmod(0o600)


def fingerprints(path):
    with readonly(path) as db:
        tables = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        return {name: hashlib.sha256(json.dumps(db.execute(f'SELECT * FROM "{name}" ORDER BY rowid').fetchall(),
                    ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()
                for name in CANONICAL if name in tables}


def assert_quiet(path):
    with readonly(path) as db:
        if db.execute("SELECT id FROM source_sync_runs WHERE status IN ('starting','working','collecting') LIMIT 1").fetchone():
            raise RuntimeError("A source check is active. Let it finish, then retry the upgrade.")
        if db.execute("SELECT id FROM sessions WHERE status IN ('starting','collecting','review_starting','reviewing','repair_starting') LIMIT 1").fetchone():
            raise RuntimeError("A session review is active. Let it finish, then retry the upgrade.")
        if any(json.loads(row[0]).get("status") == "running" for row in db.execute("SELECT value_json FROM calendar_sync_state")):
            raise RuntimeError("A calendar import is active. Let it finish, then retry the upgrade.")


def manual_plan(path):
    with readonly(path) as db:
        result = {}
        for row in db.execute("SELECT value_json FROM day_items"):
            item = json.loads(row[0])
            saved = {key: item.get(key) for key in ("date", "taskId", "step", "ordinal", "state", "removed", "carriedTo")}
            if item["plannedMode"] == "manual":
                saved["plannedMinutes"] = item["plannedMinutes"]
            if item["reportedMode"] == "manual":
                saved["reportedMinutes"] = item["reportedMinutes"]
                saved["reportedDate"] = item["reportedDate"]
            result[item["id"]] = saved
        return result


def upgrade(binary):
    plugin = installed(binary)
    if not plugin or plugin["status"] != "running":
        raise RuntimeError("247C must be installed and running before this upgrade.")
    source = bb(binary, "plugin", "source", "247c", "--json")
    if source["requested"] == SOURCE:
        print("This installation already tracks main. Use: bb plugin update 247c")
        return
    if not source["requested"].startswith("git:" + URL + "@"):
        raise RuntimeError("This utility handles managed Git installs from the 247C repository only.")
    status = bb(binary, "status", "--json")
    if not status.get("dataDir"):
        raise RuntimeError("BB did not return its data directory. Run this utility on the BB server's computer.")
    data_dir = Path(status["dataDir"]).resolve()
    database = data_dir / "plugins/247c/data.db"
    check_db(database)
    assert_quiet(database)
    config = bb(binary, "plugin", "config", "247c", "--json")
    if any(s.get("secret") or s.get("type") == "secret" for s in config["schema"].values()):
        raise RuntimeError("This installation declares secret settings and needs a separate migration.")
    secrets = database.parent / "secrets"
    if secrets.exists() and any(secrets.iterdir()):
        raise RuntimeError("This plugin has stored secrets and needs a separate migration.")
    # Resolve access before disabling anything. The installer repeats its own
    # source, engine and artifact validation when registering the new version.
    remote = subprocess.run(["git", "ls-remote", "--exit-code", URL, "refs/heads/main"],
                            capture_output=True, text=True, timeout=90, check=True)
    target = remote.stdout.split()[0]
    root = data_dir / "247c-upgrade-backups"
    root.mkdir(mode=0o700, exist_ok=True)
    backup = Path(tempfile.mkdtemp(prefix="before-main-", dir=root))
    values = config["values"]
    save(backup / "settings.json", values)
    save(backup / "source.json", source)
    save(backup / "target.json", {"source": SOURCE, "checkedCommit": target})
    copy_code(Path(plugin["rootDir"]), backup / "plugin")
    print(f"Backup: {backup}", flush=True)
    removed = False
    try:
        setting(binary, "hourlyUpdates", False)
        assert_quiet(database)
        bb(binary, "plugin", "disable", "247c", "--json")
        copy_database(database, backup / "data.db")
        before = fingerprints(backup / "data.db")
        plan_before = manual_plan(backup / "data.db")
        save(backup / "canonical-fingerprints.json", before)
        bb(binary, "plugin", "remove", "247c", "--json")
        removed = True
        # BB 0.42.1 preserves this database when removing a plugin. Refuse to
        # install against an empty replacement if another BB version differs.
        if not database.is_file() or fingerprints(database) != before or manual_plan(database) != plan_before:
            raise RuntimeError("The database changed during removal. Keep BB stopped for this plugin and recover from the backup before proceeding.")
        bb(binary, "plugin", "install", SOURCE, "--yes", "--json")
        current = installed(binary)
        if not current or current["status"] != "running":
            raise RuntimeError("The replacement plugin did not start. The backup is available for recovery.")
        # Restore the schedule switch last, after checking data and all other
        # settings. Provider plugins, accounts and BB conversations are untouched.
        for key, value in values.items():
            if key != "hourlyUpdates":
                setting(binary, key, value)
        check_db(database)
        after = fingerprints(database)
        if any(after.get(name) != digest for name, digest in before.items()) or manual_plan(database) != plan_before:
            raise RuntimeError("Canonical task data differs from the backup. Automatic source checks remain paused; inspect the backup before continuing.")
        setting(binary, "hourlyUpdates", values["hourlyUpdates"])
        restored = bb(binary, "plugin", "config", "247c", "--json")["values"]
        if any(restored.get(key) != value for key, value in values.items()):
            raise RuntimeError("Some settings differ from the backup.")
        active_source = bb(binary, "plugin", "source", "247c", "--json")
        if active_source["requested"] != SOURCE:
            raise RuntimeError("BB did not save the requested main branch source.")
        result = {"version": current["version"], "source": SOURCE, "backup": str(backup),
                  "databaseIntegrity": "ok", "canonicalTablesPreserved": len(before), "manualPlanPreserved": True, "settingsPreserved": True}
        save(backup / "upgrade-result.json", result)
        print(json.dumps(result, indent=2))
        print("Future updates: bb plugin update 247c")
    except BaseException:
        if not removed:
            # A failure before removal can safely restore the original runtime.
            try:
                bb(binary, "plugin", "enable", "247c", "--json")
                setting(binary, "hourlyUpdates", values["hourlyUpdates"])
            except Exception:
                pass
        print(f"Upgrade did not complete. Backup and original settings: {backup}", file=sys.stderr)
        print("The utility never overwrites or downgrades a migrated database. Keep this backup for recovery.", file=sys.stderr)
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bb", default=shutil.which("bb"), help="BB CLI executable; defaults to bb on PATH")
    args = parser.parse_args()
    if sys.version_info < (3, 11):
        parser.error("Python 3.11 or newer is required.")
    if not args.bb:
        parser.error("bb is not on PATH. Run this in the same Ubuntu/WSL environment as BB.")
    os.umask(0o077)
    try:
        upgrade(args.bb)
    except Exception as error:
        print(f"Error: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
