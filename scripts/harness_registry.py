#!/usr/bin/env python3
"""Local OCW registry writer. OS locks serialize each identity, never the registry."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
from contextlib import contextmanager
from datetime import datetime, timezone
from uuid import uuid4

SCHEMA = 'ocw-harness-registration-1'
SAFE = re.compile(r'^[A-Za-z0-9._-]+$')

def now():
    return datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')

def load(path):
    return json.loads(path.read_text())

def identity(record):
    return (str(Path(record['sourceRoot']).resolve()), str(record['sessionId']), str(record['taskId']))

def key(parts):
    return 'harness-' + hashlib.sha256('\0'.join(parts).encode()).hexdigest()[:16]

def record_path(root, rid):
    if not SAFE.fullmatch(rid) or rid in ('.', '..'):
        raise ValueError('invalid registration id')
    return root / (rid + '.json')

@contextmanager
def lock(root, name):
    locks = root / '.locks'
    locks.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (locks / (name + '.lock')).open('a+') as handle:
        os.fchmod(handle.fileno(), 0o600)
        fcntl.flock(handle, fcntl.LOCK_EX)
        yield

def atomic(path, record):
    descriptor, temporary = tempfile.mkstemp(prefix='.' + path.name, suffix='.tmp', dir=path.parent)
    try:
        with os.fdopen(descriptor, 'w') as handle:
            os.fchmod(handle.fileno(), 0o600)
            json.dump(record, handle, ensure_ascii=False, indent=2)
            handle.write('\n')
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)

def process_start(pid):
    if not pid:
        return None
    result = subprocess.run(['ps', '-p', str(pid), '-o', 'lstart='], capture_output=True, text=True, timeout=2)
    return result.stdout.strip() or None

def records(root):
    valid, errors = [], []
    for path in sorted(root.glob('*.json')):
        try:
            item = load(path)
            if item.get('schemaVersion') != SCHEMA:
                raise ValueError('unsupported registration schema')
            if record_path(root, item['registrationId']) != path:
                raise ValueError('registration filename mismatch')
            identity(item)
            valid.append(item)
        except (ValueError, KeyError, OSError, TypeError) as error:
            errors.append({'file': path.name, 'message': str(error)})
    return valid, errors

def register(args, root):
    source = Path(args.source).expanduser().resolve()
    canonical = source
    if (source / 'ocw-head.json').exists():
        head = load(source / 'ocw-head.json')
        if head.get('schema') != 'ocw-head-1' or not re.fullmatch(r'generations/[A-Za-z0-9-]+', head.get('generation', '')):
            raise ValueError('invalid executor head')
        canonical = (source / head['generation']).resolve()
        if not canonical.is_relative_to(source):
            raise ValueError('generation escapes source')
        raw = (canonical / 'manifest.json').read_bytes()
        if hashlib.sha256(raw).hexdigest() != head.get('sha256'):
            raise ValueError('generation manifest digest mismatch')
        manifest = json.loads(raw)
        if manifest.get('schema') != 'ocw-generation-1' or any(manifest.get(k) != head.get(k) for k in ('taskId', 'dataEpoch', 'revision')):
            raise ValueError('generation identity mismatch')
        for name, expected in manifest['files'].items():
            target = (canonical / name).resolve()
            if not target.is_relative_to(canonical) or hashlib.sha256(target.read_bytes()).hexdigest() != expected:
                raise ValueError('generation file digest mismatch')
    for name in ('state.json', 'events.jsonl', 'checkpoint-graph.json'):
        if not (canonical / name).is_file():
            raise ValueError('canonical source is missing ' + name + ': ' + str(source))
    state = load(canonical / 'state.json')
    if canonical != source and (state.get('task_id') != head['taskId'] or state.get('revision') != head['revision']):
        raise ValueError('generation state mismatch')
    if not state.get('task_id'):
        raise ValueError('state.json does not contain task_id')
    session = args.session or os.getenv('OCW_HARNESS_SESSION_ID') or os.getenv('CODEX_THREAD_ID') or os.getenv('CODEX_SESSION_ID') or 'default'
    parts = (str(source), session, str(state['task_id']))
    with lock(root, key(parts)):
        matches = [r for r in records(root)[0] if identity(r) == parts]
        if len(matches) > 1:
            raise ValueError('duplicate identity: reconcile existing registrations before continuing')
        existing = matches[0] if matches else None
        rid = args.id or (existing or {}).get('registrationId') or key(parts)
        path = record_path(root, rid)
        with lock(root, 'record-' + rid):
            if path.exists():
                existing = load(path)
                if identity(existing) != parts:
                    raise ValueError('registration identity conflict')
            existing = existing or {}
            if existing.get('lifecycle') == 'closed' and not args.new_instance:
                raise ValueError('closed registration requires --new-instance')
            if args.instance and existing.get('instanceId') and args.instance != existing['instanceId'] and not args.new_instance:
                raise ValueError('stale instance: use explicit --new-instance for a new run')
            new_run = args.new_instance or not existing.get('instanceId')
            instance = (args.instance or str(uuid4())) if new_run else existing['instanceId']
            pid = args.pid if args.pid is not None else (None if new_run else existing.get('processId'))
            if pid is not None and (not isinstance(pid, int) or pid <= 0):
                raise ValueError('process id must be positive')
            if not new_run and args.pid is not None and pid != existing.get('processId'):
                raise ValueError('process replacement requires --new-instance')
            started = process_start(pid) if new_run or args.pid is not None else existing.get('processStartedAt')
            if not new_run and existing.get('processStartedAt') and started != existing['processStartedAt']:
                raise ValueError('process identity changed; use --new-instance')
            stamp = now()
            record = dict(existing, schemaVersion=SCHEMA, registrationId=rid,
                taskId=parts[2], sourceRoot=parts[0], sessionId=session,
                label=args.label or existing.get('label') or parts[2], adapter='ocw-checkpoint-v1',
                lifecycle='registered', processId=pid, processStartedAt=started,
                registeredAt=existing.get('registeredAt') or stamp,
                heartbeatAt=stamp if new_run else existing.get('heartbeatAt', stamp), closedAt=None,
                instanceId=instance, heartbeatSeq=0 if new_run else existing.get('heartbeatSeq', 0),
                instanceStartedAt=stamp if new_run else existing.get('instanceStartedAt', stamp),
                recordVersion=existing.get('recordVersion', 0) + 1)
            atomic(path, record)
            return record

def update(args, root):
    path = record_path(root, args.id)
    initial = load(path)
    with lock(root, key(identity(initial))), lock(root, 'record-' + args.id):
        record = load(path)
        if record.get('schemaVersion') != SCHEMA or identity(record) != identity(initial):
            raise ValueError('registration identity changed')
        if not args.instance or args.instance != record.get('instanceId'):
            raise ValueError('missing or stale instance; retain instanceId from register')
        if record.get('lifecycle') == 'closed':
            if args.command == 'close':
                return record
            raise ValueError('closed instance cannot heartbeat or update')
        if args.command == 'heartbeat':
            if args.seq is None or args.seq <= record.get('heartbeatSeq', 0):
                raise ValueError('heartbeat sequence must strictly increase')
            changes = {'heartbeatAt': now(), 'heartbeatSeq': args.seq}
        elif args.command == 'close':
            changes = {'lifecycle': 'closed', 'closedAt': now()}
        else:
            changes = json.loads(args.updates)
            allowed = {'heartbeatAt', 'registeredAt', 'lifecycle', 'closedAt'}
            if set(changes) - allowed or changes.get('lifecycle', 'closed') != 'closed':
                raise ValueError('unsupported metadata update')
        record.update(changes)
        record['recordVersion'] = record.get('recordVersion', 0) + 1
        atomic(path, record)
        return record

def main():
    default = os.getenv('OCW_HARNESS_REGISTRY_DIR') or str(Path.home() / ('Library/Application Support/OCW Harness/registry' if sys.platform == 'darwin' else '.ocw-harness/registry'))
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['register', 'heartbeat', 'close', 'list', 'update'])
    parser.add_argument('--registry', default=default)
    parser.add_argument('--source')
    parser.add_argument('--session')
    parser.add_argument('--label')
    parser.add_argument('--id')
    parser.add_argument('--pid', type=int)
    parser.add_argument('--instance')
    parser.add_argument('--seq', type=int)
    parser.add_argument('--new-instance', action='store_true')
    parser.add_argument('--updates')
    args = parser.parse_args()
    root = Path(args.registry).expanduser().resolve()
    try:
        if args.command == 'list':
            items, errors = records(root)
            result = {'schemaVersion': 'ocw-harness-registry-1', 'registryDir': str(root), 'registrations': items, 'errors': errors}
        else:
            root.mkdir(parents=True, exist_ok=True, mode=0o700)
            root.chmod(0o700)
            result = register(args, root) if args.command == 'register' else update(args, root)
        print(json.dumps(result, ensure_ascii=False))
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as error:
        print('OCW registry: ' + str(error), file=sys.stderr)
        return 1
    return 0

if __name__ == '__main__':
    sys.exit(main())
