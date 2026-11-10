#!/usr/bin/env python3
"""247C snapshots. Python 3.11+, SQLite Online Backup API, no third-party packages.

The restore command only writes a NEW directory. It never replaces a running DB.
"""
import argparse
import concurrent.futures
import contextlib
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
MAX_ARCHIVE_BYTES = 16 * 1024**3
STREAM_BYTES = 1024**2
EXCLUDE = {"node_modules", ".git", ".verification", "__pycache__", "backups", "snapshots", "local", ".DS_Store"}
ACTIVE_SESSIONS = {"starting", "working", "collecting", "review_starting", "reviewing", "repair_starting"}


def digest(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def dump(path, value):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def readonly(path):
    return contextlib.closing(sqlite3.connect(Path(path).resolve().as_uri() + "?mode=ro", uri=True, timeout=10))


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

    with readonly(source) as src, contextlib.closing(sqlite3.connect(destination)) as dst, dst:
        src.backup(dst, pages=256, progress=progress, sleep=0.05)
        dst.execute("PRAGMA journal_mode=DELETE")
    return check_db(destination)


class BbReadError(RuntimeError):
    def __init__(self, message, code=None):
        super().__init__(message)
        self.code = code


def run_bb(binary, *args):
    env = os.environ.copy()
    # Read-only exports should not inherit agent/thread orchestration routing.
    for key in ["BB_THREAD_ID", "BB_ENVIRONMENT_ID", "BB_PROJECT_ID"]:
        env.pop(key, None)
    result = subprocess.run([binary, *args], capture_output=True, timeout=90, env=env)
    if result.returncode:
        try:
            code = json.loads(result.stdout).get("error", {}).get("code")
        except (ValueError, AttributeError):
            code = None
        raise BbReadError(f"bb {' '.join(args[:3])} failed (exit {result.returncode})", code)
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
            if name in EXCLUDE or name.startswith((".env", "pinned-files.local.json")) or ".private." in name or name.endswith((".db", ".sqlite", ".zip", ".pyc")) or ".db-" in name:
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


def related_thread_ids(db):
    ids = {r[0] for r in db.execute("SELECT thread_id FROM session_threads UNION SELECT thread_id FROM source_sync_runs WHERE thread_id IS NOT NULL")}
    if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_time_threads'").fetchone():
        ids.update(r[0] for r in db.execute("SELECT thread_id FROM agent_time_threads"))
    if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='backlog_runs'").fetchone():
        ids.update(r[0] for r in db.execute("SELECT thread_id FROM backlog_runs WHERE thread_id IS NOT NULL"))
    return sorted(ids)


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
        local_patch = Path(settings["localSettingsPatch"]) if settings.get("localSettingsPatch") else Path(data_dir) / "plugins/247c/local.patch.json"
        patch_bytes = local_patch.read_bytes() if local_patch.exists() else None
        if patch_bytes is not None:
            if len(patch_bytes) > 256 * 1024:
                raise RuntimeError("The local settings patch is too large to back up")
            # Preserve the exact local file, separately from effective BB settings.
            (root / "settings/247c.local.patch.json").write_bytes(patch_bytes)
        source_hashes = {str(p.relative_to(Path(plugin["rootDir"]))): digest(p) for p in source_files(Path(plugin["rootDir"]))}
        if any(digest(root / "plugins/247c" / name) != value for name, value in source_hashes.items()):
            raise RuntimeError("Plugin source changed during snapshot")
        with readonly(root / "database/data.db") as db:
            ids = related_thread_ids(db)
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
                if isinstance(e, BbReadError) and e.code == "thread_not_found":
                    return {"id": thread_id, "status": "deleted", "detail": "BB confirms this thread no longer exists. No live history was omitted."}
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
        if (local_patch.read_bytes() if local_patch.exists() else None) != patch_bytes:
            raise RuntimeError("The local settings patch changed during snapshot; retry")
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
        result = {"archive": str(destination / filename), "sha256": digest(archive), "bytes": archive.stat().st_size, "createdAt": manifest["createdAt"], "tables": counts, "threadsSaved": sum(h["status"] == "saved" for h in history), "threadsUnavailable": [h["id"] for h in history if h["status"] not in ("saved", "deleted")], "cloudUploadVerified": False}
        result["cloudUploadStatus"] = verify_drive_upload(destination / filename)
        result["cloudUploadVerified"] = result["cloudUploadStatus"]["verified"]
        dump(destination / f"latest-{machine}.json", result)
        return result


def verify_archive(path, extract_to=None):
    with zipfile.ZipFile(path) as archive:
        info = archive.infolist()
        names = [i.filename for i in info]
        if len(names) != len(set(names)) or len(names) > 100000 or sum(i.file_size for i in info) > MAX_ARCHIVE_BYTES:
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
        with tempfile.TemporaryDirectory(prefix="247c-verify-") as temp:
            db = Path(extract_to) / "database/data.db" if extract_to else Path(temp) / "data.db"
            for name, expected in manifest["members"].items():
                if archive.getinfo(name).file_size != expected["bytes"]:
                    raise ValueError("Checksum failed: " + name)
                target = Path(extract_to) / name if extract_to else db if name == "database/data.db" else None
                if target:
                    target.parent.mkdir(parents=True, exist_ok=True)
                checksum, size = hashlib.sha256(), 0
                with archive.open(name) as src, target.open("wb") if target else contextlib.nullcontext() as dst:
                    while chunk := src.read(STREAM_BYTES):
                        checksum.update(chunk)
                        size += len(chunk)
                        if dst:
                            dst.write(chunk)
                if size != expected["bytes"] or checksum.hexdigest() != expected["sha256"]:
                    raise ValueError("Checksum failed: " + name)
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
        message = "Restored from backup. Choose a workspace and start a new conversation; previous history is preserved in the archive."
        recovered = 0
        with contextlib.closing(sqlite3.connect(portable)) as db, db:
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
            if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='backlog_runs'").fetchone():
                for run_id, raw in db.execute("SELECT id,value_json FROM backlog_runs WHERE status IN ('starting','running')").fetchall():
                    value = json.loads(raw)
                    value.update(status="stopped", error=message)
                    db.execute("UPDATE backlog_runs SET status='stopped',value_json=? WHERE id=?", (json.dumps(value, ensure_ascii=False), run_id))
                db.execute("UPDATE backlog_items SET chats_json='{}'")
            db.commit()
        settings = json.loads((root / "settings/247c.json").read_text())
        settings["hourlyUpdates"] = False
        # Paths, project IDs and automation IDs belong to the original computer.
        # In particular, an old patch must not re-enable them on first activation.
        for key, value in {"threadProjectId": "", "localSettingsPatch": "",
                           "calendarReaderCommand": "[]", "sourceImportRoot": "",
                           "dayPlannerProjectId": "", "dayPlannerAutomationId": "",
                           "backlogProvider": "", "backlogModel": ""}.items():
            if key in settings:
                settings[key] = value
        dump(root / "settings/247c.for-restore.json", settings)
        # The original patch is evidence for recovery, not an instruction to
        # resume the old machine's project routing or schedules on a new host.
        dump(root / "settings/247c.local.patch.for-restore.json", {"format": "247c-local-settings-v1", "settings": {k: v for k, v in settings.items() if k != "localSettingsPatch"}})
        dump(root / "RESTORE-REPORT.json", {"verified": True, "pluginVersion": manifest["pluginVersion"], "sessionsPaused": recovered, "originalDatabase": "database/data.db", "preparedDatabase": "prepared-bb/plugins/247c/data.db", "scheduleEnabled": False, "requires": ["Install the included plugin code in a compatible BB.", "Disable 247C before copying the prepared DB into the NEW installation.", "Restore non-secret settings using settings/247c.for-restore.json.", "Log in to providers again and choose local workspaces.", "Run one manual source check before enabling hourlyUpdates."]})
        check_db(portable)
        os.rename(root, destination)
    return {"restoredTo": str(destination), "verified": True, "sessionsPaused": recovered}


def retention_candidates(destination, machine, now=None):
    """Keep seven daily, four older weekly, and three older monthly snapshots."""
    now = now or datetime.now(timezone.utc)
    prefix = f"247c-{machine}-"
    parsed = []
    for p in Path(destination).glob(prefix + "*.zip"):
        if p.is_symlink() or not p.is_file():
            continue
        try:
            when = datetime.strptime(p.name[len(prefix):-4], "%Y%m%dT%H%M%S%fZ").replace(tzinfo=timezone.utc)
        except ValueError:
            continue
        parsed.append((when, p))
    parsed.sort(reverse=True)
    kept = {p for when, p in parsed if when > now}
    remaining = [(when, p) for when, p in parsed if when <= now]
    for limit, key in [(7, lambda d: d.date()), (4, lambda d: d.isocalendar()[:2]), (3, lambda d: (d.year, d.month))]:
        selected = set()
        for when, path in remaining:
            bucket = key(when)
            if bucket not in selected and len(selected) < limit:
                selected.add(bucket)
                kept.add(path)
        if not selected:
            break
        oldest = min(selected)
        remaining = [(when, p) for when, p in remaining if key(when) < oldest]
    # Never delete the newest available archive, regardless of its age.
    if parsed:
        kept.add(parsed[0][1])
    return [p for _, p in parsed if p not in kept]


def retain(destination, machine):
    removed = 0
    for p in retention_candidates(destination, machine):
        p.unlink()
        removed += 1
    return removed


def retention_safe(result):
    if result.get("threadsUnavailable"):
        return False
    path = Path(result["archive"])
    is_drive = any(part.startswith("GoogleDrive-") for part in path.parts)
    return not is_drive or result.get("cloudUploadVerified") is True


def prune_verified(destination, machine):
    destination = Path(destination)
    marker = destination / f"latest-{machine}.json"
    last = json.loads(marker.read_text())
    archive = Path(last['archive'])
    if last.get('threadsUnavailable'):
        return {'retentionDeferred': 'The latest backup is incomplete'}
    if archive.parent != destination or archive.is_symlink() or not archive.name.startswith(f'247c-{machine}-') or archive.suffix != '.zip':
        raise ValueError('The backup marker does not identify a local recovery archive')
    if digest(archive) != last['sha256']:
        raise ValueError('The latest archive checksum changed; no backups were removed')
    verify_archive(archive)
    last['cloudUploadStatus'] = verify_drive_upload(archive)
    last['cloudUploadVerified'] = last['cloudUploadStatus']['verified']
    dump(marker, last)
    if not retention_safe(last):
        return {'retentionDeferred': 'Cloud upload has not been confirmed'}
    return {'expiredSnapshotsRemoved': retain(destination, machine)}


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    create = sub.add_parser("create")
    create.add_argument("--bb", default=shutil.which("bb") or "bb")
    create.add_argument("--data-dir", required=True)
    create.add_argument("--destination", required=True)
    create.add_argument("--machine", required=True)
    create.add_argument("--retention", action="store_true", help="Keep 7 daily, 4 weekly and 3 monthly snapshots after a verified complete backup")
    create.add_argument("--daily", action="store_true", help="Skip if this machine already has a successful snapshot today")
    create.add_argument("--timezone", default="UTC")
    verify = sub.add_parser("verify")
    verify.add_argument("archive")
    prune = sub.add_parser("prune", help="Retry retention after a complete archive has uploaded")
    prune.add_argument("--destination", required=True)
    prune.add_argument("--machine", required=True)
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
                    result = {"skipped": "A complete snapshot already exists for today"}
                    if args.retention:
                        last["cloudUploadVerified"] = verify_drive_upload(last["archive"])["verified"]
                        if retention_safe(last):
                            result["expiredSnapshotsRemoved"] = retain(args.destination, args.machine)
                        else:
                            result["retentionDeferred"] = "Cloud upload has not been confirmed"
                    print(json.dumps(result))
                    return
            result = create_snapshot(args.bb, args.data_dir, args.destination, args.machine)
            if args.retention:
                if retention_safe(result):
                    result["expiredSnapshotsRemoved"] = retain(args.destination, args.machine)
                else:
                    result["retentionDeferred"] = "A complete, uploaded snapshot is required"
        elif args.command == "prune":
            result = prune_verified(args.destination, args.machine)
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
