#!/usr/bin/env python3
"""Verified OCW backup; restoration only creates a new directory and pauses execution."""
import argparse
from contextlib import ExitStack
import io
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import sqlite3
import sys
import tarfile
import tempfile
import time
from uuid import uuid4
from ocw_runtime import Runtime, atomic, digest, encoded, identifier, stamp, syncdir

EXCLUDE = {'.git', '.snapshots', '.locks', 'node_modules', '__pycache__', '.DS_Store', 'playwright-report', 'test-results', '.playwright-cli'}
MAX_BYTES = 1024 * 1024 * 1024


def copy_artifact(source, target):
    # fcopyfile can deadlock or stall on macOS FileProvider files despite working
    # buffered reads. The archive contract preserves bytes/mode, not cloud xattrs.
    with source.open('rb') as reader, target.open('wb') as writer:
        shutil.copyfileobj(reader, writer, 1024 * 1024)
        writer.flush()
        os.fsync(writer.fileno())
    target.chmod(source.stat().st_mode & 0o777)


def files_under(root, exclusions=()):
    def excluded(path):
        relative = path.relative_to(root).as_posix()
        return any(relative == name or relative.startswith(name.rstrip('/') + '/') for name in exclusions)
    if root.is_file():
        if root.is_symlink():
            raise ValueError('backup does not follow symlinks')
        yield root.name, root
        return
    for directory, dirs, files in os.walk(root, followlinks=False):
        dirs[:] = [d for d in dirs if d not in EXCLUDE and not excluded(Path(directory) / d)]
        for name in dirs + files:
            path = Path(directory) / name
            if path.is_symlink():
                raise ValueError('backup refuses symlink: ' + str(path))
        for name in files:
            if name in EXCLUDE or name.endswith('.log') or excluded(Path(directory) / name):
                continue
            path = Path(directory) / name
            yield path.relative_to(root).as_posix(), path


def create(config, destination):
    destination = Path(destination).expanduser().resolve()
    # A configured removable mount must exist; never silently write to the system
    # disk underneath an absent /Volumes/<disk> mount.
    mount = config.get('required_mount')
    if mount and (not os.path.ismount(mount) or not destination.is_relative_to(Path(mount).resolve())):
        raise ValueError('configured backup volume is not mounted')
    roots = config['items']
    names = [identifier(item['name']) for item in roots]
    if len(names) != len(set(names)):
        raise ValueError('duplicate backup item')
    destination.mkdir(parents=True, exist_ok=True, mode=0o700)
    started = stamp()
    manifest = {'schema': 'ocw-backup-1', 'createdAt': started, 'items': roots, 'files': {}, 'excluded': sorted(EXCLUDE), 'rpo': 'state committed before each item snapshot'}
    total = 0
    with tempfile.TemporaryDirectory(prefix='ocw-backup-') as temporary:
        staging = Path(temporary)
        for item in roots:
            source = Path(item['path']).expanduser().resolve()
            item['isFile'] = source.is_file()
            item['resolvedPath'] = str(source)
            item['expandedPath'] = str(Path(item['path']).expanduser().absolute())
            if not source.exists() or destination.is_relative_to(source):
                raise ValueError('missing source or recursive backup destination')
            target = staging / item['name']
            target.mkdir()
            with ExitStack() as stack:
                runtime = Runtime(source) if item.get('kind') == 'runtime' else None
                if runtime:
                    locked = stack.enter_context(runtime.transaction())
                    state = runtime.status_in(locked)
                    db = runtime.connect()
                    backup = sqlite3.connect(target / 'runtime.sqlite3')
                    try:
                        db.backup(backup)
                    finally:
                        backup.close()
                        db.close()
                    item['snapshotRevision'] = state['revision']
                    item['snapshotAt'] = stamp()
                    # Immutable deliveries can be restored without replaying work.
                    delivery = Path(state['plan']['delivery_dir'])
                    for operation in state['operations']:
                        request = json.loads(operation['request'])
                        if operation['state'] != 'confirmed' or request.get('kind') != 'file':
                            continue
                        file = delivery / request['filename']
                        if file.is_symlink() or digest(file.read_bytes()) != digest(request['content'].encode()):
                            raise ValueError('confirmed delivery is missing or changed')
                        (target / 'deliveries').mkdir(exist_ok=True)
                        copy_artifact(file, target / 'deliveries' / file.name)
                else:
                    # Fail on a concurrent mutation instead of saving an unverified mix.
                    entries = list(files_under(source, item.get('exclude', [])))
                    before = {name: (p.stat().st_mtime_ns, p.stat().st_size) for name, p in entries}
                    if total + sum(size for _, size in before.values()) > MAX_BYTES:
                        raise ValueError('backup exceeds 1 GiB scoped artifact limit')
                    for name, file in entries:
                        output = target / name
                        output.parent.mkdir(parents=True, exist_ok=True)
                        copy_artifact(file, output)
                    after = {name: (p.stat().st_mtime_ns, p.stat().st_size) for name, p in files_under(source, item.get('exclude', []))}
                    if before != after:
                        raise ValueError('source changed during backup; retry: ' + str(source))
            for name, file in files_under(target):
                data = file.read_bytes()
                total += len(data)
                if total > MAX_BYTES:
                    raise ValueError('backup exceeds 1 GiB scoped artifact limit')
                manifest['files'][item['name'] + '/' + name] = {'sha256': digest(data), 'size': len(data), 'mode': file.stat().st_mode & 0o777}
        manifest['finishedAt'] = stamp()
        archive_name = 'ocw-' + time.strftime('%Y%m%dT%H%M%SZ', time.gmtime()) + '-' + uuid4().hex[:8] + '.tar.gz'
        final = destination / archive_name
        temporary_archive = destination / ('.' + archive_name + '.tmp')
        try:
            temporary_archive.touch(mode=0o600, exist_ok=False)
            with tarfile.open(temporary_archive, 'w:gz', format=tarfile.PAX_FORMAT) as archive:
                for name in manifest['files']:
                    archive.add(staging / name, arcname=name, recursive=False)
                raw = encoded(manifest)
                info = tarfile.TarInfo('backup-manifest.json')
                info.size, info.mode = len(raw), 0o600
                archive.addfile(info, io.BytesIO(raw))
            with temporary_archive.open('rb') as stream:
                os.fsync(stream.fileno())
            verify(temporary_archive)
            os.replace(temporary_archive, final)
            syncdir(destination)
        finally:
            temporary_archive.unlink(missing_ok=True)
    return {'archive': str(final), 'sha256': digest(final.read_bytes()), 'bytes': final.stat().st_size, 'createdAt': started, 'finishedAt': stamp(), 'files': len(manifest['files'])}


def verify(path):
    with tarfile.open(path, 'r:gz') as archive:
        members = archive.getmembers()
        names = [m.name for m in members]
        if len(names) != len(set(names)) or len(members) > 100000 or sum(m.size for m in members) > MAX_BYTES:
            raise ValueError('duplicate entries or excessive archive size')
        for item in members:
            path = PurePosixPath(item.name)
            if not item.isfile() or path.is_absolute() or '..' in path.parts or str(path) != item.name:
                raise ValueError('unsafe archive entry')
        manifest = json.load(archive.extractfile('backup-manifest.json'))
        if manifest.get('schema') != 'ocw-backup-1' or set(names) != set(manifest['files']) | {'backup-manifest.json'}:
            raise ValueError('backup manifest mismatch')
        for name, expected in manifest['files'].items():
            data = archive.extractfile(name).read()
            if digest(data) != expected['sha256'] or len(data) != expected['size']:
                raise ValueError('backup digest mismatch: ' + name)
    return manifest


def restore(archive_path, destination):
    manifest = verify(archive_path)  # No destination mutations until all hashes pass.
    destination = Path(destination).expanduser().absolute()
    if destination.exists() or destination.is_symlink():
        raise ValueError('restore destination must not exist')
    destination.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix='.ocw-restore-', dir=destination.parent))
    mapping = {}
    for item in manifest['items']:
        target = destination / item['name']
        if item.get('isFile'):
            target /= Path(item['path']).name
        for original in (item.get('resolvedPath', item['path']), item.get('expandedPath', item['path'])):
            mapping[original] = str(target)
    def remap(value):
        if not isinstance(value, str):
            return value
        for before, after in sorted(mapping.items(), key=lambda item: -len(item[0])):
            if value == before or value.startswith(before + os.sep):
                return after + value[len(before):]
        return value
    try:
        with tarfile.open(archive_path, 'r:gz') as archive:
            for name, metadata in manifest['files'].items():
                target = staging / name
                target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                atomic(target, archive.extractfile(name).read())
                target.chmod(metadata['mode'] & 0o777)
        restored = []
        for item in manifest['items']:
            root = staging / item['name']
            marker = root / 'source-project'
            if marker.is_file():
                # A packaged UI must launch its restored source, not the old host.
                atomic(marker, (remap(marker.read_text().strip()) + '\n').encode())
            if item.get('kind') == 'runtime':
                runtime = Runtime(root)
                with runtime.transaction() as db:
                    if db.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                        raise ValueError('restored SQLite integrity check failed')
                    plan = json.loads(db.execute("SELECT value FROM meta WHERE key='plan'").fetchone()[0])
                    plan['delivery_dir'] = str(destination / item['name'] / 'deliveries')
                    for checkpoint in plan['checkpoints']:
                        checkpoint['cwd'] = remap(checkpoint['cwd'])
                        checkpoint['argv'] = [remap(s) for s in checkpoint['argv']]
                        if checkpoint.get('acceptance'):
                            checkpoint['acceptance']['argv'] = [remap(s) for s in checkpoint['acceptance']['argv']]
                        db.execute('UPDATE checkpoints SET spec=? WHERE id=?', (encoded(checkpoint).decode(), checkpoint['id']))
                    for path in plan.get('paths', []):
                        path['commands'] = {cid: [remap(s) for s in argv] for cid, argv in path.get('commands', {}).items()}
                    old_epoch = int(db.execute("SELECT value FROM meta WHERE key='data_epoch'").fetchone()[0])
                    new_epoch = max(old_epoch + 1, time.time_ns() // 1000000)
                    db.execute("UPDATE meta SET value=? WHERE key='plan'", (encoded(plan).decode(),))
                    db.execute("UPDATE meta SET value=? WHERE key='data_epoch'", (str(new_epoch),))
                    db.execute("INSERT OR REPLACE INTO meta VALUES('restore_hold','1')")
                    db.execute("INSERT OR REPLACE INTO meta VALUES('backup_status',?)", (encoded({'status': 'restored', 'archive': str(archive_path), 'finishedAt': stamp()}).decode(),))
                    db.execute("UPDATE attempts SET status='interrupted',ended=? WHERE status='running'", (stamp(),))
                    db.execute("UPDATE checkpoints SET status='pending',attempt=NULL,owner=NULL,expires=NULL,epoch=epoch+1 WHERE status='running'")
                    db.execute("UPDATE operations SET state='unknown' WHERE state='dispatching'")
                    runtime.event(db, 'backup_restored', {'archive': str(Path(archive_path).resolve()), 'previousDataEpoch': old_epoch, 'dataEpoch': new_epoch, 'execution': 'paused_pending_reconciliation'})
                runtime.publish()
                restored.append({'name': item['name'], 'dataEpoch': new_epoch, 'execution': 'paused'})
            if item.get('kind') == 'registry':
                for file in root.glob('*.json'):
                    record = json.loads(file.read_text())
                    record.update(sourceRoot=remap(record['sourceRoot']), lifecycle='closed', closedAt=stamp(),
                                  instanceId=str(uuid4()), heartbeatSeq=0, processId=None, processStartedAt=None,
                                  recordVersion=record.get('recordVersion', 0) + 1)
                    record['recoveryPaths'] = mapping
                    atomic(file, encoded(record))
        atomic(staging / 'RESTORE-REPORT.json', encoded({'archive': str(archive_path), 'restoredAt': stamp(), 'sourceMapping': mapping, 'runtimes': restored, 'execution': 'paused'}))
        # Claim the destination exclusively even if another process created it
        # after our preflight. Completion marker is moved last.
        destination.mkdir(mode=0o700, exist_ok=False)
        for child in staging.iterdir():
            if child.name != 'RESTORE-REPORT.json':
                os.rename(child, destination / child.name)
        os.rename(staging / 'RESTORE-REPORT.json', destination / 'RESTORE-REPORT.json')
        staging.rmdir()
        syncdir(destination)
        syncdir(destination.parent)
        return {'destination': str(destination), 'runtimes': restored, 'filesVerified': len(manifest['files'])}
    except BaseException:
        shutil.rmtree(staging, ignore_errors=True)
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['create', 'verify', 'restore'])
    parser.add_argument('--config')
    parser.add_argument('--archive')
    parser.add_argument('--destination')
    args = parser.parse_args()
    try:
        result = create(json.loads(Path(args.config).read_text()), args.destination) if args.command == 'create' else restore(args.archive, args.destination) if args.command == 'restore' else verify(args.archive)
        print(json.dumps(result, ensure_ascii=False))
    except (ValueError, OSError, KeyError, sqlite3.Error, tarfile.TarError) as error:
        print('OCW backup: ' + str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
