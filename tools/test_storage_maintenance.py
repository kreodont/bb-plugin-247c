import contextlib
import json
import os
import sqlite3
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch
from types import SimpleNamespace

import storage_maintenance as maintenance


class StorageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.config = {'dataDir': str(self.root), 'stateDir': str(self.root/'maintenance'), 'pluginId': '247c', 'localBackupCount': 3}
        (self.root/'maintenance').mkdir()
        with contextlib.closing(sqlite3.connect(self.root/'bb.db')) as db, db:
            db.execute('CREATE TABLE plugin_state_snapshots(id TEXT PRIMARY KEY,plugin_id TEXT,snapshot_path TEXT,database_path TEXT,status TEXT,created_at INTEGER,updated_at INTEGER,retained_until INTEGER)')

    def snapshot(self, n, status='ready'):
        folder = self.root/'plugins/snapshots/247c'/str(n)
        folder.mkdir(parents=True)
        path = folder/'data.db'
        with contextlib.closing(sqlite3.connect(path)) as db, db:
            db.executescript('CREATE TABLE tasks(id INTEGER); CREATE TABLE knowledge_files(id INTEGER); CREATE TABLE _bb_migrations(id INTEGER);')
            db.execute('INSERT INTO tasks VALUES(?)', (n,))
        created = int((time.time()-86400*(10-n))*1000)
        with contextlib.closing(sqlite3.connect(self.root/'bb.db')) as db, db:
            db.execute('INSERT INTO plugin_state_snapshots VALUES(?,?,?,?,?,?,?,?)', (str(n),'247c',str(folder),str(path),status,created,created,created+7*86400000))
        return path

    def test_preview_and_apply_keep_three_verified_recovery_points_and_consistent_records(self):
        for n in range(5): self.snapshot(n)
        plan = maintenance.backup_plan(self.config)
        self.assertEqual([c['row']['id'] for c in plan['keep']], ['4','3','2'])
        self.assertEqual(len(plan['remove']), 2)
        self.assertTrue(Path(plan['remove'][0]['path']).exists())
        with patch.object(maintenance, 'bb', return_value={'jobs': []}):
            self.assertGreater(maintenance.remove_backups(self.config, plan), 0)
        with contextlib.closing(sqlite3.connect(self.root/'bb.db')) as db, db:
            self.assertEqual(db.execute('SELECT count(*) FROM plugin_state_snapshots').fetchone()[0], 3)
            self.assertEqual(db.execute('SELECT min(retained_until) FROM plugin_state_snapshots').fetchone()[0], maintenance.PINNED_UNTIL)
        self.assertFalse(Path(plan['remove'][0]['path']).exists())
        self.assertFalse((self.root/'maintenance/snapshot-journal.json').exists())

    def test_last_good_copy_does_not_expire_even_without_three_recovery_points(self):
        self.snapshot(0)
        plan = maintenance.backup_plan(self.config)
        with patch.object(maintenance, 'bb', return_value={'jobs': []}):
            self.assertEqual(maintenance.remove_backups(self.config, plan), 0)
        with contextlib.closing(sqlite3.connect(self.root/'bb.db')) as db:
            self.assertEqual(db.execute('SELECT retained_until FROM plugin_state_snapshots').fetchone()[0], maintenance.PINNED_UNTIL)

    def test_standalone_wal_mode_snapshot_is_verified_without_sidecar_files(self):
        path = self.snapshot(0)
        with contextlib.closing(sqlite3.connect(path)) as db:
            db.execute('PRAGMA journal_mode=WAL')
        self.assertTrue(maintenance.verify_database(path))
        self.assertFalse(Path(str(path)+'-wal').exists())
        self.assertFalse(Path(str(path)+'-shm').exists())
        Path(str(path)+'-wal').touch()
        self.assertFalse(maintenance.verify_database(path))

    def test_changed_keeper_and_running_install_prevent_deletion(self):
        for n in range(4): self.snapshot(n)
        plan = maintenance.backup_plan(self.config)
        with patch.object(maintenance, 'bb', return_value={'jobs': [{'status':'running'}]}):
            self.assertEqual(maintenance.remove_backups(self.config, plan), 0)
        Path(plan['keep'][0]['path']).write_bytes(b'changed')
        with patch.object(maintenance, 'bb', return_value={'jobs': []}):
            with self.assertRaisesRegex(RuntimeError, 'protected recovery point changed'):
                maintenance.remove_backups(self.config, plan)
        self.assertTrue(Path(plan['remove'][0]['path']).exists())

    def test_rotated_logs_expire_without_their_original_and_daily_tail_is_bounded(self):
        logs = self.root/'logs'; logs.mkdir()
        old = logs/'missing.log.storage-2000-01-01.log'
        old.write_text('old'); os.utime(old, (0,0))
        live = logs/'server.log'; live.write_text('a'*100+'\n'+'b'*50)
        self.config.update(logDirectories=[str(logs)], logMaxBytes=64)
        maintenance.rotate_logs(self.config, False)
        self.assertTrue(old.exists()); self.assertGreater(live.stat().st_size, 64)
        maintenance.rotate_logs(self.config, True)
        self.assertFalse(old.exists()); self.assertEqual(live.stat().st_size, 0)
        rotated = next(logs.glob('server.log.storage-*'))
        self.assertLessEqual(rotated.stat().st_size, 64)
        live.write_text('c'*100)
        maintenance.rotate_logs(self.config, True)
        self.assertLessEqual(rotated.stat().st_size, 64)
        self.assertEqual(live.stat().st_size, 0)

    def test_incomplete_rollback_and_failed_verification_prevent_cleanup(self):
        for n in range(3): self.snapshot(n)
        self.snapshot(3, 'rollback-pending')
        self.assertTrue(maintenance.backup_plan(self.config)['busy'])
        with contextlib.closing(sqlite3.connect(self.root/'bb.db')) as db, db:
            db.execute("UPDATE plugin_state_snapshots SET status='ready'")
        self.snapshot(4).write_bytes(b'corrupt')
        self.assertNotIn('4', [c['row']['id'] for c in maintenance.backup_plan(self.config)['remove']])

    def test_concurrent_snapshot_change_aborts_before_any_removal(self):
        for n in range(4): self.snapshot(n)
        plan = maintenance.backup_plan(self.config)
        self.snapshot(5)
        with patch.object(maintenance, 'bb', return_value={'jobs': []}):
            self.assertEqual(maintenance.remove_backups(self.config, plan), 0)
        self.assertTrue(Path(plan['remove'][0]['path']).exists())

    def test_crash_recovery_restores_uncommitted_rename_and_removes_committed_trash(self):
        p = self.snapshot(0)
        original = p.parent
        trash = self.root/'maintenance/trash/item'
        trash.parent.mkdir()
        original.rename(trash)
        actions = [{'id':'0','original':str(original),'trash':str(trash)}]
        maintenance.save(self.root/'maintenance/snapshot-journal.json', actions)
        maintenance.recover_journal(self.config)
        self.assertTrue(p.exists())
        original.rename(trash)
        with contextlib.closing(sqlite3.connect(self.root/'bb.db')) as db, db:
            db.execute("DELETE FROM plugin_state_snapshots WHERE id='0'")
        maintenance.save(self.root/'maintenance/snapshot-journal.json', actions)
        maintenance.recover_journal(self.config)
        self.assertFalse(trash.exists())

    def test_registered_scratch_protects_live_plugins_recent_work_processes_and_source(self):
        root = self.root/'work'
        root.mkdir()
        (root/'node_modules').mkdir()
        (root/'source.ts').write_text('keep')
        self.config['scratch'] = [{'root':str(root),'completedAt':time.time()-4*86400}]
        real_run = maintenance.subprocess.run
        def fake_run(args, **kwargs):
            if args[0] == 'lsof': return SimpleNamespace(returncode=0, stdout='n/unrelated')
            return real_run(args, **kwargs)
        mock_run = patch.object(maintenance.subprocess, 'run', side_effect=fake_run)
        mock_run.start(); self.addCleanup(mock_run.stop)
        with patch.object(maintenance.subprocess, 'check_output', return_value=''):
            self.assertEqual(maintenance.scratch_plan(self.config, []), [str(root/'node_modules')])
            self.assertEqual(maintenance.scratch_plan(self.config, [{'rootDir':str(root)}]), [])
        with patch.object(maintenance.subprocess, 'check_output', return_value=f'node {root}/server.js'):
            self.assertEqual(maintenance.scratch_plan(self.config, []), [])
        self.config['scratch'][0]['completedAt'] = time.time()
        with patch.object(maintenance.subprocess, 'check_output', return_value=''):
            self.assertEqual(maintenance.scratch_plan(self.config, []), [])
        self.assertTrue((root/'source.ts').exists())


if __name__ == '__main__':
    unittest.main()
