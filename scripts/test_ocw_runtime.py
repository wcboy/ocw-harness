import copy
import errno
from concurrent.futures import ThreadPoolExecutor
import io
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from ocw_runtime import Runtime, FileDelivery, encoded, run_workers, bounded_command
from ocw_backup import create, restore, verify

HERE = Path(__file__).resolve().parent


class CommandBoundsTests(unittest.TestCase):
    def command(self, code, **options):
        return bounded_command([sys.executable, '-c', code], cwd=HERE, env=os.environ,
                               interval=.01, error='execution stopped', **options)

    def test_output_and_exit_status_are_preserved_including_nonzero_exit(self):
        code, raw = self.command('import os; os.write(1,b"out\\xff"); os.write(2,b"err"); raise SystemExit(7)', timeout=3, limit=100)
        self.assertEqual((code, raw), (7, b'out\xfferr'))

    def test_timeout_kills_descendants_before_they_can_write(self):
        with tempfile.TemporaryDirectory() as folder:
            marker = Path(folder) / 'should-not-exist'
            descendant = f'import time; from pathlib import Path; time.sleep(.8); Path({str(marker)!r}).touch()'
            code = f'import subprocess,sys,time; subprocess.Popen([sys.executable,"-c",{descendant!r}]); time.sleep(10)'
            with self.assertRaisesRegex(ValueError, 'execution stopped'):
                self.command(code, timeout=.2, limit=100)
            time.sleep(.9)
            self.assertFalse(marker.exists())

    def test_streaming_output_is_bounded_and_finite_output_is_preserved(self):
        with self.assertRaisesRegex(ValueError, 'execution stopped'):
            self.command('import os,time; os.write(1,b"x"*4096); time.sleep(10)', timeout=3, limit=100)
        code, raw = self.command('import os; os.write(1,b"x"*4096)', timeout=3, limit=10000)
        self.assertEqual((code, len(raw)), (0, 4096))

    def test_lease_loss_cancels_running_work(self):
        lost = threading.Event()
        timer = threading.Timer(.1, lost.set)
        timer.start()
        try:
            with self.assertRaisesRegex(ValueError, 'execution stopped'):
                self.command('import time; time.sleep(10)', timeout=3, limit=100, lost=lost)
        finally:
            timer.join()


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='ocw-executor-test-')
        self.root = Path(self.temporary.name)
        self.plan = {'task_id': 'TASK-EXECUTOR-TEST', 'objective': '实际执行与恢复验证', 'delivery_dir': str(self.root / 'delivery'),
                     'checkpoints': [self.step('CHECK-A'), self.step('CHECK-B'), self.step('CHECK-C', ['CHECK-A', 'CHECK-B'])]}
        self.runtime = Runtime.initialize(self.root / 'runtime', self.plan)

    def tearDown(self):
        self.temporary.cleanup()

    def step(self, name, deps=None):
        return {'id': name, 'cwd': str(self.root), 'argv': [sys.executable, '-c', 'print("verified")'],
                'execution': 'replay_safe', 'depends_on': deps or [], 'timeout_seconds': 10, 'max_attempts': 3}

    def test_plan_rejects_cycles_and_undeclared_replay(self):
        bad = copy.deepcopy(self.plan)
        bad['checkpoints'][0]['depends_on'] = ['CHECK-C']
        with self.assertRaisesRegex(ValueError, 'cycle'):
            Runtime.initialize(self.root / 'invalid', bad)
        bad = copy.deepcopy(self.plan)
        del bad['checkpoints'][0]['execution']
        with self.assertRaisesRegex(ValueError, 'replay_safe'):
            Runtime.initialize(self.root / 'invalid', bad)
        self.assertFalse((self.root / 'invalid').exists())

    def test_parallel_claims_are_unique_and_join_waits(self):
        with ThreadPoolExecutor(max_workers=8) as pool:
            tokens = list(pool.map(lambda n: self.runtime.claim(f'owner-{n}'), range(8)))
        claimed = [t for t in tokens if t]
        self.assertEqual({t['checkpoint'] for t in claimed}, {'CHECK-A', 'CHECK-B'})
        self.assertEqual(len(claimed), 2)
        self.runtime.finish(claimed[0], {'ok': True})
        self.assertIsNone(self.runtime.claim('join'))
        self.runtime.finish(claimed[1], {'ok': True})
        self.assertEqual(self.runtime.claim('join')['checkpoint'], 'CHECK-C')

    def test_dead_executor_takeover_fences_original_commit_and_heartbeat(self):
        code = "from ocw_runtime import Runtime; import json,sys,time; r=Runtime(sys.argv[1]); print(json.dumps(r.claim('old',.2)),flush=True); time.sleep(30)"
        child = subprocess.Popen([sys.executable, '-c', code, str(self.runtime.root)], cwd=HERE, stdout=subprocess.PIPE, text=True)
        token = json.loads(child.stdout.readline())
        child.kill()
        child.wait()
        child.stdout.close()
        time.sleep(.22)
        replacement = self.runtime.claim('replacement')
        self.assertEqual(replacement['checkpoint'], token['checkpoint'])
        self.assertGreater(replacement['epoch'], token['epoch'])
        for action in (lambda: self.runtime.finish(token, {'corrupt': True}), lambda: self.runtime.heartbeat(token)):
            with self.assertRaisesRegex(ValueError, 'fenced'):
                action()
        self.runtime.finish(replacement, {'ok': True})
        history = self.runtime.status()['attempts']
        self.assertEqual([a['status'] for a in history], ['interrupted', 'accepted'])

    def test_expired_worker_cannot_renew_even_before_takeover(self):
        token = self.runtime.claim('old', .1)
        time.sleep(.12)
        with self.assertRaisesRegex(ValueError, 'fenced'):
            self.runtime.heartbeat(token)

    def test_attempt_budget_is_bounded_and_history_is_preserved(self):
        for _ in range(3):
            token = self.runtime.claim('worker')
            self.assertEqual(token['checkpoint'], 'CHECK-A')
            self.runtime.finish(token, {'exitCode': 1}, False)
        next_token = self.runtime.claim('worker')
        self.assertEqual(next_token['checkpoint'], 'CHECK-B')
        state = self.runtime.status()
        self.assertEqual(state['checkpoints'][0]['status'], 'failed')
        self.assertEqual(sum(a['status'] == 'failed' for a in state['attempts']), 3)

    def test_legacy_attempts_without_context_still_consume_retry_budget(self):
        for _ in range(3):
            token = self.runtime.claim('legacy-worker')
            self.runtime.finish(token, {'exitCode':1}, False)
        with self.runtime.transaction() as db:
            db.execute("DELETE FROM meta WHERE key LIKE 'context:%'")
        self.assertEqual(self.runtime.claim('upgraded-worker')['checkpoint'], 'CHECK-B')
        self.assertEqual(self.runtime.status()['checkpoints'][0]['status'], 'failed')

    def test_atomic_head_survives_writer_crash_and_republishes_committed_db(self):
        before = (self.runtime.root / 'ocw-head.json').read_bytes()
        code = '''import os,sys
import ocw_runtime as m
r=m.Runtime(sys.argv[1]); t=r.claim('crash')
(r.root/'before-crash-head.json').write_bytes((r.root/'ocw-head.json').read_bytes())
original=m.atomic
def die(path, data):
    if path.name == 'ocw-head.json': os._exit(9)
    original(path,data)
m.atomic=die
r.finish(t,{'ok':True})
'''
        result = subprocess.run([sys.executable, '-c', code, str(self.runtime.root)], cwd=HERE)
        self.assertEqual(result.returncode, 9)
        self.assertEqual((self.runtime.root / 'ocw-head.json').read_bytes(), (self.runtime.root / 'before-crash-head.json').read_bytes())
        self.assertEqual(self.runtime.status()['checkpoints'][0]['status'], 'accepted')
        after = self.runtime.publish()
        self.assertGreater(after['revision'], json.loads(before)['revision'])

    def test_side_effect_crash_reconciles_without_duplicate_delivery(self):
        code = '''import os,sys
from ocw_runtime import Runtime,FileDelivery
r=Runtime(sys.argv[1]); t=r.claim('crash',.2)
class Crash(FileDelivery):
    def execute(self,key,request):
        super().execute(key,request)
        os._exit(8)
k=r.prepare_operation(t,'result',{'kind':'file','filename':'CHECK-A.txt','content':'saved-original-output\\n','exitCode':0})
r.dispatch(t,k,Crash(sys.argv[2]))
'''
        result = subprocess.run([sys.executable, '-c', code, str(self.runtime.root), self.plan['delivery_dir']], cwd=HERE)
        self.assertEqual(result.returncode, 8)
        file = self.root / 'delivery/CHECK-A.txt'
        inode = file.stat().st_ino
        time.sleep(.22)
        state = self.runtime.status()
        key = state['operations'][0]['key']
        self.assertEqual(state['operations'][0]['state'], 'unknown')
        self.assertEqual(self.runtime.claim('different')['checkpoint'], 'CHECK-B')
        # Release the independent checkpoint without disturbing the interrupted one.
        with self.runtime.transaction() as db:
            db.execute("UPDATE checkpoints SET expires=0 WHERE id='CHECK-B'")
        self.runtime.reconcile(key, FileDelivery(self.plan['delivery_dir']))
        final = run_workers(self.runtime, 3, .6)
        self.assertTrue(all(c['status'] == 'accepted' for c in final['checkpoints']))
        self.assertEqual(file.stat().st_ino, inode)
        self.assertEqual(file.read_text(), 'saved-original-output\n')
        self.assertTrue(any(json.loads(a['result'] or '{}').get('resumedResult') for a in final['attempts']))
        self.assertEqual(len([o for o in final['operations'] if o['checkpoint'] == 'CHECK-A']), 1)
        self.assertGreaterEqual(sum(a['status'] == 'interrupted' for a in final['attempts']), 1)

    def test_external_unknown_blocks_replay_until_authoritative_receipt(self):
        class Sink:
            def __init__(self):
                self.calls = 0
            def execute(self, key, request):
                self.calls += 1
                raise TimeoutError('server accepted but response lost')
            def lookup(self, key, request):
                return {'status': 'confirmed', 'evidence': 'provider/receipt-123', 'key': key}
        sink = Sink()
        token = self.runtime.claim('external')
        key = self.runtime.prepare_operation(token, 'provider-call', {'operation': 'test'})
        with self.assertRaises(TimeoutError):
            self.runtime.dispatch(token, key, sink)
        with self.assertRaisesRegex(ValueError, 'reconcile'):
            self.runtime.dispatch(token, key, sink)
        with self.assertRaisesRegex(ValueError, 'unreconciled'):
            self.runtime.finish(token, {'ok': True})
        self.runtime.finish(token, {'unknown': True}, False)
        self.runtime.reconcile(key, sink)
        replacement = self.runtime.claim('retry')
        self.assertEqual(key, self.runtime.prepare_operation(replacement, 'provider-call', {'operation': 'test'}))
        self.runtime.dispatch(replacement, key, sink)
        self.runtime.finish(replacement, {'ok': True})
        self.assertEqual(sink.calls, 1)

    def test_operation_cannot_be_stolen_and_request_cannot_drift(self):
        a, b = self.runtime.claim('a'), self.runtime.claim('b')
        key = self.runtime.prepare_operation(a, 'logical-write', {'v': 1})
        with self.assertRaisesRegex(ValueError, 'conflict'):
            self.runtime.prepare_operation(a, 'logical-write', {'v': 2})
        with self.assertRaisesRegex(ValueError, 'belong'):
            self.runtime.dispatch(b, key, None)

    def test_slow_external_lookup_does_not_lock_independent_checkpoint(self):
        entered, release = threading.Event(), threading.Event()
        class Slow:
            def execute(self, key, request):
                raise TimeoutError('ambiguous')
            def lookup(self, key, request):
                entered.set()
                release.wait(3)
                return {'status': 'confirmed', 'evidence': 'provider-receipt'}
        token = self.runtime.claim('external')
        key = self.runtime.prepare_operation(token, 'external', {})
        with self.assertRaises(TimeoutError):
            self.runtime.dispatch(token, key, Slow())
        self.runtime.finish(token, {}, False)
        with ThreadPoolExecutor() as pool:
            pending = pool.submit(self.runtime.reconcile, key, Slow())
            self.assertTrue(entered.wait(1))
            try:
                independent = pool.submit(self.runtime.claim, 'independent').result(timeout=1)
                self.assertEqual(independent['checkpoint'], 'CHECK-B')
            finally:
                release.set()
            pending.result()

    def test_delivery_refuses_overwrite_and_path_escape(self):
        delivery = FileDelivery(self.root / 'delivery')
        delivery.execute('one', {'kind': 'file', 'filename': 'a.txt', 'content': 'first'})
        with self.assertRaisesRegex(ValueError, 'conflict'):
            delivery.execute('two', {'kind': 'file', 'filename': 'a.txt', 'content': 'second'})
        with self.assertRaisesRegex(ValueError, 'invalid'):
            delivery.execute('two', {'kind': 'file', 'filename': '../escape', 'content': 'bad'})

    def test_backup_restores_new_epoch_stale_leases_rejected_and_delivery_preserved(self):
        a = self.runtime.claim('accepted')
        key = self.runtime.prepare_operation(a, 'result', {'kind': 'file', 'filename': 'CHECK-A.txt', 'content': 'verified\n'})
        self.runtime.dispatch(a, key, FileDelivery(self.plan['delivery_dir']))
        self.runtime.finish(a, {'ok': True})
        old = self.runtime.claim('active')
        info = create({'items': [{'name': 'runtime', 'kind': 'runtime', 'path': str(self.runtime.root)}]}, self.root / 'backups')
        self.assertGreater(verify(info['archive'])['files']['runtime/runtime.sqlite3']['size'], 0)
        destination = self.root / 'restored'
        restore(info['archive'], destination)
        restored = Runtime(destination / 'runtime')
        state = restored.status()
        self.assertGreater(state['dataEpoch'], self.runtime.status()['dataEpoch'])
        self.assertEqual(state['checkpoints'][0]['status'], 'accepted')
        self.assertTrue(state['restoreHold'])
        self.assertIsNone(restored.claim('new-host'))
        with self.assertRaisesRegex(ValueError, 'fenced'):
            restored.finish(old, {'bad': True})
        self.assertEqual((destination / 'runtime/deliveries/CHECK-A.txt').read_text(), 'verified\n')
        restored.activate_restore('Verified delivery hashes; replay-safe pending commands; original host remains isolated.')
        self.assertTrue(all(c['status'] == 'accepted' for c in run_workers(restored, 2, .6)['checkpoints']))
        with self.assertRaisesRegex(ValueError, 'must not exist'):
            restore(info['archive'], destination)

    def test_restored_frontend_launcher_follows_restored_source_and_build(self):
        console = self.root / 'console'; (console / 'scripts').mkdir(parents=True)
        launcher = console / 'scripts/run-bound-ui.sh'
        launcher.write_text('#!/bin/sh\nprintf "%s" "$OCW_BUILD_DIR"\n')
        launcher.chmod(0o755)
        frontend = self.root / 'frontend';frontend.mkdir()
        (frontend/'source-project').write_text(str(console)+'\n')
        entry = HERE.parent/'public/start.command'
        if not entry.is_file(): entry = HERE.parent/'assets/start.command'
        (frontend/'start.command').write_bytes(entry.read_bytes())
        archive = create({'items':[{'name':'console','path':str(console)},{'name':'frontend','path':str(frontend)}]},self.root/'backups')
        destination=self.root/'restored-ui';restore(archive['archive'],destination)
        self.assertEqual((destination/'frontend/source-project').read_text().strip(),str(destination/'console'))
        result=subprocess.check_output(['sh',str(destination/'frontend/start.command')],text=True)
        self.assertEqual(result,str(destination/'frontend'))

    def test_corrupt_or_unsafe_backup_is_rejected_before_destination_creation(self):
        info = create({'items': [{'name': 'runtime', 'kind': 'runtime', 'path': str(self.runtime.root)}]}, self.root / 'backups')
        bad = self.root / 'bad.tar.gz'
        with tarfile.open(info['archive'], 'r:gz') as original, tarfile.open(bad, 'w:gz') as output:
            for member in original.getmembers():
                data = original.extractfile(member).read()
                if member.name.endswith('sqlite3'):
                    data = b'broken'
                    member.size = len(data)
                output.addfile(member, io.BytesIO(data))
        destination = self.root / 'unsafe'
        with self.assertRaisesRegex(ValueError, 'digest'):
            restore(bad, destination)
        self.assertFalse(destination.exists())
        with tarfile.open(bad, 'w:gz') as output:
            entry = tarfile.TarInfo('../escape')
            entry.size = 1
            output.addfile(entry, io.BytesIO(b'x'))
        with self.assertRaisesRegex(ValueError, 'unsafe'):
            verify(bad)

    def test_missing_backup_volume_does_not_fallback_to_system_disk(self):
        with self.assertRaisesRegex(ValueError, 'not mounted'):
            create({'items': [], 'required_mount': str(self.root / 'missing-volume')}, self.root / 'missing-volume/backup')
        self.assertFalse((self.root / 'missing-volume').exists())

    def test_restore_remaps_file_evidence_without_editing_historical_canonical(self):
        registry = self.root / 'registry'
        registry.mkdir()
        evidence = self.root / 'product.md'
        evidence.write_text('accepted product')
        record = {'sourceRoot': str(self.runtime.root), 'recordVersion': 1, 'lifecycle': 'registered'}
        (registry / 'harness.json').write_text(json.dumps(record))
        info = create({'items': [{'name': 'runtime', 'path': str(self.runtime.root), 'kind': 'runtime'},
                                 {'name': 'registry', 'path': str(registry), 'kind': 'registry'},
                                 {'name': 'product', 'path': str(evidence)}]}, self.root / 'backups')
        restored = self.root / 'restored'
        restore(info['archive'], restored)
        record = json.loads((restored / 'registry/harness.json').read_text())
        self.assertEqual(record['sourceRoot'], str(restored / 'runtime'))
        self.assertEqual(record['lifecycle'], 'closed')
        self.assertEqual(Path(record['recoveryPaths'][str(evidence)]).read_text(), 'accepted product')

    def test_declared_test_artifacts_are_excluded_without_skipping_source_files(self):
        code = self.root / 'code'
        (code / 'output/playwright').mkdir(parents=True)
        (code / 'source.py').write_text('verified source')
        (code / 'output/playwright/unavailable').symlink_to(self.root / 'missing')
        config = {'items': [{'name': 'code', 'path': str(code), 'exclude': ['output/playwright']}]}
        info = create(config, self.root / 'backups')
        self.assertEqual(set(verify(info['archive'])['files']), {'code/source.py'})

    def test_native_copy_deadlock_falls_back_to_verified_streamed_bytes(self):
        source = self.root / 'source.txt'
        source.write_text('whole original evidence')
        with patch('ocw_backup.shutil.copy2', side_effect=OSError(errno.EDEADLK, 'native copy deadlock')) as native:
            info = create({'items': [{'name': 'source', 'path': str(source)}]}, self.root / 'backups')
            native.assert_not_called()
        with tarfile.open(info['archive'], 'r:gz') as archive:
            self.assertEqual(archive.extractfile('source/source.txt').read(), b'whole original evidence')

    def test_parallel_runner_resumes_completed_checkpoints_without_new_attempts(self):
        first = run_workers(self.runtime, 3, .6)
        second = run_workers(self.runtime, 3, .6)
        self.assertEqual(len(first['attempts']), 3)
        self.assertEqual(first['attempts'], second['attempts'])
        self.assertEqual(len(list((self.root / 'delivery').glob('*.txt'))), 3)

    def test_os_service_attention_stop_is_not_successful_task_completion(self):
        plan = copy.deepcopy(self.plan)
        plan['checkpoints'] = [dict(self.step('FAIL'), max_attempts=1, argv=[sys.executable, '-c', 'raise SystemExit(7)'])]
        root = self.root / 'failing-service'
        Runtime.initialize(root, plan)
        base = [sys.executable, str(HERE / 'ocw_runtime.py'), 'run', '--root', str(root)]
        service = subprocess.run(base + ['--service-mode'], capture_output=True, text=True)
        self.assertEqual(service.returncode, 0)
        self.assertEqual(json.loads(service.stdout)['checkpoints'][0]['status'], 'failed')
        self.assertIn('stopped for attention', service.stderr)
        ordinary = subprocess.run(base, capture_output=True, text=True)
        self.assertEqual(ordinary.returncode, 2)

    def test_failed_backup_is_persisted_separately_from_accepted_work(self):
        config = self.root / 'backup-config.json'
        config.write_text(json.dumps({'required_mount': str(self.root / 'missing-disk'), 'destination': str(self.root / 'missing-disk/backups'), 'items': []}))
        process = subprocess.run([sys.executable, str(HERE / 'ocw_runtime.py'), 'run', '--root', str(self.runtime.root), '--backup-config', str(config)], capture_output=True, text=True)
        self.assertEqual(process.returncode, 1)
        data = json.loads(process.stdout)
        self.assertTrue(all(c['status'] == 'accepted' for c in data['checkpoints']))
        self.assertEqual(data['backupStatus']['status'], 'failed')
        head = json.loads((self.runtime.root / 'ocw-head.json').read_text())
        execution = json.loads((self.runtime.root / head['generation'] / 'execution.json').read_text())
        self.assertEqual(execution['backup']['status'], 'failed')

    def test_later_backup_events_do_not_rewrite_checkpoint_acceptance_revision(self):
        token = self.runtime.claim('owner')
        self.runtime.finish(token, {'ok': True})
        head = json.loads((self.runtime.root / 'ocw-head.json').read_text())
        before = (self.runtime.root / head['generation'] / 'accepted/CHECK-A.json').read_bytes()
        self.runtime.record_backup({'status': 'complete', 'archive': 'verified-fixture'})
        head = json.loads((self.runtime.root / 'ocw-head.json').read_text())
        self.assertEqual((self.runtime.root / head['generation'] / 'accepted/CHECK-A.json').read_bytes(), before)


if __name__ == '__main__':
    unittest.main(verbosity=2)
