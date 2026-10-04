import contextlib
import copy
import io
import json
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import upgrade


class UpgradeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.database = self.root / "plugins/247c/data.db"
        self.database.parent.mkdir(parents=True)
        self.code = self.root / "old-code"
        self.code.mkdir()
        (self.code / "server.ts").write_text("export default function plugin() {}")
        with contextlib.closing(sqlite3.connect(self.database)) as db, db:
            db.executescript('''
                CREATE TABLE tasks(id TEXT PRIMARY KEY,title TEXT);
                CREATE TABLE knowledge_files(id TEXT PRIMARY KEY,value_json TEXT);
                CREATE TABLE session_transcripts(id TEXT PRIMARY KEY,value_json TEXT);
                CREATE TABLE _bb_migrations(id INTEGER PRIMARY KEY);
                CREATE TABLE sessions(id TEXT PRIMARY KEY,status TEXT);
                CREATE TABLE source_sync_runs(id TEXT PRIMARY KEY,status TEXT);
                CREATE TABLE calendar_sync_state(value_json TEXT);
                CREATE TABLE day_items(value_json TEXT);
                INSERT INTO tasks VALUES('task','Keep this accepted task');
            ''')
            db.execute("INSERT INTO day_items VALUES(?)", (json.dumps({"id": "plan", "date": "2026-09-14", "taskId": "task", "step": "Keep this step", "ordinal": 1, "state": "open", "removed": False, "carriedTo": None, "plannedMode": "manual", "plannedMinutes": 35, "reportedMode": "manual", "reportedMinutes": 0, "reportedDate": "2026-09-14"}),))
        self.original = {"hourlyUpdates": True, "maximumRepairs": 1, "sources": "private fixture context"}
        self.values = dict(self.original)
        self.plugin = {"id": "247c", "status": "running", "version": "0.4.5", "rootDir": str(self.code)}
        self.source = "git:" + upgrade.URL + "@^0.4.5"
        self.calls = []
        self.install_failure = False
        self.change_data = False
        self.add_column = False

    def bb(self, _binary, *args):
        self.calls.append(args)
        if args[:2] == ("plugin", "list"):
            return {"plugins": [dict(self.plugin)] if self.plugin else []}
        if args[:2] == ("plugin", "source"):
            return {"requested": self.source}
        if args[0] == "status":
            return {"dataDir": str(self.root)}
        if args[:3] == ("plugin", "config", "247c"):
            if args[3] == "set":
                key, text = args[4:6]
                self.values[key] = json.loads(text) if not isinstance(self.original[key], str) else text
            return {"values": copy.deepcopy(self.values), "schema": {key: {"type": "string"} for key in self.original}}
        if args[:2] in (("plugin", "disable"), ("plugin", "enable")):
            self.plugin["status"] = "disabled" if args[1] == "disable" else "running"
            return self.plugin
        if args[:2] == ("plugin", "remove"):
            self.plugin = None
            self.values = {}
            return {"ok": True}
        if args[:2] == ("plugin", "install"):
            if self.install_failure:
                raise RuntimeError("Installation failed")
            self.plugin = {"id": "247c", "status": "running", "version": "0.5.2", "rootDir": str(self.code)}
            self.source = upgrade.SOURCE
            self.values = {"hourlyUpdates": False, "maximumRepairs": 2, "sources": "{}"}
            if self.change_data:
                with contextlib.closing(sqlite3.connect(self.database)) as db, db:
                    db.execute("UPDATE tasks SET title='Unexpected migration change'")
            if self.add_column:
                with contextlib.closing(sqlite3.connect(self.database)) as db, db:
                    db.execute("ALTER TABLE tasks ADD COLUMN customer TEXT")
            return self.plugin
        raise AssertionError(args)

    def run_upgrade(self):
        self.output = io.StringIO()
        remote = subprocess.CompletedProcess([], 0, "a" * 40 + "\trefs/heads/main\n", "")
        with patch.object(upgrade, "bb", self.bb), patch.object(upgrade.subprocess, "run", return_value=remote), contextlib.redirect_stdout(self.output), contextlib.redirect_stderr(self.output):
            upgrade.upgrade("bb")

    def backup(self):
        return next((self.root / "247c-upgrade-backups").iterdir())

    def test_keeps_database_manual_zero_and_local_settings(self):
        before = upgrade.fingerprints(self.database)
        plan = upgrade.manual_plan(self.database)
        self.run_upgrade()
        self.assertEqual(upgrade.fingerprints(self.database), before)
        self.assertEqual(upgrade.manual_plan(self.database), plan)
        self.assertEqual(self.values, self.original)
        self.assertEqual(upgrade.fingerprints(self.backup() / "data.db"), before)
        self.assertEqual(json.loads((self.backup() / "settings.json").read_text()), self.original)
        self.assertEqual((self.backup() / "settings.json").stat().st_mode & 0o777, 0o600)
        self.assertNotIn(self.original["sources"], self.output.getvalue())

    def test_refuses_active_review_before_any_change(self):
        with contextlib.closing(sqlite3.connect(self.database)) as db, db:
            db.execute("INSERT INTO sessions VALUES('review','reviewing')")
        with self.assertRaisesRegex(RuntimeError, "review is active"):
            self.run_upgrade()
        self.assertEqual(self.values, self.original)
        self.assertFalse(any(call[:2] == ("plugin", "remove") for call in self.calls))

    def test_verifies_existing_data_across_an_additive_migration(self):
        self.add_column = True
        columns = upgrade.canonical_columns(self.database)
        before = upgrade.fingerprints(self.database, columns)
        self.run_upgrade()
        self.assertEqual(upgrade.fingerprints(self.database, columns), before)
        self.assertEqual(self.values, self.original)

    def test_backup_failure_keeps_original_installation_enabled(self):
        with patch.object(upgrade, "copy_database", side_effect=OSError("Backup storage unavailable")):
            with self.assertRaisesRegex(OSError, "storage unavailable"):
                self.run_upgrade()
        self.assertEqual(self.plugin["status"], "running")
        self.assertEqual(self.values, self.original)
        self.assertFalse(any(call[:2] == ("plugin", "remove") for call in self.calls))

    def test_failed_install_preserves_database_and_recoverable_backup(self):
        before = upgrade.fingerprints(self.database)
        self.install_failure = True
        with self.assertRaisesRegex(RuntimeError, "Installation failed"):
            self.run_upgrade()
        self.assertEqual(upgrade.fingerprints(self.database), before)
        self.assertEqual(upgrade.fingerprints(self.backup() / "data.db"), before)
        self.assertEqual(json.loads((self.backup() / "settings.json").read_text()), self.original)
        self.assertIn("Upgrade did not complete", self.output.getvalue())

    def test_detects_changed_data_without_rolling_back_migrations(self):
        self.change_data = True
        with self.assertRaisesRegex(RuntimeError, "Canonical task data differs"):
            self.run_upgrade()
        self.assertFalse(self.values["hourlyUpdates"])
        with upgrade.readonly(self.database) as db:
            self.assertEqual(db.execute("SELECT title FROM tasks").fetchone()[0], "Unexpected migration change")
        with upgrade.readonly(self.backup() / "data.db") as db:
            self.assertEqual(db.execute("SELECT title FROM tasks").fetchone()[0], "Keep this accepted task")


if __name__ == "__main__":
    unittest.main()
