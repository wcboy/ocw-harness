// Contract tests for the pure projection layer.
//
// These target the claims the project makes about honesty rather than the
// happy path: that a status always says where it came from, that group-level
// acceptance is never presented as per-checkpoint acceptance, that an
// assignment's history is not liveness, and that an edge-level owner is
// labelled as inherited instead of reported as direct ownership. Each of those
// is a one-line change away from silently overstating what the console knows,
// and none of them is covered by the end-to-end tests, which only see the
// rendered result.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  checkpointStatusForGoal,
  normalizeAgentActivity,
  phaseProgress,
  resolveWorker,
  stageStatus,
  validateEventChain,
} from '../scripts/snapshot-projection.mjs';

const app = resolve(import.meta.dirname, '..');

test('every module the package advertises can actually be imported', async () => {
  // The README tells callers to read `exports` for what is public. An entry
  // pointing at a moved or missing file only fails for the external consumer,
  // who gets a resolution error we would never see from inside the repo.
  const { exports: map } = JSON.parse(await readFile(join(app, 'package.json'), 'utf8'));
  assert.ok(map['./snapshot-projection'], 'the projection layer is documented as reusable, so it must be exported');
  for (const [entry, target] of Object.entries(map)) {
    const loaded = await import(join(app, target)).catch(error => error);
    assert.ok(!(loaded instanceof Error), `${entry} -> ${target} failed to import: ${loaded.message}`);
    assert.ok(Object.keys(loaded).length > 0, `${entry} -> ${target} exports nothing`);
  }
});

test('a goal status always reports the provenance it was derived from', () => {
  const topology = { executionStates: new Map([['L1-RUNTIME', 'complete']]), byGoalId: new Map([['L1-EDGE', { edgeId: 'EDGE-1' }]]) };
  const acceptedEdges = new Map([['EDGE-1', { ref: 'accepted/EDGE-1.json' }]]);

  // A real executor verdict outranks everything else and says so.
  assert.deepEqual(checkpointStatusForGoal('L1-RUNTIME', acceptedEdges, 'implementing', topology),
    { status: 'complete', statusSource: 'runtime_checkpoint' });

  // An accepted edge record is edge-scoped and carries no per-checkpoint
  // verdict, so it must never claim to be one.
  assert.deepEqual(checkpointStatusForGoal('L1-EDGE', acceptedEdges, 'implementing', topology),
    { status: 'complete', statusSource: 'edge_accepted' });

  // With no evidence at all the status is inferred from the phase, and is
  // labelled as inference rather than presented as knowledge.
  assert.deepEqual(checkpointStatusForGoal('L1-UNKNOWN', acceptedEdges, 'exploring', topology),
    { status: 'active', statusSource: 'phase_inferred' });
  assert.deepEqual(checkpointStatusForGoal('L1-UNKNOWN', acceptedEdges, 'implementing', topology),
    { status: 'pending', statusSource: 'phase_inferred' });
});

test('an accepted edge does not mark a goal complete once the executor disagrees', () => {
  // Same goal, both sources present: the executor's pending state wins over
  // the accepted edge, so a stale acceptance cannot show a finished node.
  const topology = { executionStates: new Map([['L1-BOTH', 'pending']]), byGoalId: new Map([['L1-BOTH', { edgeId: 'EDGE-1' }]]) };
  const { status, statusSource } = checkpointStatusForGoal('L1-BOTH', new Map([['EDGE-1', { ref: 'x' }]]), 'implementing', topology);
  assert.equal(status, 'pending');
  assert.equal(statusSource, 'runtime_checkpoint');
});

test('assignment history is not liveness', () => {
  const state = {
    phase: 'implementing',
    updated_at: '2026-09-15T00:00:00Z',
    assignments: [
      { assignment_id: 'ASG-R4-LIVE', status: 'executing' },
      { assignment_id: 'ASG-R4-DONE', status: 'accepted' },
      { assignment_id: 'ASG-R4-BROKEN', status: 'failed' },
      { assignment_id: 'ASG-R4-QUEUED', status: 'unknown' },
      { assignment_id: 'ASG-R4-OLD', status: 'executing invalidated_history' },
    ],
  };
  const activity = normalizeAgentActivity(state);
  const byId = new Map(activity.assignments.map(a => [a.assignmentId, a]));

  assert.equal(activity.workingCount, 1, 'only the executing assignment counts as working');
  assert.equal(byId.get('ASG-R4-LIVE').working, true);
  assert.equal(byId.get('ASG-R4-DONE').working, false);
  assert.equal(byId.get('ASG-R4-BROKEN').workState, 'attention');
  assert.equal(byId.get('ASG-R4-QUEUED').workState, 'queued');
  assert.equal(byId.has('ASG-R4-OLD'), false, 'invalidated history is dropped, not shown as work');
  assert.equal(byId.get('ASG-R4-LIVE').phase, 'R4', 'phase comes from the assignment id');
});

test('a terminal task has no working agents however its assignments read', () => {
  // A finished task whose assignment rows still say "executing" must not keep
  // reporting live workers; this is the failure mode that makes a console lie
  // about what is happening right now.
  const assignments = [{ assignment_id: 'ASG-R4-STUCK', status: 'executing' }];
  assert.equal(normalizeAgentActivity({ phase: 'implementing', assignments }).workingCount, 1);
  for (const phase of ['complete', 'completed', 'failed', 'terminated', 'cancelled', 'interrupted']) {
    assert.equal(normalizeAgentActivity({ phase, assignments }).workingCount, 0, `${phase} must report no working agents`);
  }
});

test('a working assignment wins the index over a finished one on the same node', () => {
  const state = { phase: 'implementing', assignments: [
    { assignment_id: 'ASG-R4-OLD', status: 'accepted', checkpoint_ids: ['CP-1'], path_ids: ['PATH-1'], edge_id: 'EDGE-1' },
    { assignment_id: 'ASG-R4-NOW', status: 'executing', checkpoint_ids: ['CP-1'], path_ids: ['PATH-1'], edge_id: 'EDGE-1' },
  ] };
  const activity = normalizeAgentActivity(state);
  assert.equal(activity.byCheckpoint.get('CP-1').assignmentId, 'ASG-R4-NOW');
  assert.equal(activity.byPath.get('PATH-1').assignmentId, 'ASG-R4-NOW');
  assert.equal(activity.byEdge.get('EDGE-1').assignmentId, 'ASG-R4-NOW');
});

test('worker resolution reports the scope it matched and flags inheritance', () => {
  const state = { phase: 'implementing', assignments: [
    { assignment_id: 'ASG-R2-PATH', status: 'executing', path_ids: ['PATH-1'] },
    { assignment_id: 'ASG-R4-CP', status: 'executing', checkpoint_ids: ['CP-1'] },
    { assignment_id: 'ASG-R2-EDGE', status: 'executing', edge_id: 'EDGE-1', checkpoint_ids: ['CP-OWNED'], path_ids: [] },
  ] };
  const activity = normalizeAgentActivity(state);

  assert.equal(resolveWorker(activity, { pathId: 'PATH-1' }).scope, 'path');
  assert.equal(resolveWorker(activity, { checkpointId: 'CP-1' }).scope, 'checkpoint');
  assert.equal(resolveWorker(activity, { pathId: 'PATH-1', checkpointId: 'CP-1' }).scope, 'path',
    'the most specific scope wins');
  assert.equal(resolveWorker(activity, { pathId: 'PATH-1' }).inherited, false);

  // An assignment that declares checkpoint ids is indexed per checkpoint, so
  // asking about one of them matches at checkpoint scope even when an edge is
  // also supplied -- the edge index is the fallback, not a competing answer.
  assert.equal(resolveWorker(activity, { edgeId: 'EDGE-1', checkpointId: 'CP-OWNED' }).scope, 'checkpoint');

  // Resolving the edge itself is the case that owns its node outright.
  const edgeOwner = resolveWorker(activity, { edgeId: 'EDGE-1' });
  assert.equal(edgeOwner.scope, 'edge');
  assert.equal(edgeOwner.inherited, false);

  assert.equal(resolveWorker(null, { pathId: 'PATH-1' }), null);
  assert.equal(resolveWorker(activity, { checkpointId: 'CP-NOBODY' }), null);
});

test('a native graph refuses an edge owner that does not cover the node', () => {
  // `agentActivity.native` is set by the caller after normalizeAgentActivity
  // returns -- server.mjs does it in buildSnapshot. Without it the legacy
  // branch runs, which attaches an edge owner to a checkpoint it does not
  // claim and only marks it inherited. Any other caller of this module has to
  // set the same flag, so both branches are pinned here.
  const state = { phase: 'implementing', assignments: [
    { assignment_id: 'ASG-R2-EDGE', status: 'executing', edge_id: 'EDGE-1', checkpoint_ids: ['CP-OWNED'] },
  ] };

  const legacy = normalizeAgentActivity(state);
  const inherited = resolveWorker(legacy, { edgeId: 'EDGE-1', checkpointId: 'CP-ELSEWHERE' });
  assert.equal(inherited.scope, 'edge');
  assert.equal(inherited.inherited, true, 'legacy sources show the owner as inherited');

  const native = Object.assign(normalizeAgentActivity(state), { native: true });
  assert.equal(resolveWorker(native, { edgeId: 'EDGE-1', checkpointId: 'CP-ELSEWHERE' }), null,
    'a native graph has precise checkpoint ids, so a non-covering edge owner is not reported at all');
});

test('the event chain reports gaps rather than smoothing them over', () => {
  const sound = [
    { event_id: 'E1', from_revision: 0, to_revision: 1, from_phase: 'decomposing', to_phase: 'exploring' },
    { event_id: 'E2', from_revision: 1, to_revision: 2, from_phase: 'exploring', to_phase: 'implementing' },
  ];
  assert.deepEqual(validateEventChain(sound, { revision: 2, phase: 'implementing' }), { healthy: true, issues: [] });

  // A skipped revision, a phase that does not continue the previous event, a
  // state revision that disagrees with the event count, and a tail phase that
  // disagrees with the state are each reported separately.
  const torn = [
    { event_id: 'E1', from_revision: 0, to_revision: 1, from_phase: 'decomposing', to_phase: 'exploring' },
    { event_id: 'E2', from_revision: 5, to_revision: 6, from_phase: 'auditing', to_phase: 'complete' },
  ];
  const { healthy, issues } = validateEventChain(torn, { revision: 9, phase: 'implementing' });
  assert.equal(healthy, false);
  assert.deepEqual(issues, [
    'revision gap at E2',
    'phase gap at E2',
    'state revision does not equal event count',
    'event tail phase does not equal state phase',
  ]);
});

test('an empty chain is only healthy at revision zero', () => {
  assert.equal(validateEventChain([], { revision: 0, phase: 'decomposing' }).healthy, true);
  assert.deepEqual(validateEventChain([], { revision: 3, phase: 'decomposing' }).issues,
    ['state revision does not equal event count']);
});

test('a recorded gate verdict outranks being the active phase', () => {
  assert.equal(stageStatus('passed', true), 'complete');
  assert.equal(stageStatus('failed', true), 'attention');
  assert.equal(stageStatus('blocked', false), 'attention');
  assert.equal(stageStatus('rework_required', true), 'attention');
  assert.equal(stageStatus(undefined, true), 'active');
  assert.equal(stageStatus(undefined, false), 'pending');
  assert.equal(stageStatus('PASS', false), 'complete', 'gate status is matched case-insensitively');
});

test('phase progress stays at zero for phases with nothing to measure', () => {
  const empty = { checkpoint_summary: {}, edge_summary: {}, user_gate: {}, route_index: [], gate_status: {} };
  assert.equal(phaseProgress('R2', empty, {}), 0);
  assert.equal(phaseProgress('R3', empty, {}), 0);
  assert.equal(phaseProgress('R4', empty, { features: [] }), 0);
  assert.equal(phaseProgress('R5', empty, {}), 0);

  assert.equal(phaseProgress('R2', { edge_summary: { total: 4, exploration_complete: 1 } }, {}), 25);
  assert.equal(phaseProgress('R4', empty, { features: [{ passes: true }, { passes: false }] }), 50);
  assert.equal(phaseProgress('R5', { gate_status: { G5: 'passed' } }, {}), 100);

  // R1, R3 and R5 report a fixed partial value for "started but not finished"
  // because there is nothing countable underneath them.
  assert.equal(phaseProgress('R1', empty, {}), 24);
  assert.equal(phaseProgress('R1', { checkpoint_summary: { l1_total: 3 } }, {}), 100);
  assert.equal(phaseProgress('R3', { route_index: ['ROUTE-1'], user_gate: {} }, {}), 72);
  assert.equal(phaseProgress('R3', { user_gate: { status: 'selected' } }, {}), 100);
  assert.equal(phaseProgress('R5', { phase: 'auditing', gate_status: {} }, {}), 76);
});
