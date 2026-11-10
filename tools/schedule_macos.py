#!/usr/bin/env python3
"""Prepare or install a daily launchd job for this installation's 247C backup."""
import argparse
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--data-dir", required=True)
parser.add_argument("--destination", required=True)
parser.add_argument("--machine", required=True)
parser.add_argument("--hour", type=int, default=21)
parser.add_argument("--minute", type=int, default=0)
parser.add_argument("--timezone", default="UTC", help="Timezone for the daily duplicate guard; launchd uses the Mac's local time")
parser.add_argument("--bb", default=shutil.which("bb"))
parser.add_argument("--install", action="store_true", help="Without this flag print the job XML only")
args = parser.parse_args()
if sys.platform != "darwin" or not 0 <= args.hour <= 23 or not 0 <= args.minute <= 59 or not args.bb:
    parser.error("Requires macOS, a valid hour/minute and bb on PATH")
os.umask(0o077)
label = "com.247c.backup"
logs = Path(args.data_dir).resolve() / "backup-247c-logs"
launcher = Path(args.data_dir).resolve() / "247c-tools/backup_installed.py"
command = [sys.executable, str(launcher), "create", "--bb", args.bb,
           "--data-dir", str(Path(args.data_dir).resolve()), "--destination", str(Path(args.destination).resolve()),
           "--machine", args.machine, "--daily", "--timezone", args.timezone, "--retention"]
job = {"Label": label, "ProgramArguments": command, "StartCalendarInterval": {"Hour": args.hour, "Minute": args.minute},
       "RunAtLoad": True, "ProcessType": "Background", "StandardOutPath": str(logs / "stdout.log"), "StandardErrorPath": str(logs / "stderr.log"),
       "EnvironmentVariables": {"PATH": os.pathsep.join(dict.fromkeys([str(Path(args.bb).parent), str(Path(sys.executable).parent), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]))}}
data = plistlib.dumps(job)
if not args.install:
    sys.stdout.buffer.write(data)
else:
    launcher.parent.mkdir(parents=True, exist_ok=True)
    launcher_pending = launcher.with_suffix(".py.new")
    shutil.copyfile(Path(__file__).resolve().with_name("backup_installed.py"), launcher_pending)
    os.replace(launcher_pending, launcher)
    destination = Path.home() / "Library/LaunchAgents" / f"{label}.plist"
    destination.parent.mkdir(parents=True, exist_ok=True)
    logs.mkdir(parents=True, exist_ok=True)
    domain = f"gui/{os.getuid()}"
    loaded = subprocess.run(["launchctl", "print", f"{domain}/{label}"], capture_output=True).returncode == 0
    if loaded:
        subprocess.run(["launchctl", "bootout", f"{domain}/{label}"], check=True)
    pending = destination.with_suffix(".plist.new")
    pending.write_bytes(data)
    os.replace(pending, destination)
    subprocess.run(["launchctl", "bootstrap", domain, str(destination)], check=True)
    print(f"Installed {destination}; daily at {args.hour:02}:{args.minute:02} in the Mac's local timezone.")
