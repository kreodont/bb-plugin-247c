#!/usr/bin/env python3
"""Explicit local BB retention policy. Preview by default; no model calls."""
import argparse
import contextlib
import fcntl
import hashlib
import json
import os
import re
import shutil
import sqlite3
import subprocess
import time
import uuid
from pathlib import Path

DAY = 86400
SNAPSHOT_COLUMNS = {'id', 'plugin_id', 'snapshot_path', 'database_path', 'status', 'created_at', 'updated_at', 'retained_until'}
# This policy owns expiry for its keepers, including when BB is offline for months.
PINNED_UNTIL = 253402300799000

def save(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temp = path.with_name(path.name + '.tmp')
    with temp.open('w') as stream:
        os.chmod(temp, 0o600)
        json.dump(value, stream, indent=2)
        stream.write('\n')
        stream.flush()
        os.fsync(stream.fileno())
    temp.replace(path)

def bb(config, *args):
    env = os.environ.copy()
    for key in ['BB_THREAD_ID', 'BB_PROJECT_ID', 'BB_ENVIRONMENT_ID']:
        env.pop(key, None)
    result = subprocess.run([config.get('bb', env.get('BB_CLI', 'bb')), *args], capture_output=True, text=True, timeout=120, env=env)
    if result.returncode:
        raise RuntimeError('BB maintenance request failed: ' + ' '.join(args[:3]))
    return json.loads(result.stdout)

def connect(path, writable=False, immutable=False):
    db = sqlite3.connect(Path(path).as_uri() + ('?mode=rw' if writable else '?mode=ro') + ('&immutable=1' if immutable else ''), uri=True, timeout=10)
    db.row_factory = sqlite3.Row
    db.execute('PRAGMA foreign_keys=ON')
    return db

def direct(path):
    path = Path(path)
    return path.is_absolute() and path.resolve() == path and not path.is_symlink()

def overlap(a, b):
    return a == b or a in b.parents or b in a.parents

def verify_database(path):
    if not direct(path) or not path.is_file() or Path(str(path) + '-wal').exists():
        return False
    try:
        # Native backups can retain a WAL-mode header without WAL files. They
        # are standalone immutable copies; validation must not create sidecars.
        with contextlib.closing(connect(path, immutable=True)) as db:
            names = {r[0] for r in db.execute("SELECT name FROM sqlite_schema WHERE type='table'")}
            return {'tasks', 'knowledge_files', '_bb_migrations'} <= names and db.execute('PRAGMA integrity_check').fetchall()[0][0] == 'ok' and not db.execute('PRAGMA foreign_key_check').fetchall()
    except (OSError, sqlite3.Error):
        return False

def file_hash(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()

def snapshot_rows(db, plugin):
    columns = {r[1] for r in db.execute('PRAGMA table_info(plugin_state_snapshots)')}
    if not SNAPSHOT_COLUMNS <= columns:
        raise RuntimeError('Unsupported BB snapshot schema; no snapshot cleanup was attempted')
    return [dict(r) for r in db.execute('SELECT * FROM plugin_state_snapshots WHERE plugin_id=? ORDER BY created_at DESC', (plugin,))]

def backup_plan(config):
    data = Path(config['dataDir'])
    with contextlib.closing(connect(data / 'bb.db')) as db:
        rows = snapshot_rows(db, config['pluginId'])
    if any(r['status'] in ['pending', 'rollback-pending', 'restoring'] for r in rows):
        return {'busy': True, 'keep': [], 'remove': [], 'rows': rows}
    root = data / 'plugins/snapshots' / config['pluginId']
    candidates = []
    for row in rows:
        folder = Path(row['snapshot_path'])
        path = Path(row['database_path']) if row['database_path'] else None
        if row['status'] != 'ready' or not path or folder.parent != root or path != folder / 'data.db' or not direct(folder):
            continue
        if not path.is_file():
            continue
        candidates.append({'path': str(path), 'kind': 'snapshot', 'row': row, 'created': row['created_at'] / 1000})
    for entry in config.get('manualBackups', []):
        path = Path(entry['path'])
        if not direct(path) or not path.is_file() or path == data / 'plugins' / config['pluginId'] / 'data.db':
            continue
        # Registered identities prevent an unrelated replacement being removed.
        stat = path.stat()
        if [stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns] != entry['identity']:
            continue
        candidates.append({'path': str(path), 'kind': 'manual', 'created': stat.st_mtime})
    candidates.sort(key=lambda x: (x['created'], x['kind'] == 'snapshot'), reverse=True)
    keep, hashes = [], set()
    verified = {}
    for candidate in candidates:
        path = Path(candidate['path'])
        valid = verify_database(path)
        verified[str(path)] = valid
        if not valid:
            continue
        digest = file_hash(path)
        if digest in hashes:
            continue
        hashes.add(digest)
        stat = path.stat()
        candidate['identity'] = [stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns]
        keep.append(candidate)
        if len(keep) == config.get('localBackupCount', 3):
            break
    # If verification fails, preserve everything, including the last known good copy.
    if len(keep) < config.get('localBackupCount', 3):
        return {'busy': False, 'keep': keep, 'remove': [], 'rows': rows, 'reason': 'Not enough verified recovery points'}
    kept = {c['path'] for c in keep}
    remove = []
    for candidate in candidates:
        if candidate['path'] in kept or verified.get(candidate['path']) is False or candidate['created'] > time.time() - 3600:
            continue
        path = Path(candidate['path'])
        stat = path.stat()
        candidate['identity'] = [stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns]
        candidate['bytes'] = stat.st_size
        remove.append(candidate)
    return {'busy': False, 'keep': keep, 'remove': remove, 'rows': rows}

def recover_journal(config):
    state = Path(config['stateDir'])
    journal = state / 'snapshot-journal.json'
    if not journal.exists():
        return
    actions = json.loads(journal.read_text())
    with contextlib.closing(connect(Path(config['dataDir']) / 'bb.db')) as db:
        for action in actions:
            original, trash = Path(action['original']), Path(action['trash'])
            expected = Path(config['dataDir']) / 'plugins/snapshots' / config['pluginId']
            if original.parent != expected or not direct(original.parent) or trash.parent != state / 'trash' or not direct(trash.parent):
                raise RuntimeError('Invalid snapshot recovery journal')
            exists = db.execute('SELECT 1 FROM plugin_state_snapshots WHERE id=?', (action['id'],)).fetchone()
            if exists and trash.exists() and not original.exists():
                trash.rename(original)
            elif not exists and trash.exists():
                shutil.rmtree(trash)
    journal.unlink()

def remove_backups(config, plan):
    if plan['busy'] or not plan['keep']:
        return 0
    jobs = bb(config, 'plugin', 'install-jobs', '--json').get('jobs', [])
    if any(j.get('status', j.get('state')) not in ['completed', 'succeeded', 'failed', 'cancelled', 'canceled'] for j in jobs):
        return 0
    for keeper in plan['keep']:
        path = Path(keeper['path'])
        s = path.stat()
        if not direct(path) or [s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns] != keeper['identity']:
            raise RuntimeError('A protected recovery point changed; cleanup was canceled')
    state = Path(config['stateDir'])
    (state / 'trash').mkdir(parents=True, exist_ok=True, mode=0o700)
    snapshots = [c for c in plan['remove'] if c['kind'] == 'snapshot']
    actions = [{'id': c['row']['id'], 'original': c['row']['snapshot_path'], 'trash': str(state / 'trash' / str(uuid.uuid4()))} for c in snapshots]
    removed = 0
    with contextlib.closing(connect(Path(config['dataDir']) / 'bb.db', writable=True)) as db:
        db.execute('BEGIN IMMEDIATE')
        if snapshot_rows(db, config['pluginId']) != plan['rows']:
            db.rollback()
            return 0
        save(state / 'snapshot-journal.json', actions)
        try:
            for keeper in plan['keep']:
                if keeper['kind'] == 'snapshot':
                    db.execute('UPDATE plugin_state_snapshots SET retained_until=?,updated_at=? WHERE id=? AND status=?',
                               (PINNED_UNTIL, int(time.time()*1000), keeper['row']['id'], 'ready'))
            for candidate, action in zip(snapshots, actions):
                path = Path(candidate['path'])
                s = path.stat()
                if [s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns] != candidate['identity']:
                    raise RuntimeError('Snapshot changed during cleanup')
                Path(action['original']).rename(action['trash'])
                deleted = db.execute('DELETE FROM plugin_state_snapshots WHERE id=? AND status=?', (action['id'], 'ready')).rowcount
                if deleted != 1:
                    raise RuntimeError('Snapshot registration changed during cleanup')
                removed += candidate['bytes']
            db.commit()
        except BaseException:
            db.rollback()
            recover_journal(config)
            raise
    recover_journal(config)
    for candidate in plan['remove']:
        if candidate['kind'] != 'manual':
            continue
        path = Path(candidate['path'])
        s = path.stat()
        if [s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns] == candidate['identity'] and direct(path):
            path.unlink()
            removed += candidate['bytes']
    return removed

def scratch_plan(config, plugins, now=None):
    now = now or time.time()
    protected = [Path(p['rootDir']).resolve() for p in plugins]
    processes = subprocess.check_output(['ps', '-axo', 'args='], text=True)
    cwd_result = subprocess.run(['lsof', '-a', '-u', str(os.getuid()), '-d', 'cwd', '-Fn'], capture_output=True, text=True, timeout=30)
    if cwd_result.returncode != 0:
        return []
    working_dirs = [Path(line[1:]) for line in cwd_result.stdout.splitlines() if line.startswith('n/')]
    candidates = []
    for item in config.get('scratch', []):
        root = Path(item['root'])
        if item.get('completedAt') is None or now - item['completedAt'] < 3 * DAY or not direct(root):
            continue
        if str(root) in processes or any(c == root or root in c.parents for c in working_dirs) or any(overlap(root, p) for p in protected):
            continue
        git = subprocess.run(['git', '-C', str(root), 'status', '--porcelain', '--untracked-files=normal'], capture_output=True, text=True)
        if git.returncode == 0 and git.stdout.strip():
            continue
        for name in ['node_modules', '.turbo', '.pytest_cache', '__pycache__']:
            path = root / name
            if not direct(path) or not path.is_dir():
                continue
            tracked = subprocess.run(['git', '-C', str(root), 'ls-files', '--', str(path)], capture_output=True, text=True)
            if tracked.returncode == 0 and tracked.stdout.strip():
                continue
            # Only registered build products expire, never source files or a checkout.
            candidates.append(str(path))
    return sorted(set(candidates))

def rotate_logs(config, apply, now=None):
    now = now or time.time()
    actions = []
    names = set(config.get('logs', []))
    rotations = set()
    for directory in config.get('logDirectories', []):
        root = Path(directory)
        if direct(root) and root.is_dir():
            names.update(str(p) for p in root.glob('*.log') if '.storage-' not in p.name)
            rotations.update(root.glob('*.log.storage-*.log'))
    for name in names:
        path = Path(name)
        if direct(path.parent):
            rotations.update(path.parent.glob(path.name + '.storage-*.log'))
    for old in sorted(rotations):
        if direct(old) and old.is_file() and old.stat().st_mtime < now - 14 * DAY:
            actions.append({'path': str(old), 'action': 'expire', 'bytes': old.stat().st_size})
            if apply:
                old.unlink()
    for name in sorted(names):
        path = Path(name)
        if not direct(path) or not path.is_file():
            continue
        stat = path.stat()
        if now - stat.st_mtime >= 14 * DAY:
            actions.append({'path': str(path), 'action': 'expire', 'bytes': stat.st_size})
            if apply:
                path.unlink()
            continue
        if not stat.st_size:
            continue
        limit = config.get('logMaxBytes', 10 * 1024**2)
        rotated = path.with_name(path.name + time.strftime('.storage-%Y-%m-%d.log', time.localtime(now)))
        if rotated.exists() and rotated.is_symlink():
            raise RuntimeError('Refusing a symlinked log rotation target')
        actions.append({'path': str(path), 'action': 'rotate', 'bytes': max(0, stat.st_size - limit)})
        if apply:
            # Keep a bounded diagnostic tail. Application logs are disposable;
            # source files and user artifacts are never log-rotation targets.
            with path.open('r+b') as stream:
                stream.seek(max(0, stat.st_size - limit))
                tail = stream.read(limit)
                if stat.st_size > limit:
                    tail = tail.split(b'\n', 1)[-1]
                previous = b''
                if rotated.exists():
                    with rotated.open('rb') as old:
                        old.seek(max(0, rotated.stat().st_size - limit))
                        previous = old.read(limit)
                with rotated.open('wb') as target:
                    os.chmod(rotated, 0o600)
                    target.write((previous + tail)[-limit:])
                    target.flush()
                    os.fsync(target.fileno())
                stream.seek(0)
                stream.truncate()
    return actions


def run(config, apply=False):
    state = Path(config['stateDir'])
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (state / 'lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if apply:
            recover_journal(config)
        plugins = bb(config, 'plugin', 'list', '--json')['plugins']
        backups = backup_plan(config)
        scratch = scratch_plan(config, plugins)
        request = state / 'source-retention-input.json'
        save(request, {'days': config.get('sourceDays', 14), 'apply': apply})
        source = bb(config, 'plugin', 'rpc', 'call', config['pluginId'], 'sourceRetention', '--input-file', str(request), '--json')
        report = {'at': time.time(), 'apply': apply, 'source': source, 'backups': backups, 'scratch': scratch,
                  'logs': rotate_logs(config, apply), 'backupBytesRemoved': 0}
        if apply:
            report['backupBytesRemoved'] = remove_backups(config, backups)
            # Recheck processes and installed roots immediately before deletion.
            safe_scratch = set(scratch_plan(config, bb(config, 'plugin', 'list', '--json')['plugins']))
            report['scratchRemoved'] = [name for name in scratch if name in safe_scratch]
            for name in report['scratchRemoved']:
                shutil.rmtree(name)
        stats = os.statvfs(config['dataDir'])
        report['freeBytes'] = stats.f_bavail * stats.f_frsize
        report['lowDisk'] = report['freeBytes'] < config.get('minimumFreeBytes', 20 * 1024**3)
        if apply:
            save(state / 'last-run.json', report)
            save(state / 'reports' / (time.strftime('%Y-%m-%d') + '.json'), report)
            for p in (state / 'reports').glob('*.json'):
                if p.stat().st_mtime < time.time() - 30 * DAY:
                    p.unlink()
            if report['lowDisk'] and os.uname().sysname == 'Darwin':
                message = f"Only {report['freeBytes']/1024**3:.1f} GB free. Protected files were preserved."
                script = 'display notification ' + json.dumps(message) + ' with title "BB storage"'
                subprocess.run(['osascript', '-e', script], check=True, timeout=15, capture_output=True)
        return report

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True)
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--quiet', action='store_true')
    parser.add_argument('--register', help='Register a completed temporary development workspace')
    parser.add_argument('--register-backup', help='Register a verified manual database backup for retention')
    parser.add_argument('--active', action='store_true', help='Mark a registered workspace in use until registered again')
    args = parser.parse_args()
    config = json.loads(Path(args.config).read_text())
    if config.get('version') != 1:
        raise ValueError('Unsupported maintenance configuration')
    if args.register and args.register_backup:
        raise ValueError('Register one item at a time')
    if args.register or args.register_backup:
        state = Path(config['stateDir'])
        state.mkdir(parents=True, exist_ok=True, mode=0o700)
        with (state / 'lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            config = json.loads(Path(args.config).read_text())
            register(config, args)
        return
    result = run(config, args.apply)
    if not args.quiet:
        print(json.dumps(result, indent=2))
    elif result['lowDisk']:
        print(json.dumps({'alert': 'Low disk space', 'freeGiB': round(result['freeBytes']/1024**3, 1)}))

def register(config, args):
    if args.register_backup:
        path = Path(args.register_backup).absolute()
        if path == Path(config['dataDir'])/'plugins'/config['pluginId']/'data.db' or not verify_database(path):
            raise ValueError('Register a verified standalone backup, never the live database')
        stat = path.stat()
        entries = [entry for entry in config.get('manualBackups', []) if entry['path'] != str(path)]
        entries.append({'path': str(path), 'identity': [stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns]})
        config['manualBackups'] = entries
        save(args.config, config)
        print(json.dumps({'registeredBackup': str(path)}))
    else:
        root = Path(args.register).absolute()
        if not direct(root) or not root.is_dir():
            raise ValueError('Register an existing absolute workspace without symlink ancestors')
        scratch = [i for i in config.get('scratch', []) if i['root'] != str(root)]
        scratch.append({'root': str(root), 'completedAt': None if args.active else time.time()})
        config['scratch'] = scratch
        save(args.config, config)
        print(json.dumps({'registered': str(root), 'active': args.active}))

if __name__ == '__main__':
    main()
