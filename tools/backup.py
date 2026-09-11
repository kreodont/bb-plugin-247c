#!/usr/bin/env python3
"""247C snapshots. Python 3.11+, SQLite Online Backup API, no third-party packages.

The restore command only writes a NEW directory. It never replaces a running DB.
"""
import argparse
import concurrent.futures
import hashlib
import json
import os
import re
from pathlib import Path, PurePosixPath
import shutil
import sqlite3
import stat
import subprocess
import sys
import tempfile
import time
import uuid
import zipfile
from datetime import datetime, timezone, timedelta
from zoneinfo import ZoneInfo

FORMAT = "247c-snapshot-1"
EXCLUDE = {"node_modules", ".git", ".verification", "__pycache__", "backups", "snapshots", "local", ".DS_Store"}
ACTIVE_SESSIONS = {"starting", "working", "collecting", "review_starting", "reviewing", "repair_starting"}


def digest(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def dump(path, value):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def readonly(path):
    return sqlite3.connect(Path(path).resolve().as_uri() + "?mode=ro", uri=True, timeout=10)


def check_db(path):
    with readonly(path) as db:
        if db.execute("PRAGMA integrity_check").fetchall() != [("ok",)]:
            raise RuntimeError("SQLite integrity check failed")
        if db.execute("PRAGMA foreign_key_check").fetchall():
            raise RuntimeError("SQLite foreign key check failed")
        names = [r[0] for r in db.execute("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'")]
        if not {"tasks", "session_transcripts", "knowledge_files", "_bb_migrations"}.issubset(names):
            raise RuntimeError("This is not a supported 247C database")
        return {name: db.execute('SELECT count(*) FROM "' + name.replace('"', '""') + '"').fetchone()[0] for name in names}


def copy_database(source, destination):
    start = time.monotonic()

    def progress(_status, _remaining, _total):
        if time.monotonic() - start > 120:
            raise TimeoutError("SQLite snapshot exceeded two minutes")

    with readonly(source) as src, sqlite3.connect(destination) as dst:
        src.backup(dst, pages=256, progress=progress, sleep=0.05)
        dst.execute("PRAGMA journal_mode=DELETE")
    return check_db(destination)


def run_bb(binary, *args):
    env = os.environ.copy()
    # Read-only exports should not inherit agent/thread orchestration routing.
    for key in ["BB_THREAD_ID", "BB_ENVIRONMENT_ID", "BB_PROJECT_ID"]:
        env.pop(key, None)
    result = subprocess.run([binary, *args], capture_output=True, timeout=90, env=env)
    if result.returncode:
        raise RuntimeError(f"bb {' '.join(args[:3])} failed (exit {result.returncode})")
    return json.loads(result.stdout)


def non_secret_settings(binary, plugin):
    result = run_bb(binary, "plugin", "config", plugin, "--json")
    schema = result["schema"]
    return {k: v for k, v in result["values"].items() if not schema.get(k, {}).get("secret") and schema.get(k, {}).get("type") != "secret"}


def source_files(root):
    for parent, dirs, files in os.walk(root, followlinks=False):
        dirs[:] = sorted(d for d in dirs if d not in EXCLUDE and not (Path(parent) / d).is_symlink())
        for name in sorted(files):
            p = Path(parent) / name
            if name in EXCLUDE or name.startswith(".env") or ".private." in name or name.endswith((".db", ".sqlite", ".zip", ".pyc")) or ".db-" in name:
                continue
            if p.is_symlink() or not p.is_file():
                continue
            yield p


def copy_code(root, destination):
    root = Path(root).resolve()
    for source in source_files(root):
        before = digest(source)
        target = destination / source.relative_to(root)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
        if digest(target) != before or digest(source) != before:
            raise RuntimeError("Plugin code changed while copying; retry the snapshot")


def verify_drive_upload(path):
    if sys.platform != "darwin" or not any(part.startswith("GoogleDrive-") for part in Path(path).parts):
        return {"verified": False, "source": "not-available"}
    for attempt in range(6):
        try:
            output = subprocess.run(["fileproviderctl", "evaluate", str(path)], capture_output=True, text=True, timeout=15)
            if output.returncode:
                return {"verified": False, "source": "macOS File Provider", "reason": "status-unavailable"}
            fields = {k: int(v) for k, v in re.findall(r"\b(isUploaded|isUploading|isExcludedFromSync|isShared) = ([01]);", output.stdout)}
            if fields.get("isUploaded") == 1 and fields.get("isUploading") == 0 and fields.get("isExcludedFromSync") == 0:
                return {"verified": True, "source": "macOS File Provider", **fields}
        except (OSError, subprocess.TimeoutExpired):
            return {"verified": False, "source": "macOS File Provider", "reason": "status-unavailable"}
        if attempt < 5:
            time.sleep(2)
    return {"verified": False, "source": "macOS File Provider", "reason": "upload-pending"}


def create_snapshot(binary, data_dir, destination, machine):
    destination = Path(destination).resolve()
    destination.mkdir(parents=True, exist_ok=True, mode=0o700)
    # A machine namespace avoids collisions when several independent installs use Drive.
    if not machine or any(c not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_" for c in machine):
        raise ValueError("Machine name must contain letters, digits, dash or underscore")
    plugins = run_bb(binary, "plugin", "list", "--json")["plugins"]
    plugin = next(p for p in plugins if p["id"] == "247c")
    if plugin["status"] != "running":
        raise RuntimeError("247C must be running to capture code, settings and related BB history")
    settings = non_secret_settings(binary, "247c")
    created = datetime.now(timezone.utc)
    filename = f"247c-{machine}-{created.strftime('%Y%m%dT%H%M%S%fZ')}.zip"
    with tempfile.TemporaryDirectory(prefix="247c-backup-") as temp:
        root = Path(temp) / "snapshot"
        (root / "database").mkdir(parents=True)
        counts = copy_database(Path(data_dir) / "plugins/247c/data.db", root / "database/data.db")
        copy_code(plugin["rootDir"], root / "plugins/247c")
        dump(root / "settings/247c.json", settings)
        source_hashes = {str(p.relative_to(Path(plugin["rootDir"]))): digest(p) for p in source_files(Path(plugin["rootDir"]))}
        if any(digest(root / "plugins/247c" / name) != value for name, value in source_hashes.items()):
            raise RuntimeError("Plugin source changed during snapshot")
        with readonly(root / "database/data.db") as db:
            ids = sorted({r[0] for r in db.execute("SELECT thread_id FROM session_threads UNION SELECT thread_id FROM source_sync_runs WHERE thread_id IS NOT NULL")})
            sessions = [json.loads(r[0]) for r in db.execute("SELECT value_json FROM sessions")]
            providers = {s.get(k) for s in sessions for k in ("workerProvider", "reviewerProvider")}
        companions = []
        for p in plugins:
            if p["id"] != "247c" and set(p.get("providerIds", [])) & providers and str(p.get("source", "")).startswith("path:"):
                copy_code(p["rootDir"], root / "plugins" / p["id"])
                dump(root / "settings" / f'{p["id"]}.json', non_secret_settings(binary, p["id"]))
                companions.append(p["id"])
        (root / "threads").mkdir()

        def export_thread(thread_id):
            # IDs come from the DB, but must still be safe as archive filenames.
            if not thread_id or any(c not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_" for c in thread_id):
                return {"id": thread_id, "status": "invalid-id"}
            try:
                events = run_bb(binary, "thread", "log", thread_id, "--all", "--json")
                dump(root / "threads" / f"{thread_id}.json", events)
                return {"id": thread_id, "status": "saved"}
            except Exception as e:
                return {"id": thread_id, "status": "unavailable", "error": str(e)}

        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            history = list(pool.map(export_thread, ids))
        artifacts = []
        for s in sessions:
            for i, a in enumerate(s.get("artifacts", [])):
                if isinstance(a.get("text"), str):
                    data = a["text"].encode("utf-8")
                    if hashlib.sha256(data).hexdigest() != a["sha256"]:
                        raise RuntimeError("Stored artifact checksum failed")
                    name = f"artifacts/{s['id']}/{i}.txt"
                    target = root / name
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(data)
                    artifacts.append({"member": name, "originalPath": a["path"], "sha256": a["sha256"]})
        if non_secret_settings(binary, "247c") != settings:
            raise RuntimeError("247C settings changed during snapshot; retry")
        shutil.copyfile(Path(__file__).resolve(), root / "restore.py")
        manifest = {"format": FORMAT, "createdAt": created.isoformat(), "machine": machine, "pluginVersion": plugin["version"], "bbVersion": subprocess.check_output([binary, "--version"], text=True, timeout=15).strip(), "tables": counts, "history": history, "artifacts": artifacts, "companionPlugins": companions,
                    "limits": ["OAuth credentials and provider logins are not included.", "BB history is an archival export, not resumable provider sessions.", "Files linked by chats are not included unless embedded in a 247C artifact.", "The SQLite snapshot and BB history have separate capture times."],
                    "members": {str(p.relative_to(root)): {"sha256": digest(p), "bytes": p.stat().st_size} for p in sorted(root.rglob("*")) if p.is_file()}}
        dump(root / "manifest.json", manifest)
        archive = Path(temp) / filename
        with zipfile.ZipFile(archive, "x", zipfile.ZIP_DEFLATED, compresslevel=6) as out:
            for p in sorted(root.rglob("*")):
                if p.is_file():
                    out.write(p, p.relative_to(root))
        verify_archive(archive)
        pending = destination / (filename + ".partial")
        try:
            with archive.open("rb") as src, pending.open("xb") as dst:
                shutil.copyfileobj(src, dst)
                dst.flush()
                os.fsync(dst.fileno())
            os.chmod(pending, 0o600)
            if digest(pending) != digest(archive):
                raise RuntimeError("Destination copy checksum failed")
            os.replace(pending, destination / filename)
        finally:
            pending.unlink(missing_ok=True)
        result = {"archive": str(destination / filename), "sha256": digest(archive), "bytes": archive.stat().st_size, "createdAt": manifest["createdAt"], "tables": counts, "threadsSaved": sum(h["status"] == "saved" for h in history), "threadsUnavailable": [h["id"] for h in history if h["status"] != "saved"], "cloudUploadVerified": False}
        result["cloudUploadStatus"] = verify_drive_upload(destination / filename)
        result["cloudUploadVerified"] = result["cloudUploadStatus"]["verified"]
        dump(destination / f"latest-{machine}.json", result)
        return result


def verify_archive(path, extract_to=None):
    with zipfile.ZipFile(path) as archive:
        info = archive.infolist()
        names = [i.filename for i in info]
        if len(names) != len(set(names)) or len(names) > 100000 or sum(i.file_size for i in info) > 2 * 1024**3:
            raise ValueError("Duplicate archive members or excessive archive size")
        for item in info:
            p = PurePosixPath(item.filename)
            if p.is_absolute() or any(part in (".", "..") for part in p.parts) or "\\" in item.filename or ":" in item.filename or item.is_dir() or stat.S_ISLNK(item.external_attr >> 16):
                raise ValueError("Unsafe archive path or link")
        if "manifest.json" not in names or archive.getinfo("manifest.json").file_size > 16 * 1024**2:
            raise ValueError("Missing or oversized snapshot manifest")
        manifest = json.loads(archive.read("manifest.json"))
        if manifest.get("format") != FORMAT or set(names) != set(manifest["members"]) | {"manifest.json"}:
            raise ValueError("Snapshot format or file inventory does not match")
        for name, expected in manifest["members"].items():
            data = archive.read(name)
            if len(data) != expected["bytes"] or hashlib.sha256(data).hexdigest() != expected["sha256"]:
                raise ValueError("Checksum failed: " + name)
            if extract_to:
                target = Path(extract_to) / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(data)
        with tempfile.TemporaryDirectory(prefix="247c-verify-") as temp:
            db = Path(temp) / "data.db"
            db.write_bytes(archive.read("database/data.db"))
            if check_db(db) != manifest["tables"]:
                raise ValueError("Restored database row counts differ from manifest")
        if extract_to:
            dump(Path(extract_to) / "manifest.json", manifest)
        return manifest


def restore_to_new(path, destination):
    destination = Path(destination).resolve()
    if destination.exists():
        raise ValueError("Restore destination must not exist; live databases are never overwritten")
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".247c-restore-", dir=destination.parent) as temp:
        root = Path(temp)
        manifest = verify_archive(path, root)
        portable = root / "prepared-bb/plugins/247c/data.db"
        portable.parent.mkdir(parents=True)
        shutil.copyfile(root / "database/data.db", portable)
        message = "Восстановлено из резервной копии. Выбери рабочую папку и начни новый разговор; прежняя история сохранена в архиве."
        recovered = 0
        with sqlite3.connect(portable) as db:
            for session_id, status, raw in db.execute("SELECT id,status,value_json FROM sessions").fetchall():
                if status in ACTIVE_SESSIONS:
                    value = json.loads(raw)
                    value.update(status="blocked", error=message, updatedAt=datetime.now(timezone.utc).isoformat())
                    db.execute("UPDATE sessions SET status='blocked',value_json=? WHERE id=?", (json.dumps(value, ensure_ascii=False), session_id))
                    db.execute("INSERT INTO session_events VALUES(?,?,?,?,?,?)", (str(uuid.uuid4()), session_id, "recovered", message, "{}", value["updatedAt"]))
                    recovered += 1
            for run_id, raw in db.execute("SELECT id,value_json FROM source_sync_runs WHERE status IN ('starting','working')").fetchall():
                value = json.loads(raw)
                value.update(status="blocked", error=message, finishedAt=datetime.now(timezone.utc).isoformat())
                db.execute("UPDATE source_sync_runs SET status='blocked',value_json=? WHERE id=?", (json.dumps(value, ensure_ascii=False), run_id))
            db.commit()
        settings = json.loads((root / "settings/247c.json").read_text())
        settings["hourlyUpdates"] = False
        dump(root / "settings/247c.for-restore.json", settings)
        dump(root / "RESTORE-REPORT.json", {"verified": True, "pluginVersion": manifest["pluginVersion"], "sessionsPaused": recovered, "originalDatabase": "database/data.db", "preparedDatabase": "prepared-bb/plugins/247c/data.db", "scheduleEnabled": False, "requires": ["Install the included plugin code in a compatible BB.", "Disable 247C before copying the prepared DB into the NEW installation.", "Restore non-secret settings using settings/247c.for-restore.json.", "Log in to providers again and choose local workspaces.", "Run one manual source check before enabling hourlyUpdates."]})
        check_db(portable)
        os.rename(root, destination)
    return {"restoredTo": str(destination), "verified": True, "sessionsPaused": recovered}


def retain(destination, machine, hourly_days=7, daily_days=90):
    """Keep manual snapshots for seven days, then one per day up to ninety days."""
    now = datetime.now(timezone.utc)
    daily = set()
    removed = 0
    prefix = f"247c-{machine}-"
    for p in sorted(Path(destination).glob(prefix + "*.zip"), reverse=True):
        try:
            when = datetime.strptime(p.name[len(prefix):-4], "%Y%m%dT%H%M%S%fZ").replace(tzinfo=timezone.utc)
        except ValueError:
            continue
        if now - when < timedelta(days=hourly_days):
            continue
        day = when.date()
        if now - when < timedelta(days=daily_days) and day not in daily:
            daily.add(day)
            continue
        p.unlink()
        removed += 1
    return removed


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    create = sub.add_parser("create")
    create.add_argument("--bb", default=shutil.which("bb") or "bb")
    create.add_argument("--data-dir", required=True)
    create.add_argument("--destination", required=True)
    create.add_argument("--machine", required=True)
    create.add_argument("--retention", action="store_true", help="Keep 90 days of daily snapshots after a successful creation")
    create.add_argument("--daily", action="store_true", help="Skip if this machine already has a successful snapshot today")
    create.add_argument("--timezone", default="Europe/Athens")
    verify = sub.add_parser("verify")
    verify.add_argument("archive")
    restore = sub.add_parser("restore")
    restore.add_argument("archive")
    restore.add_argument("--destination", required=True)
    args = parser.parse_args()
    try:
        if args.command == "create":
            marker = Path(args.destination) / f"latest-{args.machine}.json"
            if args.daily and marker.exists():
                last = json.loads(marker.read_text())
                zone = ZoneInfo(args.timezone)
                if datetime.fromisoformat(last["createdAt"]).astimezone(zone).date() == datetime.now(zone).date() and not last.get("threadsUnavailable") and Path(last["archive"]).is_file():
                    print(json.dumps({"skipped": "A complete snapshot already exists for today"}))
                    return
            result = create_snapshot(args.bb, args.data_dir, args.destination, args.machine)
            if args.retention and not result["threadsUnavailable"]:
                result["expiredSnapshotsRemoved"] = retain(args.destination, args.machine)
        elif args.command == "verify":
            m = verify_archive(args.archive)
            result = {"verified": True, "pluginVersion": m["pluginVersion"], "createdAt": m["createdAt"], "tables": m["tables"]}
        else:
            result = restore_to_new(args.archive, args.destination)
        print(json.dumps(result, ensure_ascii=False, indent=2))
    except Exception as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False), file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
