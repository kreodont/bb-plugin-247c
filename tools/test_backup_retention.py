import json
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch
from types import SimpleNamespace

import backup


class BackupRetentionTests(unittest.TestCase):
    def test_calendar_tiers_do_not_keep_duplicate_backups_on_one_day(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            now = datetime(2026, 10, 26, tzinfo=timezone.utc)
            files = []
            for age in range(180):
                for hour in [1, 2]:
                    when = now - timedelta(days=age, hours=hour)
                    p = root / ('247c-test-' + when.strftime('%Y%m%dT%H%M%S%fZ') + '.zip')
                    p.touch(); files.append(p)
            removed = backup.retention_candidates(root, 'test', now)
            kept = set(files) - set(removed)
            self.assertEqual(len(kept), 14)
            dates = [p.name[10:18] for p in kept]
            self.assertEqual(len(dates), len(set(dates)))
            self.assertIn(max(files), kept)
            self.assertTrue(all(p.exists() for p in removed))

    def test_newest_old_backup_future_files_and_other_machines_are_preserved(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for name in ['247c-test-20000101T000000000000Z.zip', '247c-test-20990101T000000000000Z.zip', '247c-other-20000101T000000000000Z.zip']:
                (root/name).touch()
            self.assertEqual(backup.retention_candidates(root, 'test'), [])

    def test_drive_retention_requires_a_complete_uploaded_backup(self):
        value = {'archive':'/home/user/GoogleDrive-personal/backups/a.zip','threadsUnavailable':[],'cloudUploadVerified':False}
        self.assertFalse(backup.retention_safe(value))
        value['cloudUploadVerified'] = True
        self.assertTrue(backup.retention_safe(value))
        value['threadsUnavailable'] = ['transient-failure']
        self.assertFalse(backup.retention_safe(value))

    def test_only_explicit_not_found_is_treated_as_a_deleted_thread(self):
        for code in ['thread_not_found', 'timeout', 'permission_denied']:
            output = json.dumps({'error':{'code':code}}).encode()
            with patch.object(backup.subprocess, 'run', return_value=SimpleNamespace(returncode=1, stdout=output)):
                with self.assertRaises(backup.BbReadError) as caught:
                    backup.run_bb('bb', 'thread', 'log', 'test')
                self.assertEqual(caught.exception.code, code)

    def test_delayed_drive_upload_is_verified_before_pruning(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)/'GoogleDrive-test'; root.mkdir()
            archive = root/'247c-test-20261026T000000000000Z.zip'; archive.write_bytes(b'test')
            marker = root/'latest-test.json'
            marker.write_text(json.dumps({'archive':str(archive),'sha256':backup.digest(archive),'threadsUnavailable':[]}))
            with patch.object(backup, 'verify_archive'), patch.object(backup, 'retain', return_value=2) as retain:
                with patch.object(backup, 'verify_drive_upload', return_value={'verified':False}):
                    self.assertIn('retentionDeferred', backup.prune_verified(root,'test'))
                    retain.assert_not_called()
                with patch.object(backup, 'verify_drive_upload', return_value={'verified':True}):
                    self.assertEqual(backup.prune_verified(root,'test'), {'expiredSnapshotsRemoved':2})
                archive.write_bytes(b'changed')
                with self.assertRaisesRegex(ValueError, 'checksum changed'):
                    backup.prune_verified(root,'test')


if __name__ == '__main__':
    unittest.main()
