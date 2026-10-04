import contextlib
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import backup_installed


class InstalledBackupTests(unittest.TestCase):
    def test_each_run_resolves_the_current_release_and_preserves_arguments(self):
        with tempfile.TemporaryDirectory() as temp:
            for version in ("old", "new"):
                root = Path(temp) / version
                (root / "tools").mkdir(parents=True)
                script = root / "tools/backup.py"
                script.write_text("# fixture")
                inventory = {"plugins": [{"id": "247c", "rootDir": str(root)}]}
                with patch.object(backup_installed.subprocess, "run", side_effect=[
                    subprocess.CompletedProcess([], 0, json.dumps(inventory)),
                    subprocess.CompletedProcess([], 0),
                ]) as run:
                    self.assertEqual(backup_installed.main(["create", "--bb", "/tools/bb", "--destination", "/private/backup folder", "--daily"]), 0)
                    self.assertEqual(run.call_args_list[0].args[0], ["/tools/bb", "plugin", "list", "--json"])
                    self.assertEqual(run.call_args_list[1].args[0], [backup_installed.sys.executable, str(script), "create", "--destination", "/private/backup folder", "--daily", "--bb", "/tools/bb"])

    def test_missing_plugin_fails_without_running_an_old_copy(self):
        with patch.object(backup_installed.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, '{"plugins": []}')) as run, contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(backup_installed.main(["create"]), 1)
            self.assertEqual(run.call_count, 1)


if __name__ == "__main__":
    unittest.main()
