#!/usr/bin/env python3
"""Fenced local checkpoint execution. SQLite owns facts; the console reads generations.

Commands marked replay_safe are trusted local work, not an OS sandbox. All guarded
delivery goes through the operation ledger. Never point init at a historical root.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager, nullcontext
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
from uuid import uuid4
from ocw_graph import encode as encoded, graph_plan, project_graph
from harness_registry import register, update


def stamp():
    return datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')


def digest(data):
    return hashlib.sha256(data).hexdigest()


def syncdir(path):
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def atomic(path, data):
    """Durable replace, used for a single authoritative head (never multi-file commits)."""
    fd, name = tempfile.mkstemp(prefix='.' + path.name, dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, path)
        syncdir(path.parent)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def identifier(value):
    if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,100}', value):
        raise ValueError('invalid checkpoint/task identifier')
    return value


def validate_plan(plan):
    identifier(plan['task_id'])
    items = plan['checkpoints']
    if not items or len(items) > 1000:
        raise ValueError('plan requires 1..1000 checkpoints')
    for item in items:
        if item.get('execution') != 'replay_safe':
            raise ValueError('commands require explicit execution=replay_safe; external actions use the ledger')
        if not item.get('argv') or not all(isinstance(s, str) and s for s in item['argv']):
            raise ValueError('argv must be a nonempty string array')
        if not Path(item['cwd']).is_dir():
            raise ValueError('command cwd is unavailable')
        if not 1 <= item.get('max_attempts', 3) <= 20 or not 0 < item.get('timeout_seconds', 300) <= 86400:
            raise ValueError('invalid command bounds')
    graph_plan(plan)
    if not Path(plan['delivery_dir']).is_absolute():
        raise ValueError('delivery_dir must be absolute')


def bounded_command(argv, *, cwd, env, timeout, limit, interval, error, lost=None):
    """Spool output to disk; stop the process group on timeout, overflow or lease loss."""
    with tempfile.TemporaryFile() as output:
        child = subprocess.Popen(argv, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                                 stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
        deadline = time.monotonic() + timeout
        while child.poll() is None:
            if (lost and lost.is_set()) or time.monotonic() >= deadline or output.tell() > limit:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait()
                raise ValueError(error)
            time.sleep(interval)
        output.seek(0)
        return child.returncode, output.read(limit + 1)


class Runtime:
    def __init__(self, root):
        self.root = Path(root).expanduser().resolve()
        if not (self.root / 'runtime.sqlite3').is_file():
            raise ValueError('not an initialized OCW executor root')

    @classmethod
    def initialize(cls, root, plan):
        validate_plan(plan)
        root = Path(root).expanduser().resolve()
        root.mkdir(mode=0o700, parents=True, exist_ok=False)
        db = sqlite3.connect(root / 'runtime.sqlite3')
        db.executescript('''
            PRAGMA journal_mode=WAL;
            PRAGMA synchronous=FULL;
            CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE checkpoints(id TEXT PRIMARY KEY, spec TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
                epoch INTEGER NOT NULL DEFAULT 0, attempt TEXT, owner TEXT, expires REAL, result TEXT);
            CREATE TABLE attempts(id TEXT PRIMARY KEY, checkpoint TEXT NOT NULL, epoch INTEGER NOT NULL,
                owner TEXT NOT NULL, started TEXT NOT NULL, ended TEXT, status TEXT NOT NULL, result TEXT);
            CREATE TABLE events(revision INTEGER PRIMARY KEY, body TEXT NOT NULL);
            CREATE TABLE operations(key TEXT PRIMARY KEY, checkpoint TEXT NOT NULL, request TEXT NOT NULL,
                state TEXT NOT NULL, receipt TEXT, updated TEXT NOT NULL);
        ''')
        with db:
            db.executemany('INSERT INTO meta VALUES(?,?)', [('plan', encoded(plan).decode()), ('data_epoch', '1')])
            db.executemany('INSERT INTO checkpoints(id,spec) VALUES(?,?)', [(c['id'], encoded(c).decode()) for c in plan['checkpoints']])
        db.close()
        runtime = cls(root)
        with runtime.transaction() as db:
            runtime.event(db, 'initialized', {'task_id': plan['task_id']})
        runtime.publish()
        return runtime

    def connect(self):
        db = sqlite3.connect(self.root / 'runtime.sqlite3', timeout=10)
        db.row_factory = sqlite3.Row
        db.execute('PRAGMA synchronous=FULL')
        db.execute('PRAGMA busy_timeout=10000')
        return db

    @contextmanager
    def transaction(self):
        db = self.connect()
        try:
            db.execute('BEGIN IMMEDIATE')
            yield db
            db.commit()
        except BaseException:
            db.rollback()
            raise
        finally:
            db.close()

    def event(self, db, kind, payload):
        revision = db.execute('SELECT COALESCE(MAX(revision),0)+1 FROM events').fetchone()[0]
        previous = db.execute('SELECT body FROM events ORDER BY revision DESC LIMIT 1').fetchone()
        states = [r[0] for r in db.execute('SELECT status FROM checkpoints')]
        hold = db.execute("SELECT 1 FROM meta WHERE key='restore_hold'").fetchone()
        phase = 'recovery_required' if hold else 'completed' if all(s == 'accepted' for s in states) else 'failed' if 'failed' in states and 'running' not in states else 'implementing'
        self.observe(db)
        event = {'event_id': f'EV-{revision}', 'type': kind, 'at': stamp(), 'payload': payload, 'actor': 'ocw-executor',
                 'from_revision': revision - 1, 'to_revision': revision,
                 'from_phase': json.loads(previous[0])['to_phase'] if previous else 'implementing', 'to_phase': phase}
        db.execute('INSERT INTO events VALUES(?,?)', (revision, encoded(event).decode()))

    def check(self, db, token):
        row = db.execute('SELECT * FROM checkpoints WHERE id=?', (token['checkpoint'],)).fetchone()
        if not row or row['status'] != 'running' or row['attempt'] != token['attempt'] or row['epoch'] != token['epoch'] or row['owner'] != token['owner'] or row['expires'] <= time.time():
            raise ValueError('fenced: missing, expired or superseded execution lease')
        return row

    def reap(self, db):
        for row in db.execute("SELECT * FROM checkpoints WHERE status='running' AND expires<=?", (time.time(),)).fetchall():
            db.execute("UPDATE attempts SET status='interrupted',ended=? WHERE id=?", (stamp(), row['attempt']))
            db.execute("UPDATE checkpoints SET status='pending',attempt=NULL,owner=NULL,expires=NULL WHERE id=?", (row['id'],))
            db.execute("UPDATE operations SET state='unknown',updated=? WHERE checkpoint=? AND state='dispatching'", (stamp(), row['id']))
            self.event(db, 'lease_expired', {'checkpoint': row['id'], 'attempt': row['attempt'], 'epoch': row['epoch']})

    def observe(self, db):
        db.execute("INSERT INTO meta VALUES('observation_seq','1') ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+1")

    def meta(self, db, key, fallback=None):
        row = db.execute('SELECT value FROM meta WHERE key=?', (key,)).fetchone()
        return json.loads(row[0]) if row else fallback

    def put_meta(self, db, key, value):
        db.execute('INSERT OR REPLACE INTO meta VALUES(?,?)', (key, encoded(value).decode()))

    def context(self, db, checkpoint):
        plan = self.meta(db, 'plan')
        model = graph_plan(plan)
        transition = model['incoming'][model['membership'][checkpoint]]
        selection = self.meta(db, 'selection:' + transition['id'], {'path_id': transition.get('initial_path_id'), 'revision': 1})
        path_id = (selection or {}).get('path_id')
        verdict = self.meta(db, 'path:' + str(path_id), {})
        dependencies = []
        for cid in model['dependencies'][checkpoint]:
            cp = db.execute('SELECT * FROM checkpoints WHERE id=?', (cid,)).fetchone()
            dependencies.append({'id': cid, 'accepted': cp['status'] == 'accepted', 'attempt': cp['attempt'], 'result_digest': digest((cp['result'] or '').encode())})
        identity = {'dependencies': dependencies, 'path_id': path_id, 'selection_revision': (selection or {}).get('revision'), 'path_revision': verdict.get('revision', 0)}
        spec = next(cp for cp in plan['checkpoints'] if cp['id'] == checkpoint)
        path = next((p for p in model['paths'] if p['id'] == path_id), {})
        identity['command_digest'] = digest(encoded(path.get('commands', {}).get(checkpoint, spec['argv'])))
        identity['oracle_version'] = spec.get('acceptance', {}).get('version')
        identity['input_generation'] = self.meta(db, 'input-generation:' + checkpoint, 0)
        return dict(identity, input_digest=digest(encoded(identity)), transition_id=transition['id'],
                    ready=all(d['accepted'] for d in dependencies) and bool(path_id) and verdict.get('verdict') not in ('refuted', 'invalidated'))

    def claim(self, owner, lease_seconds=30):
        token = self._claim(owner, lease_seconds)
        if token:
            self.publish()
        return token

    def _claim(self, owner, lease_seconds=30):
        if not owner or not 0.1 <= lease_seconds <= 300:
            raise ValueError('owner and bounded lease required')
        with self.transaction() as db:
            if db.execute("SELECT 1 FROM meta WHERE key='restore_hold'").fetchone():
                return None
            self.reap(db)
            rows = db.execute('SELECT * FROM checkpoints ORDER BY rowid').fetchall()
            for row in rows:
                if row['status'] != 'pending':
                    continue
                spec = json.loads(row['spec'])
                context = self.context(db, row['id'])
                if not context['ready']:
                    continue
                # The attempt budget is per input/decision generation. Retrying the
                # same inputs is bounded; a reviewed invalidation starts a new one.
                count = sum(self.meta(db, 'context:' + a['id'], {}).get('input_digest', context['input_digest']) == context['input_digest'] for a in db.execute('SELECT id FROM attempts WHERE checkpoint=?', (row['id'],)))
                if count >= spec.get('max_attempts', 3):
                    db.execute("UPDATE checkpoints SET status='failed' WHERE id=?", (row['id'],))
                    self.event(db, 'retry_exhausted', {'checkpoint': row['id']})
                    continue
                if db.execute("SELECT 1 FROM operations WHERE checkpoint=? AND state IN ('unknown','dispatching')", (row['id'],)).fetchone():
                    continue
                token = {'checkpoint': row['id'], 'attempt': str(uuid4()), 'epoch': row['epoch'] + 1, 'owner': owner}
                context['input_revision'] = db.execute('SELECT COUNT(*) FROM events').fetchone()[0]
                self.put_meta(db, 'context:' + token['attempt'], context)
                db.execute("UPDATE checkpoints SET status='running',epoch=?,attempt=?,owner=?,expires=? WHERE id=?",
                           (token['epoch'], token['attempt'], owner, time.time() + lease_seconds, row['id']))
                db.execute('INSERT INTO attempts VALUES(?,?,?,?,?,?,?,?)', (token['attempt'], row['id'], token['epoch'], owner, stamp(), None, 'running', None))
                self.event(db, 'claimed', dict(token, context=context))
                path = next(p for p in graph_plan(self.meta(db, 'plan'))['paths'] if p['id'] == context['path_id'])
                spec['argv'] = path.get('commands', {}).get(row['id'], spec['argv'])
                return dict(token, spec=spec, context=context)
        return None

    def heartbeat(self, token, lease_seconds=30):
        if not 0.1 <= lease_seconds <= 300:
            raise ValueError('invalid lease')
        with self.transaction() as db:
            self.check(db, token)
            db.execute('UPDATE checkpoints SET expires=? WHERE id=?', (time.time() + lease_seconds, token['checkpoint']))
            self.observe(db)
        self.publish()

    def evaluate_checkpoint(self, token, result):
        with self.transaction() as db:
            row = self.check(db, token)
            spec = json.loads(row['spec'])
            context = self.meta(db, 'context:' + token['attempt'], {})
        oracle = spec.get('acceptance')
        if not oracle:
            return result, True  # Historical v1 command/receipt contract.
        with tempfile.TemporaryDirectory(prefix='ocw-oracle-') as directory:
            input_file = Path(directory) / 'result.json'
            input_file.write_bytes(encoded({'result': result, 'context': context, 'checkpoint_id': token['checkpoint']}))
            exit_code, raw = bounded_command(oracle['argv'], cwd=spec['cwd'], env=dict(os.environ, OCW_RESULT_FILE=str(input_file)),
                                            timeout=oracle.get('timeout_seconds', 60), limit=1024 * 1024, interval=.05,
                                            error='acceptance timeout or output limit')
        if len(raw) > 1024 * 1024:
            raise ValueError('acceptance output exceeds limit')
        record = {'checkpoint_id': token['checkpoint'], 'attempt_id': token['attempt'], 'input_revision': context['input_revision'],
                  'input_digest': context['input_digest'], 'oracle_version': oracle['version'], 'evaluator': digest(encoded(oracle['argv'])),
                  'result_digest': digest(encoded(result)), 'verdict': 'pass' if exit_code == 0 else 'fail',
                  'exit_code': exit_code, 'output_digest': digest(raw), 'output': raw.decode('utf8', errors='replace')[:10000], 'evaluated_at': stamp()}
        return dict(result, acceptance=record), exit_code == 0

    def finish(self, token, result, success=True):
        if success:
            result, success = self.evaluate_checkpoint(token, result)
        with self.transaction() as db:
            self.check(db, token)
            original = self.meta(db, 'context:' + token['attempt'], {})
            current = self.context(db, token['checkpoint'])
            if original and (not current['ready'] or original['input_digest'] != current['input_digest']):
                raise ValueError('fenced: upstream evidence or selected path changed')
            if success and db.execute("SELECT 1 FROM operations WHERE checkpoint=? AND state!='confirmed'", (token['checkpoint'],)).fetchone():
                raise ValueError('unreconciled operation blocks checkpoint acceptance')
            status = 'accepted' if success else 'failed'
            db.execute('UPDATE attempts SET status=?,ended=?,result=? WHERE id=?', (status, stamp(), encoded(result).decode(), token['attempt']))
            db.execute('UPDATE checkpoints SET status=?,result=?,owner=NULL,expires=NULL WHERE id=?',
                       ('accepted' if success else 'pending', encoded(result).decode(), token['checkpoint']))
            self.event(db, 'checkpoint_' + status, {'checkpoint': token['checkpoint'], 'attempt': token['attempt'], 'result': result})
        self.publish()

    def invalidate(self, db, checkpoints, reason):
        model = graph_plan(self.meta(db, 'plan'))
        affected = set(checkpoints)
        while True:
            more = {cid for cid, deps in model['dependencies'].items() if set(deps) & affected} - affected
            if not more:
                break
            affected.update(more)
        for cid in sorted(affected):
            row = db.execute('SELECT * FROM checkpoints WHERE id=?', (cid,)).fetchone()
            self.put_meta(db, 'input-generation:' + cid, self.meta(db, 'input-generation:' + cid, 0) + 1)
            if row['status'] == 'running':
                db.execute("UPDATE attempts SET status='invalidated',ended=? WHERE id=?", (stamp(), row['attempt']))
            db.execute("UPDATE checkpoints SET status='pending',epoch=epoch+1,attempt=NULL,result=NULL,owner=NULL,expires=NULL WHERE id=?", (cid,))
            db.execute("UPDATE operations SET state='unknown',updated=? WHERE checkpoint=? AND state='dispatching'", (stamp(), cid))
        self.event(db, 'checkpoints_invalidated', {'checkpoint_ids': sorted(affected), 'reason': reason})

    def decide_path(self, path_id, *, actor, reason, expected_revision, verdict=None, adopt=False, evidence=None):
        if not actor or not reason or verdict not in (None, 'pending', 'supported', 'refuted', 'invalidated') or verdict and not isinstance(evidence, dict):
            raise ValueError('actor, reason and structured verdict evidence required')
        with self.transaction() as db:
            plan = self.meta(db, 'plan')
            model = graph_plan(plan)
            if not model['native']:
                raise ValueError('path decisions require an explicit v2 plan')
            if expected_revision != db.execute('SELECT COUNT(*) FROM events').fetchone()[0]:
                raise ValueError('stale decision revision')
            path = next((p for p in model['paths'] if p['id'] == path_id), None)
            if not path:
                raise ValueError('unknown path')
            transition = next(t for t in model['transitions'] if t['id'] == path['transition_id'])
            old = self.meta(db, 'path:' + path_id, {'verdict': 'pending'})
            selection = self.meta(db, 'selection:' + transition['id'], {'path_id': transition.get('initial_path_id'), 'revision': 1})
            effective_verdict = verdict or old['verdict']
            if adopt and effective_verdict in ('refuted', 'invalidated'):
                raise ValueError('cannot adopt a refuted or invalidated path')
            revision = expected_revision + 1
            change = {'path_id': path_id, 'transition_id': transition['id'], 'actor': actor, 'reason': reason, 'revision': revision}
            if verdict:
                self.put_meta(db, 'path:' + path_id, dict(change, verdict=verdict, evidence=evidence))
            changed = adopt or verdict and (selection or {}).get('path_id') == path_id
            if adopt:
                self.put_meta(db, 'selection:' + transition['id'], change)
            elif effective_verdict in ('refuted', 'invalidated') and (selection or {}).get('path_id') == path_id:
                self.put_meta(db, 'selection:' + transition['id'], None)
            self.event(db, 'path_decision', dict(change, verdict=effective_verdict, adopted=adopt, evidence=evidence))
            if changed:
                members = next(g['checkpoint_ids'] for g in model['groups'] if g['id'] == transition['to'])
                self.invalidate(db, members, reason)
        return self.publish()

    def invalidate_checkpoint(self, checkpoint, *, actor, reason, expected_revision):
        if not actor or not reason:
            raise ValueError('invalidation actor and reason required')
        with self.transaction() as db:
            if expected_revision != db.execute('SELECT COUNT(*) FROM events').fetchone()[0] or not db.execute('SELECT 1 FROM checkpoints WHERE id=?', (checkpoint,)).fetchone():
                raise ValueError('stale revision or unknown checkpoint')
            self.invalidate(db, [checkpoint], actor + ': ' + reason)
        return self.publish()

    def operation_key(self, db, token, name):
        plan = self.meta(db, 'plan')
        parts = [plan['task_id'], token['checkpoint'], name]
        if graph_plan(plan)['native']:
            parts.append(self.meta(db, 'context:' + token['attempt'])['input_digest'])
        return digest(encoded(parts))

    def prepare_operation(self, token, name, request):
        identifier(name)
        with self.transaction() as db:
            self.check(db, token)
            key = self.operation_key(db, token, name)
            existing = db.execute('SELECT * FROM operations WHERE key=?', (key,)).fetchone()
            if existing and existing['request'] != encoded(request).decode():
                raise ValueError('idempotency key request conflict')
            if not existing:
                db.execute('INSERT INTO operations VALUES(?,?,?,?,?,?)', (key, token['checkpoint'], encoded(request).decode(), 'prepared', None, stamp()))
                self.event(db, 'operation_prepared', {'key': key, 'checkpoint': token['checkpoint']})
            return key

    def dispatch(self, token, key, connector):
        """Connector.execute(key, request) must implement stable-key idempotency.

        A raised exception is ambiguous: never resend until lookup proves absent.
        The destination contract is required; local fencing cannot constrain an API.
        """
        with self.transaction() as db:
            self.check(db, token)
            row = db.execute('SELECT * FROM operations WHERE key=? AND checkpoint=?', (key, token['checkpoint'])).fetchone()
            if not row:
                raise ValueError('operation does not belong to this lease')
            if row['state'] == 'confirmed':
                return json.loads(row['receipt'])
            if row['state'] != 'prepared':
                raise ValueError('unknown result: reconcile before dispatch')
            db.execute("UPDATE operations SET state='dispatching',updated=? WHERE key=?", (stamp(), key))
            self.event(db, 'operation_dispatching', {'key': key})
        try:
            receipt = connector.execute(key, json.loads(row['request']))
            with self.transaction() as db:
                self.check(db, token)
                db.execute("UPDATE operations SET state='confirmed',receipt=?,updated=? WHERE key=?", (encoded(receipt).decode(), stamp(), key))
                self.event(db, 'operation_confirmed', {'key': key, 'receipt': receipt})
            return receipt
        except BaseException:
            with self.transaction() as db:
                # Never roll a concurrently reconciled outcome back to unknown.
                db.execute("UPDATE operations SET state='unknown',updated=? WHERE key=? AND state='dispatching'", (stamp(), key))
                self.event(db, 'operation_outcome_unknown', {'key': key})
            raise

    def reconcile(self, key, connector):
        with self.transaction() as db:
            self.reap(db)
            row = db.execute('SELECT * FROM operations WHERE key=?', (key,)).fetchone()
            if not row or row['state'] != 'unknown':
                raise ValueError('only unknown operations may be reconciled')
            active = db.execute("SELECT 1 FROM checkpoints WHERE id=? AND status='running'", (row['checkpoint'],)).fetchone()
            if active:
                raise ValueError('wait until owning execution lease has expired')
            request = row['request']
        # Provider reads must not hold the writer lock for unrelated checkpoints.
        observation = connector.lookup(key, json.loads(request))
        if observation['status'] not in ('confirmed', 'absent') or not observation.get('evidence'):
            raise ValueError('authoritative confirmed/absent evidence required')
        with self.transaction() as db:
            latest = db.execute('SELECT * FROM operations WHERE key=?', (key,)).fetchone()
            if not latest or latest['state'] != 'unknown' or latest['request'] != request:
                raise ValueError('operation changed during reconciliation')
            if db.execute("SELECT 1 FROM checkpoints WHERE id=? AND status='running'", (latest['checkpoint'],)).fetchone():
                raise ValueError('execution changed during reconciliation')
            # lookup(absent) also promises no previously dispatched request can arrive
            # later, or that the destination deduplicates that same stable key.
            db.execute('UPDATE operations SET state=?,receipt=?,updated=? WHERE key=?',
                       ('confirmed' if observation['status'] == 'confirmed' else 'prepared', encoded(observation).decode(), stamp(), key))
            self.event(db, 'operation_reconciled', {'key': key, 'observation': observation})
        self.publish()
        return observation

    def status(self):
        with self.transaction() as db:
            self.reap(db)
            return self.status_in(db)

    def status_in(self, db):
        plan = json.loads(db.execute("SELECT value FROM meta WHERE key='plan'").fetchone()[0])
        backup = db.execute("SELECT value FROM meta WHERE key='backup_status'").fetchone()
        return {'taskId': plan['task_id'], 'objective': plan.get('objective', plan['task_id']), 'plan': plan,
                'backupStatus': json.loads(backup[0]) if backup else None,
                'observationSeq': self.meta(db, 'observation_seq', 0),
                'contexts': {r['key'][8:]: json.loads(r['value']) for r in db.execute("SELECT * FROM meta WHERE key LIKE 'context:%'")},
                'pathStates': {r['key'][5:]: json.loads(r['value']) for r in db.execute("SELECT * FROM meta WHERE key LIKE 'path:%'")},
                'selections': {r['key'][10:]: json.loads(r['value']) for r in db.execute("SELECT * FROM meta WHERE key LIKE 'selection:%'")},
                'restoreHold': bool(db.execute("SELECT 1 FROM meta WHERE key='restore_hold'").fetchone()),
                'dataEpoch': int(db.execute("SELECT value FROM meta WHERE key='data_epoch'").fetchone()[0]),
                'revision': db.execute('SELECT COUNT(*) FROM events').fetchone()[0],
                'checkpoints': [dict(r) for r in db.execute('SELECT * FROM checkpoints ORDER BY rowid')],
                'attempts': [dict(r) for r in db.execute('SELECT * FROM attempts ORDER BY rowid')],
                'operations': [dict(r) for r in db.execute('SELECT * FROM operations ORDER BY rowid')]}

    def publish(self):
        """Serialize writers through the DB lock; files before head, committed DB first.

        A crash can leave the previous head or an orphan generation. Calling publish
        reconstructs the latest committed state. No reader follows staging files.
        """
        with self.transaction() as db:
            data = self.status_in(db)
            directory = self.root / 'generations' / f"{data['dataEpoch']}-{data['revision']}-{uuid4().hex}"
            directory.mkdir(parents=True, mode=0o700)
            files = projection(data, [dict(r) for r in db.execute('SELECT * FROM events ORDER BY revision')])
            hashes = {}
            for name, content in files.items():
                target = directory / name
                target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                atomic(target, content)
                hashes[name] = digest(content)
            manifest = {'schema': 'ocw-generation-1', 'taskId': data['taskId'], 'dataEpoch': data['dataEpoch'],
                        'revision': data['revision'], 'files': hashes}
            raw = encoded(manifest)
            atomic(directory / 'manifest.json', raw)
            syncdir(directory.parent)
            head = {'schema': 'ocw-head-1', 'taskId': data['taskId'], 'dataEpoch': data['dataEpoch'],
                    'revision': data['revision'], 'generation': str(directory.relative_to(self.root)), 'sha256': digest(raw)}
            atomic(self.root / 'ocw-head.json', encoded(head))
        return head

    def activate_restore(self, evidence):
        if not evidence or not evidence.strip():
            raise ValueError('restore activation requires reconciliation evidence')
        with self.transaction() as db:
            validate_plan(json.loads(db.execute("SELECT value FROM meta WHERE key='plan'").fetchone()[0]))
            if db.execute("SELECT 1 FROM operations WHERE state IN ('unknown','dispatching')").fetchone():
                raise ValueError('reconcile unknown operations before activating restored execution')
            db.execute("DELETE FROM meta WHERE key='restore_hold'")
            self.event(db, 'restore_activated', {'evidence': evidence})
        return self.publish()

    def record_backup(self, observation):
        with self.transaction() as db:
            db.execute("INSERT OR REPLACE INTO meta VALUES('backup_status',?)", (encoded(observation).decode(),))
            self.event(db, 'backup_' + observation['status'], observation)
        self.publish()


class FileDelivery:
    """Create immutable named files only in the configured delivery directory."""
    def __init__(self, destination):
        self.destination = Path(destination).resolve()

    def target(self, request):
        name = request['filename']
        if request.get('kind') != 'file' or not re.fullmatch(r'[A-Za-z0-9_.-]{1,200}', name) or name in ('.', '..'):
            raise ValueError('invalid file delivery request')
        return self.destination / name

    def lookup(self, key, request):
        target = self.target(request)
        if target.is_symlink():
            raise ValueError('delivery target is a symlink')
        expected = digest(request['content'].encode())
        if not target.exists():
            return {'status': 'absent', 'evidence': str(target), 'key': key}
        if digest(target.read_bytes()) != expected:
            raise ValueError('delivery conflict: existing file has different bytes')
        return {'status': 'confirmed', 'evidence': str(target), 'sha256': expected, 'key': key}

    def execute(self, key, request):
        target = self.target(request)
        self.destination.mkdir(parents=True, exist_ok=True, mode=0o700)
        if self.lookup(key, request)['status'] == 'confirmed':
            return self.lookup(key, request)
        fd, temporary = tempfile.mkstemp(prefix='.ocw-', dir=self.destination)
        try:
            with os.fdopen(fd, 'wb') as stream:
                stream.write(request['content'].encode())
                stream.flush()
                os.fsync(stream.fileno())
            try:
                os.link(temporary, target)  # O_EXCL semantics; never overwrite a delivery.
            except FileExistsError:
                pass
            syncdir(self.destination)
            return self.lookup(key, request)
        finally:
            os.unlink(temporary)


def projection(data, events):
    return project_graph(data, events)


def run_workers(runtime, workers=2, lease=30):
    """Bounded local runner; a failed/unknown task returns for operator attention."""
    if not 1 <= workers <= 16:
        raise ValueError('workers must be 1..16')
    plan = runtime.status()['plan']
    connector = FileDelivery(plan['delivery_dir'])
    # Only our built-in idempotent connector may reconcile automatically.
    for op in runtime.status()['operations']:
        if op['state'] == 'unknown' and json.loads(op['request']).get('kind') == 'file':
            runtime.reconcile(op['key'], connector)
    runtime.publish()

    def work(number):
        while True:
            token = runtime.claim(f'local/{os.getpid()}/worker-{number}', lease)
            if not token:
                state = runtime.status()
                if any(c['status'] == 'running' for c in state['checkpoints']):
                    time.sleep(min(lease / 3, 0.5))
                    continue
                runtime.publish()
                return
            stop = threading.Event()
            lost = threading.Event()
            def renew():
                while not stop.wait(lease / 3):
                    try:
                        runtime.heartbeat(token, lease)
                    except Exception:
                        lost.set()
                        return
            thread = threading.Thread(target=renew, daemon=True)
            thread.start()
            try:
                spec = token['spec']
                with runtime.transaction() as db:
                    result_key = runtime.operation_key(db, token, 'result')
                saved_result = next((o for o in runtime.status()['operations'] if o['key'] == result_key), None)
                if saved_result and json.loads(saved_result['request']).get('exitCode') == 0:
                    # Computation already succeeded before a delivery/receipt crash.
                    # Preserve its exact output (timestamps and test timings can differ).
                    receipt = runtime.dispatch(token, result_key, connector)
                    runtime.finish(token, {'exitCode': 0, 'receipt': receipt, 'resumedResult': True}, True)
                    continue
                exit_code, raw = bounded_command(spec['argv'], cwd=spec['cwd'],
                    env=dict(os.environ, OCW_PATH_ID=token['context']['path_id'], OCW_CHECKPOINT_ID=token['checkpoint'], OCW_INPUT_DIGEST=token['context']['input_digest']),
                    timeout=spec.get('timeout_seconds', 300), limit=8 * 1024 * 1024, interval=min(lease / 6, .1),
                    error='command timeout, output limit or lost lease', lost=lost)
                text = raw.decode('utf8', errors='replace')
                if exit_code or len(text.encode()) > 8 * 1024 * 1024:
                    runtime.finish(token, {'exitCode': exit_code, 'output': text[:10000]}, False)
                    continue
                key = runtime.prepare_operation(token, 'result', {'kind': 'file', 'filename': token['checkpoint'] + ('-' + token['context']['input_digest'][:16] if graph_plan(plan)['native'] else '') + '.txt', 'content': text, 'exitCode': 0})
                receipt = runtime.dispatch(token, key, connector)
                runtime.finish(token, {'exitCode': 0, 'receipt': receipt}, True)
            except Exception as error:
                try:
                    runtime.finish(token, {'error': str(error)}, False)
                except ValueError:
                    pass  # A superseded worker has no remaining write authority.
            finally:
                stop.set()
                thread.join()
    with ThreadPoolExecutor(max_workers=workers) as pool:
        list(pool.map(work, range(workers)))
    return runtime.status()


EPILOG = """\
Every command prints JSON on stdout and diagnostics on stderr.

Exit codes:
  0  success; for `run`, every checkpoint is accepted
  1  rejected input, or an I/O, schema or database error
  2  `run` finished with at least one checkpoint not accepted

Examples:
  ocw-runtime init   --root /abs/new-runtime --plan /abs/plan.json
  ocw-runtime run    --root /abs/runtime --workers 3 --registry /abs/registry
  ocw-runtime status --root /abs/runtime
  ocw-runtime decide-path --root /abs/runtime --path-id PATH-B --adopt \\
      --actor operator --reason 'benchmark favours B' --expected-revision 42

The plan contract is documented in docs/plan-contract.md and a runnable
example lives in examples/quickstart.
"""


def build_parser():
    """One subparser per command, so --help shows only the applicable flags."""
    parser = argparse.ArgumentParser(prog='ocw-runtime', description=__doc__, epilog=EPILOG,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest='command', required=True, metavar='<command>')

    def command(name, summary):
        child = commands.add_parser(name, help=summary, description=summary,
                                    formatter_class=argparse.RawDescriptionHelpFormatter)
        child.add_argument('--root', required=True, metavar='DIR', help='Runtime root directory')
        return child

    def decision(child):
        """Every authenticated write compares against the revision it read."""
        child.add_argument('--actor', required=True, metavar='WHO', help='Who is recording this decision')
        child.add_argument('--reason', required=True, metavar='TEXT', help='Why, kept in the event chain')
        child.add_argument('--expected-revision', required=True, type=int, metavar='N',
                           help='Revision this decision was made against; a stale value is refused')
        return child

    initialize = command('init', 'Create a new runtime root from a validated plan')
    initialize.add_argument('--plan', required=True, metavar='FILE',
                            help='Plan JSON. The root must not already exist')

    run = command('run', 'Claim and execute ready checkpoints under fenced leases')
    run.add_argument('--workers', type=int, default=2, metavar='N', help='Concurrent workers, 1..16 (default 2)')
    run.add_argument('--lease', type=float, default=30, metavar='SECONDS',
                     help='Lease duration, 0.1..300 (default 30)')
    run.add_argument('--registry', metavar='DIR', help='Explicitly register and heartbeat this executor run')
    run.add_argument('--backup-config', metavar='FILE',
                     help='Write a verified backup after this run closes its registration')
    run.add_argument('--service-mode', action='store_true',
                     help='A reported normal stop requires attention rather than OS retry')

    command('status', 'Print the current read model without mutating anything')
    command('publish', 'Re-export the latest committed facts as an immutable generation')

    restore = command('activate-restore', 'Release the execution hold on a restored runtime')
    restore.add_argument('--evidence', required=True, metavar='TEXT',
                         help='Free-text record of what was verified before activating')

    decide = decision(command('decide-path', 'Adopt a path or record a verdict about one'))
    decide.add_argument('--path-id', required=True, metavar='ID', help='Path to decide on')
    decide.add_argument('--adopt', action='store_true',
                        help='Select this path. Independent of --verdict; invalidates dependent checkpoints')
    decide.add_argument('--verdict', choices=['pending', 'supported', 'refuted', 'invalidated'],
                        help='Conclusion about the path. Requires --evidence-file')
    decide.add_argument('--evidence-file', metavar='FILE',
                        help='JSON evidence for --verdict. Not the same flag as activate-restore --evidence')

    invalidate = decision(command('invalidate-checkpoint', 'Revoke a checkpoint and its dependents'))
    invalidate.add_argument('--checkpoint-id', required=True, metavar='ID', help='Checkpoint to revoke')

    return parser


@contextmanager
def executor_registration(root, registry):
    """Announce this run in the registry, heartbeat while it works, then close.

    Registry metadata is never execution authority, so a heartbeat failure is
    reported and the run continues: the SQLite lease is what actually guards
    writes. Closing on the way out is what stops a finished run from looking
    like a live worker.
    """
    directory = Path(registry).expanduser().resolve()
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    registration = register(argparse.Namespace(source=root, session='executor', id=None, instance=None,
                                               new_instance=True, pid=os.getpid(), label=None), directory)
    identity = {'id': registration['registrationId'], 'instance': registration['instanceId']}
    done = threading.Event()

    def beat():
        sequence = 0
        while not done.is_set():
            sequence += 1
            try:
                update(argparse.Namespace(command='heartbeat', seq=sequence, **identity), directory)
            except Exception as error:
                print('Registry heartbeat unavailable: ' + str(error), file=sys.stderr)
            done.wait(5)

    thread = threading.Thread(target=beat, daemon=True)
    thread.start()
    try:
        yield registration
    finally:
        done.set()
        thread.join()
        try:
            update(argparse.Namespace(command='close', **identity), directory)
        except ValueError:
            pass  # Already closed or superseded; nothing left to release.


def execute(runtime, args):
    """Run one command and return the JSON-serializable result to print."""
    if args.command == 'run':
        return run_workers(runtime, args.workers, args.lease)
    if args.command == 'publish':
        return runtime.publish()
    if args.command == 'activate-restore':
        return runtime.activate_restore(args.evidence)
    return runtime.status()  # `init` and `status` both report the read model.


def main():
    args = build_parser().parse_args()
    try:
        if args.command == 'init':
            runtime = Runtime.initialize(args.root, json.loads(Path(args.plan).read_text()))
        else:
            runtime = Runtime(args.root)

        if args.command == 'decide-path':
            evidence = json.loads(Path(args.evidence_file).read_text()) if args.evidence_file else None
            print(json.dumps(runtime.decide_path(args.path_id, actor=args.actor, reason=args.reason,
                                                 expected_revision=args.expected_revision,
                                                 verdict=args.verdict, adopt=args.adopt, evidence=evidence)))
            return 0
        if args.command == 'invalidate-checkpoint':
            print(json.dumps(runtime.invalidate_checkpoint(args.checkpoint_id, actor=args.actor,
                                                           reason=args.reason,
                                                           expected_revision=args.expected_revision)))
            return 0

        registry = getattr(args, 'registry', None)
        with executor_registration(args.root, registry) if registry else nullcontext():
            result = execute(runtime, args)

        backup_failed = False
        if args.command == 'run' and args.backup_config:
            # Imported here, not at module scope: ocw_backup imports this module
            # for the SQLite online-backup helpers, so a top-level import cycles.
            from ocw_backup import create
            runtime.record_backup({'status': 'running', 'startedAt': stamp()})
            try:
                config = json.loads(Path(args.backup_config).read_text())
                receipt = dict(create(config, config['destination']), status='complete')
            except (OSError, ValueError, KeyError, sqlite3.Error) as error:
                receipt = {'status': 'failed', 'error': str(error), 'finishedAt': stamp()}
                backup_failed = True
            runtime.record_backup(receipt)
            result = runtime.status()
            result['backup'] = receipt
        print(json.dumps(result, ensure_ascii=False))
        if backup_failed:
            return 1
        if args.command == 'run' and any(c['status'] != 'accepted' for c in result['checkpoints']):
            return 2
    except (ValueError, OSError, KeyError, sqlite3.Error) as error:
        print('OCW executor: ' + str(error), file=sys.stderr)
        return 1
    return 0


def cli():
    """Console entry point. Wraps main() with the service-mode exit remap so a
    supervisor treats "stopped for attention" as a normal stop, not a crash."""
    outcome = main()
    if '--service-mode' in sys.argv and outcome:
        print(f'OCW service stopped for attention (executor result {outcome}); inspect checkpoint/operation state before restart.', file=sys.stderr)
        outcome = 0
    return outcome


if __name__ == '__main__':
    sys.exit(cli())
