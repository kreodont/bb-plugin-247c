#!/usr/bin/env python3
"""Run the backup utility from the currently installed 247C release."""
import argparse
import json
from pathlib import Path
import shutil
import subprocess
import sys


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, add_help=False)
    parser.add_argument("--bb", default=shutil.which("bb") or "bb")
    args, remaining = parser.parse_known_args(argv)
    try:
        result = subprocess.run([args.bb, "plugin", "list", "--json"], check=True,
                                capture_output=True, text=True, timeout=30)
        plugin = next(p for p in json.loads(result.stdout)["plugins"] if p["id"] == "247c")
        script = Path(plugin["rootDir"]) / "tools/backup.py"
        if not script.is_file():
            raise RuntimeError("The installed release has no backup utility")
        return subprocess.run([sys.executable, str(script), *remaining, "--bb", args.bb]).returncode
    except (OSError, ValueError, KeyError, StopIteration, subprocess.SubprocessError, RuntimeError):
        print("Could not locate or run the installed 247C backup utility. Check BB and the plugin installation.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
