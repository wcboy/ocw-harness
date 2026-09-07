import assert from 'node:assert/strict';
import test from 'node:test';
import { validateNativeGraph, checkpointState, aggregateStates, nativePath, validateNativeEvidence } from './native-graph.mjs';
const fixture = () => ({schema_version:'ocw-graph-2', goal_tree:[{l1_id:'g1'}],coupling_bundles:[{bundle_id:'g1',goal_id:'g1',units:['cp1','cp2'],policy:'all'}],checkpoints:[{checkpoint_id:'cp1',l1_id:'g1',execution_status:'accepted',acceptance_policy:'legacy_command_receipt'},{checkpoint_id:'cp2',l1_id:'g1',execution_status:'running',acceptance_policy:'legacy_command_receipt'}],paths:[{path_id:'p1',edge_id:'e1',verdict:'pending',selected:true}],dependency_dag:{edges:[{edge_id:'e1',from:['ROOT'],to:'g1',prerequisite_policy:'all',selection:{path_id:'p1'}}],topological_layers:[['e1']]}});
test('native graph preserves independently accepted and running members', () => {
 const graph=fixture();assert.equal(validateNativeGraph(graph),true);
 assert.deepEqual(graph.checkpoints.map(checkpointState).map(c=>c.status),['complete','active']);
 assert.equal(aggregateStates(graph.checkpoints.map(checkpointState).map(c=>c.status)),'active');
 assert.equal(aggregateStates([]),'pending');
});
test('malformed ALL graphs and out-of-scope decisions fail closed', () => {
 for (const mutate of [g=>g.coupling_bundles[0].units.push('cp1'),g=>g.coupling_bundles[0].units.pop(),g=>g.dependency_dag.edges.push({...g.dependency_dag.edges[0],edge_id:'e2'}),g=>g.dependency_dag.edges[0].selection.path_id='missing',g=>g.dependency_dag.topological_layers=[],g=>g.paths[0].verdict='assumed']) {
  const graph=fixture();mutate(graph);assert.throws(()=>validateNativeGraph(graph));
 }
});
test('path failure history does not override a distinct verdict or invent adoption', () => {
 const raw={path_id:'p',edge_id:'e',label:'Full mechanism',short_label:'机制',selected:false,verdict:'pending',attempt_history:[{status:'failed'}]};
 const path=nativePath(raw,0);assert.equal(path.status,'inconclusive');assert.equal(path.shortLabel,'机制');assert.equal(path.attemptHistory.length,1);assert.equal(path.selected,false);
 assert.equal(nativePath({...raw,selected:true,verdict:'refuted'},0).selected,false);
});

test('acceptance requires a matching independent record and verified bytes',async()=>{
 const graph=fixture();graph.checkpoints[0].acceptance_policy='executable_oracle';
 assert.throws(()=>validateNativeGraph(graph),/missing independent/);
 const record={checkpoint_id:'cp1',verdict:'pass'},raw=JSON.stringify(record);
 const {createHash}=await import('node:crypto');const sha256=createHash('sha256').update(raw).digest('hex');
 graph.checkpoints[0].acceptance={record,sha256,ref:`evidence/${sha256}.json`};
 assert.equal(validateNativeGraph(graph),true);
 await validateNativeEvidence(graph,async()=>raw);
 await assert.rejects(validateNativeEvidence(graph,async()=>JSON.stringify({...record,verdict:'fail'})),/does not match/);
 graph.checkpoints[0].acceptance.record={...record,checkpoint_id:'cp2'};
 assert.throws(()=>validateNativeGraph(graph),/another checkpoint/);
});
