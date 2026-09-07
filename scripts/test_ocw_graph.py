import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest
from ocw_graph import graph_plan
from ocw_runtime import Runtime, run_workers, FileDelivery


def native_plan(cwd):
    groups = [{'id': 'GR-A', 'label': '结构与授权', 'policy': 'all', 'checkpoint_ids': ['CP-A1', 'CP-A2', 'CP-A3']},
              {'id': 'GR-B', 'label': '状态与证据', 'policy': 'all', 'checkpoint_ids': ['CP-B1', 'CP-B2']},
              {'id': 'GR-C', 'label': '运行与验收', 'policy': 'all', 'checkpoint_ids': ['CP-C1']}]
    transitions = [{'id': 'TR-' + suffix, 'from': ['GR-A', 'GR-B'] if suffix == 'C' else [], 'to': 'GR-' + suffix, 'initial_path_id': 'PATH-' + suffix + '-1'} for suffix in 'ABC']
    paths = [{'id': 'PATH-' + suffix + '-' + str(i), 'transition_id': 'TR-' + suffix, 'label': label, 'short_label': label, 'mechanism': '本地验证的候选执行方案'} for suffix in 'ABC' for i, label in enumerate(['版本投影', '直接重试', '事件回放'], 1)]
    checkpoints = [{'id': cid, 'objective': objective, 'label': objective, 'cwd': str(cwd), 'argv': [sys.executable, '-c', 'print("verified-local-output")'], 'depends_on': ['CP-A2'] if cid == 'CP-A3' else [], 'execution': 'replay_safe', 'acceptance': {'version': 'local-receipt-v1', 'argv': [sys.executable, '-c', 'import json,os; d=json.load(open(os.environ["OCW_RESULT_FILE"])); assert d["result"].get("ok", d["result"].get("exitCode")==0); print("independent oracle passed")']}} for cid, objective in zip(['CP-A1','CP-A2','CP-A3','CP-B1','CP-B2','CP-C1'], ['角色划分','权限边界','操作范围','状态快照','摘要核验','结果复验'])]
    return {'schema_version': 'ocw-plan-2', 'task_id': 'TASK-NATIVE', 'objective': '验证并发路径与全部必要检查点', 'delivery_dir': str(cwd / 'delivery'), 'groups': groups, 'transitions': transitions, 'paths': paths, 'checkpoints': checkpoints}


class NativeGraphTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='ocw-graph-test-')
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.plan = native_plan(self.base)
        self.runtime = Runtime.initialize(self.base / 'runtime', self.plan)

    def documents(self):
        head = json.loads((self.runtime.root / 'ocw-head.json').read_text())
        root = self.runtime.root / head['generation']
        return root, json.loads((root / 'checkpoint-graph.json').read_text())

    def decision(self, path, **kwargs):
        return self.runtime.decide_path(path, actor='test-coordinator', reason='明确记录的方案结论', expected_revision=self.runtime.status()['revision'], **kwargs)

    def test_membership_all_dependencies_and_cycles_are_validated(self):
        self.assertEqual(set(graph_plan(self.plan)['dependencies']['CP-C1']), {'CP-A1','CP-A2','CP-A3','CP-B1','CP-B2'})
        for mutate in [lambda p: p['groups'][0].update(checkpoint_ids=[]), lambda p: p['groups'][1]['checkpoint_ids'].append('CP-A1'), lambda p: p['transitions'][0].update(initial_path_id='PATH-B-1'), lambda p: p['transitions'][0].update(**{'from':['GR-C']}), lambda p: p['checkpoints'][0].pop('acceptance'), lambda p: p['groups'][0].update(policy='any')]:
            plan = copy.deepcopy(self.plan); mutate(plan)
            with self.assertRaises((ValueError, KeyError)): Runtime.initialize(self.base / 'invalid', plan)
            self.assertFalse((self.base / 'invalid').exists())

    def test_partial_group_states_are_independent_and_join_waits(self):
        a = self.runtime.claim('worker-a'); self.runtime.finish(a, {'ok': True})
        b = self.runtime.claim('worker-b')
        c = self.runtime.claim('worker-c')
        self.assertEqual([a['checkpoint'],b['checkpoint'],c['checkpoint']], ['CP-A1','CP-A2','CP-B1'])
        root, graph = self.documents()
        states = {cp['checkpoint_id']: cp['execution_status'] for cp in graph['checkpoints']}
        self.assertEqual([states[c] for c in ['CP-A1','CP-A2','CP-A3']], ['accepted','running','pending'])
        cp = graph['checkpoints'][0]
        self.assertEqual(cp['acceptance']['record']['verdict'], 'pass')
        self.assertTrue((root / cp['acceptance']['ref']).is_file())
        self.assertNotEqual(b['checkpoint'], 'CP-C1')

    def test_executable_oracle_can_reject_successful_command(self):
        token = self.runtime.claim('worker')
        self.runtime.finish(token, {'ok': False, 'exitCode': 0})
        state = self.runtime.status()
        self.assertEqual(state['checkpoints'][0]['status'], 'pending')
        self.assertEqual(json.loads(state['attempts'][0]['result'])['acceptance']['verdict'], 'fail')

    def test_failed_attempt_is_not_path_refutation_and_retries_share_one_path(self):
        token = self.runtime.claim('worker'); self.runtime.finish(token, {'error':'transient'}, False)
        retry = self.runtime.claim('worker'); self.runtime.finish(retry, {'ok':True})
        _, graph = self.documents()
        self.assertEqual(len(graph['paths']), 9)
        path = next(p for p in graph['paths'] if p['path_id'] == 'PATH-A-1')
        self.assertEqual(path['verdict'], 'pending')
        self.assertTrue(path['selected'])
        self.assertEqual([a['status'] for a in path['attempt_history']], ['failed','accepted'])

    def test_refutation_revokes_selection_and_fences_active_writes(self):
        token = self.runtime.claim('old-worker')
        self.decision('PATH-A-1', verdict='refuted', evidence={'counterexample':'input mismatch'})
        with self.assertRaisesRegex(ValueError,'fenced'): self.runtime.finish(token, {'ok': True})
        with self.assertRaisesRegex(ValueError,'fenced'): self.runtime.heartbeat(token)
        _, graph = self.documents()
        path = next(p for p in graph['paths'] if p['path_id'] == 'PATH-A-1')
        self.assertFalse(path['selected'])
        self.assertEqual(path['verdict'], 'refuted')
        self.assertEqual(self.runtime.claim('other-group')['checkpoint'], 'CP-B1')
        self.decision('PATH-A-1', verdict='pending', evidence={'review':'reopened'})
        self.assertFalse(next(p for p in self.documents()[1]['paths'] if p['path_id'] == 'PATH-A-1')['selected'], 'cleared initial selection must not resurrect')
        self.decision('PATH-A-3', adopt=True)
        self.assertEqual(self.runtime.claim('new-worker')['checkpoint'], 'CP-A1')

    def test_decisions_use_compare_and_swap_and_cannot_adopt_refuted_path(self):
        self.decision('PATH-A-2', verdict='refuted', evidence={'counterexample':'conflict'})
        with self.assertRaisesRegex(ValueError,'cannot adopt'): self.decision('PATH-A-2', adopt=True)
        with self.assertRaisesRegex(ValueError,'stale'): self.runtime.decide_path('PATH-A-1', actor='owner', reason='decision', expected_revision=0, adopt=True)

    def test_invalidating_evidence_propagates_and_revalidation_preserves_prior_delivery(self):
        result = run_workers(self.runtime, workers=3)
        self.assertTrue(all(c['status'] == 'accepted' for c in result['checkpoints']))
        prior = {p.name:p.read_bytes() for p in Path(self.plan['delivery_dir']).glob('*')}
        self.runtime.invalidate_checkpoint('CP-A1', actor='reviewer', reason='input changed', expected_revision=result['revision'])
        state = {c['id']:c['status'] for c in self.runtime.status()['checkpoints']}
        self.assertEqual(state['CP-C1'],'pending');self.assertEqual(state['CP-B1'],'accepted')
        self.assertTrue(all(c['status'] == 'accepted' for c in run_workers(self.runtime, workers=2)['checkpoints']))
        for name, content in prior.items(): self.assertEqual((Path(self.plan['delivery_dir']) / name).read_bytes(),content)
        self.assertGreater(len(list(Path(self.plan['delivery_dir']).glob('*'))),len(prior))

    def test_heartbeat_updates_observation_without_changing_business_revision(self):
        token = self.runtime.claim('worker')
        before = self.runtime.status();self.runtime.heartbeat(token)
        after = self.runtime.status()
        self.assertEqual(before['revision'],after['revision'])
        self.assertGreater(after['observationSeq'],before['observationSeq'])
        root, _ = self.documents()
        self.assertEqual(json.loads((root/'execution.json').read_text())['observationSeq'],after['observationSeq'])

    def test_unknown_side_effect_still_blocks_acceptance_under_native_contract(self):
        token = self.runtime.claim('worker')
        key = self.runtime.prepare_operation(token, 'delivery', {'kind':'file','filename':'native.txt','content':'x'})
        with self.assertRaisesRegex(ValueError,'unreconciled'): self.runtime.finish(token, {'ok':True})
        self.runtime.dispatch(token,key,FileDelivery(self.base/'effects'))
        self.runtime.finish(token, {'ok':True})
        self.assertEqual(self.runtime.status()['checkpoints'][0]['status'],'accepted')

    def test_selected_path_executes_its_command_and_rejects_foreign_overrides(self):
        plan = copy.deepcopy(self.plan)
        plan['paths'][2]['commands'] = {'CP-A1': [sys.executable, '-c', 'import os; print("alternative:" + os.environ["OCW_PATH_ID"])']}
        runtime = Runtime.initialize(self.base / 'alternative', plan)
        runtime.decide_path('PATH-A-3', actor='owner', reason='execute alternative', expected_revision=runtime.status()['revision'], adopt=True)
        self.assertTrue(all(c['status'] == 'accepted' for c in run_workers(runtime, 3)['checkpoints']))
        delivery = list(Path(plan['delivery_dir']).glob('CP-A1-*.txt'))
        self.assertEqual(len(delivery),1)
        self.assertEqual(delivery[0].read_text().strip(),'alternative:PATH-A-3')
        plan['paths'][2]['commands']['CP-B1'] = ['true']
        with self.assertRaisesRegex(ValueError,'target-group'): graph_plan(plan)

    def test_restore_preserves_native_decisions_oracles_and_fences_old_attempt(self):
        from ocw_backup import create, restore
        code = self.base / 'code'; code.mkdir()
        (code / 'oracle.py').write_text('print("restored oracle passed")')
        (code / 'command.py').write_text('print("restored command ran")')
        plan = copy.deepcopy(self.plan)
        for cp in plan['checkpoints']:
            cp['cwd'] = str(code)
            cp['acceptance']['argv'] = [sys.executable,str(code / 'oracle.py')]
        plan['paths'][2]['commands'] = {'CP-A1':[sys.executable,str(code / 'command.py')]}
        runtime = Runtime.initialize(self.base / 'source',plan)
        runtime.decide_path('PATH-A-3',actor='owner',reason='selected alternative',expected_revision=1,adopt=True)
        old = runtime.claim('prior-host')
        archive = create({'items':[{'name':'runtime','kind':'runtime','path':str(runtime.root)},{'name':'code','kind':'files','path':str(code)}]},self.base/'backups')
        destination=self.base/'restored'; restore(archive['archive'],destination)
        restored=Runtime(destination/'runtime')
        self.assertTrue(restored.status()['restoreHold'])
        self.assertIsNone(restored.claim('replacement'))
        with self.assertRaisesRegex(ValueError,'fenced'): restored.finish(old,{'ok':True})
        restored_plan=restored.status()['plan']
        self.assertEqual(restored_plan['paths'][2]['commands']['CP-A1'][1],str(destination/'code/command.py'))
        self.assertEqual(restored_plan['checkpoints'][0]['acceptance']['argv'][1],str(destination/'code/oracle.py'))
        restored.activate_restore('Verified copied commands, independent oracle and local-only outputs')
        final=run_workers(restored,3)
        self.assertTrue(all(c['status']=='accepted' for c in final['checkpoints']))
        self.assertEqual(final['selections']['TR-A']['path_id'],'PATH-A-3')


if __name__ == '__main__': unittest.main()
