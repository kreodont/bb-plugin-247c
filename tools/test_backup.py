import contextlib
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch
import zipfile
import backup


class RecoveryTests(unittest.TestCase):
    def test_related_history_includes_measured_children_and_supports_older_databases(self):
        with contextlib.closing(sqlite3.connect(":memory:")) as db, db:
            db.executescript("CREATE TABLE session_threads(thread_id TEXT); CREATE TABLE source_sync_runs(thread_id TEXT); INSERT INTO session_threads VALUES('worker'); INSERT INTO source_sync_runs VALUES('analyst');")
            self.assertEqual(backup.related_thread_ids(db), ["analyst", "worker"])
            db.executescript("CREATE TABLE agent_time_threads(thread_id TEXT); INSERT INTO agent_time_threads VALUES('worker'),('hidden-child');")
            self.assertEqual(backup.related_thread_ids(db), ["analyst", "hidden-child", "worker"])
            db.executescript("CREATE TABLE backlog_runs(thread_id TEXT); INSERT INTO backlog_runs VALUES('backlog-review'),(NULL);")
            self.assertEqual(backup.related_thread_ids(db), ["analyst", "backlog-review", "hidden-child", "worker"])

    def test_restore_stops_backlog_runs_and_preserves_findings(self):
        self.db.executescript('''
          CREATE TABLE backlog_runs(id TEXT PRIMARY KEY,status TEXT,value_json TEXT);
          CREATE TABLE backlog_items(run_id TEXT,result_json TEXT,chats_json TEXT);
          INSERT INTO backlog_runs VALUES('run1','running','{"id":"run1","status":"running","checked":1}');
          INSERT INTO backlog_items VALUES('run1','{"finding":"ready"}','{"temporary":"chat copy"}');
        ''')
        self.db.commit()
        backup.restore_to_new(self.archive(), self.root / "backlog-restored")
        with backup.readonly(self.root / "backlog-restored/prepared-bb/plugins/247c/data.db") as db:
            self.assertEqual(db.execute("SELECT status FROM backlog_runs").fetchone()[0], "stopped")
            self.assertEqual(db.execute("SELECT result_json,chats_json FROM backlog_items").fetchone(), ('{"finding":"ready"}', '{}'))

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / "live.db"
        self.db = sqlite3.connect(self.source)
        self.addCleanup(self.db.close)
        self.db.executescript('''
          PRAGMA journal_mode=WAL;
          CREATE TABLE tasks(id TEXT PRIMARY KEY, title TEXT);
          CREATE TABLE knowledge_files(id TEXT PRIMARY KEY, value_json TEXT);
          CREATE TABLE session_transcripts(session_id TEXT PRIMARY KEY, value_json TEXT);
          CREATE TABLE _bb_migrations(id INTEGER PRIMARY KEY);
          CREATE TABLE sessions(id TEXT PRIMARY KEY,status TEXT,value_json TEXT);
          CREATE TABLE session_events(id TEXT,session_id TEXT,kind TEXT,detail TEXT,payload_json TEXT,created_at TEXT);
          CREATE TABLE source_sync_runs(id TEXT PRIMARY KEY,status TEXT,value_json TEXT);
          INSERT INTO tasks VALUES('task1','Data written into WAL');
          INSERT INTO sessions VALUES('session1','working','{"id":"session1","status":"working"}');
        ''')
        self.db.commit()

    def archive(self):
        root = self.root / "bundle"
        (root / "database").mkdir(parents=True)
        (root / "settings").mkdir()
        counts = backup.copy_database(self.source, root / "database/data.db")
        backup.dump(root / "settings/247c.json", {"hourlyUpdates": True, "threadProjectId": "proj_old_computer",
                    "localSettingsPatch": "/old/private/settings.patch.json",
                    "calendarReaderCommand": '["/old/private/calendar-reader"]',
                    "sourceImportRoot": "/old/private/collector", "dayPlannerProjectId": "proj_old",
                    "dayPlannerAutomationId": "auto_old"})
        manifest = {"format": backup.FORMAT, "pluginVersion": "test", "tables": counts,
                    "members": {str(p.relative_to(root)): {"sha256": backup.digest(p), "bytes": p.stat().st_size} for p in root.rglob("*") if p.is_file()}}
        backup.dump(root / "manifest.json", manifest)
        path = self.root / "snapshot.zip"
        with zipfile.ZipFile(path, "x") as z:
            for p in root.rglob("*"):
                if p.is_file():
                    z.write(p, p.relative_to(root))
        return path

    def test_live_wal_is_captured_and_checked(self):
        self.assertTrue(Path(str(self.source) + "-wal").exists())
        target = self.root / "copy.db"
        backup.copy_database(self.source, target)
        with backup.readonly(target) as db:
            self.assertEqual(db.execute("SELECT title FROM tasks").fetchone()[0], "Data written into WAL")
        self.assertFalse(Path(str(target) + "-wal").exists())

    def test_verification_streams_database_instead_of_loading_it_into_memory(self):
        archive = self.archive()
        original = zipfile.ZipFile.read
        def metadata_only(instance, name, *args, **kwargs):
            self.assertEqual(name, "manifest.json")
            return original(instance, name, *args, **kwargs)
        with patch.object(zipfile.ZipFile, "read", metadata_only):
            self.assertEqual(backup.verify_archive(archive)["pluginVersion"], "test")
            backup.restore_to_new(archive, self.root / "streamed")

    def test_archive_size_limit_is_checked_before_extraction(self):
        archive = self.archive()
        self.assertGreater(backup.MAX_ARCHIVE_BYTES, 2 * 1024**3)
        with patch.object(backup, "MAX_ARCHIVE_BYTES", 1):
            with self.assertRaisesRegex(ValueError, "excessive archive size"):
                backup.restore_to_new(archive, self.root / "too-large")
        self.assertFalse((self.root / "too-large").exists())

    def test_restore_preserves_tasks_and_original_and_pauses_execution(self):
        archive = self.archive()
        result = backup.restore_to_new(archive, self.root / "restored")
        self.assertEqual(result["sessionsPaused"], 1)
        with backup.readonly(self.root / "restored/prepared-bb/plugins/247c/data.db") as db:
            self.assertEqual(db.execute("SELECT * FROM tasks").fetchall(), self.db.execute("SELECT * FROM tasks").fetchall())
            self.assertEqual(db.execute("SELECT status FROM sessions").fetchone()[0], "blocked")
        with backup.readonly(self.root / "restored/database/data.db") as db:
            self.assertEqual(db.execute("SELECT status FROM sessions").fetchone()[0], "working")
        settings = json.loads((self.root / "restored/settings/247c.for-restore.json").read_text())
        self.assertFalse(settings["hourlyUpdates"])
        self.assertEqual(settings["threadProjectId"], "")
        patch = json.loads((self.root / "restored/settings/247c.local.patch.for-restore.json").read_text())
        self.assertEqual(patch["settings"], {k: v for k, v in settings.items() if k != "localSettingsPatch"})
        self.assertEqual(patch["format"], "247c-local-settings-v1")
        self.assertEqual(settings["localSettingsPatch"], "")
        self.assertEqual(settings["calendarReaderCommand"], "[]")
        self.assertEqual(settings["sourceImportRoot"], "")
        self.assertEqual(settings["dayPlannerProjectId"], "")
        self.assertEqual(settings["dayPlannerAutomationId"], "")
        original_settings = json.loads((self.root / "restored/settings/247c.json").read_text())
        self.assertEqual(original_settings["threadProjectId"], "proj_old_computer")
        self.assertEqual(self.db.execute("SELECT status FROM sessions").fetchone()[0], "working")

    def test_restore_refuses_an_existing_target(self):
        archive = self.archive()
        target = self.root / "occupied"
        target.mkdir()
        (target / "important").write_text("keep")
        with self.assertRaisesRegex(ValueError, "must not exist"):
            backup.restore_to_new(archive, target)
        self.assertEqual((target / "important").read_text(), "keep")

    def test_bad_checksum_rejects_restore_without_publishing_directory(self):
        original = self.archive()
        corrupt = self.root / "corrupt.zip"
        with zipfile.ZipFile(original) as src, zipfile.ZipFile(corrupt, "w") as dst:
            for name in src.namelist():
                dst.writestr(name, b"corrupt" if name == "database/data.db" else src.read(name))
        with self.assertRaisesRegex(ValueError, "Checksum failed"):
            backup.restore_to_new(corrupt, self.root / "bad-restore")
        self.assertFalse((self.root / "bad-restore").exists())

    def test_path_traversal_and_links_are_refused(self):
        path = self.root / "evil.zip"
        with zipfile.ZipFile(path, "w") as z:
            z.writestr("../escape", "no")
        with self.assertRaisesRegex(ValueError, "Unsafe"):
            backup.verify_archive(path)
        self.assertFalse((self.root.parent / "escape").exists())

    def test_sources_exclude_credentials_and_external_links(self):
        root = self.root / "plugin"
        root.mkdir()
        (root / "server.ts").write_text("export default {}")
        (root / ".env").write_text("DO_NOT_COPY=secret")
        (root / "settings.private.json").write_text("private")
        (root / "pinned-files.local.json").write_text("PRIVATE_PIN_REGISTRY")
        (root / "pinned-files.local.json.pending.tmp").write_text("PRIVATE_PIN_REGISTRY")
        (root / "outside.ts").symlink_to(self.source)
        self.assertEqual([p.name for p in backup.source_files(root)], ["server.ts"])


if __name__ == "__main__":
    unittest.main()
