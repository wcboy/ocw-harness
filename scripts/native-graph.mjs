import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

/** Strict current contract, with legacy derivation kept outside this module. */
export function validateNativeGraph(graph) {
  if (graph.schema_version !== 'ocw-graph-2') return false;
  const checkpoints = graph.checkpoints || [], groups = graph.coupling_bundles || [], edges = graph.dependency_dag?.edges || [], paths = graph.paths || [];
  const unique = (items, field) => { const ids = items.map(i => i[field]); if (!ids.length || ids.some(id => typeof id !== 'string' || !id) || new Set(ids).size !== ids.length) throw Error(`invalid graph identifiers: ${field}`); return new Set(ids); };
  const cpIds = unique(checkpoints, 'checkpoint_id'), groupIds = unique(groups, 'bundle_id'), edgeIds = unique(edges, 'edge_id'); unique(paths, 'path_id');
  if (new Set([...cpIds,...groupIds,...edgeIds,...paths.map(p=>p.path_id)]).size !== cpIds.size + groupIds.size + edgeIds.size + paths.length) throw Error('graph entities must have unique identities');
  const members = new Set(), targets = new Set();
  for (const group of groups) {
    if (group.policy !== 'all' || !group.units?.length || !graph.goal_tree.some(goal => goal.l1_id === group.goal_id)) throw Error('invalid ALL group');
    for (const id of group.units) { if (!cpIds.has(id) || members.has(id) || checkpoints.find(cp => cp.checkpoint_id === id).l1_id !== group.goal_id) throw Error('invalid or duplicated group member'); members.add(id); }
  }
  if (members.size !== cpIds.size) throw Error('ungrouped checkpoint');
  for (const edge of edges) {
    if (!groupIds.has(edge.to) || targets.has(edge.to) || edge.prerequisite_policy !== 'all' || !edge.from?.length || new Set(edge.from).size !== edge.from.length || edge.from.some(id => id !== 'ROOT' && !groupIds.has(id))) throw Error('invalid prerequisite transition');
    targets.add(edge.to);
    if (!paths.some(p => p.edge_id === edge.edge_id)) throw Error('missing path alternatives');
    if (edge.selection && !paths.some(p => p.edge_id === edge.edge_id && p.path_id === edge.selection.path_id)) throw Error('selection outside transition');
  }
  if (targets.size !== groupIds.size || paths.some(p => !edgeIds.has(p.edge_id) || !['pending', 'supported', 'refuted', 'invalidated'].includes(p.verdict))) throw Error('incomplete graph or unknown verdict');
  const seen = new Set(['ROOT']), used = new Set();
  for (const layer of graph.dependency_dag.topological_layers) {
    for (const id of layer) { const edge = edges.find(e => e.edge_id === id); if (!edge || used.has(id) || edge.from.some(source => !seen.has(source))) throw Error('invalid topological order'); used.add(id); }
    layer.forEach(id => seen.add(edges.find(e => e.edge_id === id).to));
  }
  if (used.size !== edges.length) throw Error('incomplete topology');
  for (const cp of checkpoints) {
    if (!['executable_oracle','legacy_command_receipt'].includes(cp.acceptance_policy)) throw Error('missing checkpoint acceptance policy');
    if (!['pending', 'running', 'accepted', 'failed', 'invalidated'].includes(cp.execution_status) || cp.depends_on?.some(id => !cpIds.has(id))) throw Error('invalid checkpoint state or dependency');
    if (cp.execution_status === 'accepted' && cp.acceptance_policy === 'executable_oracle' && !cp.acceptance) throw Error('missing independent acceptance');
    if (cp.acceptance && cp.execution_status === 'accepted' && cp.acceptance.record?.verdict !== 'pass') throw Error('accepted checkpoint lacks passing verdict');
    if (cp.acceptance && cp.acceptance.record?.checkpoint_id !== cp.checkpoint_id) throw Error('acceptance belongs to another checkpoint');
  }
  return true;
}

export const checkpointState = cp => ({ status: ({accepted:'complete', running:'active', failed:'attention', invalidated:'attention', pending:'pending'})[cp.execution_status] || 'pending', statusSource: 'runtime_checkpoint' });
export const aggregateStates = states => !states.length ? 'pending' : states.every(s => s === 'complete') ? 'complete' : states.includes('attention') ? 'attention' : states.includes('active') ? 'active' : 'pending';
export function nativePath(path, index) {
  return { id: path.path_id, edgeId: path.edge_id, label: path.label || path.path_id, shortLabel: path.short_label || path.label || path.path_id,
    order: index + 1, origin: 'runtime', category: '运行时方案', verdict: path.verdict,
    status: ({supported:'succeeded', refuted:'refuted', invalidated:'invalidated', pending:'inconclusive'})[path.verdict],
    selected: Boolean(path.selected) && !['refuted','invalidated'].includes(path.verdict), selection: path.selection,
    mechanism: path.mechanism || '', summary: path.reason || path.mechanism || '尚未记录方案说明', reason: path.reason || null,
    keyCost: null, claimScope: '本地执行合同', evidenceLevel: path.evidence ? 'runtime_record' : null, deploymentStatus: null, memoryRef: null,
    evidenceRef: path.evidence?.ref || null, evidence: path.evidence || null, attemptHistory: path.attempt_history || [], worker: null };
}

export async function validateNativeEvidence(graph, read) {
  if (graph.schema_version !== 'ocw-graph-2') return;
  const records = [...graph.checkpoints.map(cp=>cp.acceptance), ...graph.paths.flatMap(path=>[path.evidence, ...(path.attempt_history || []).map(a=>a.acceptance)])].filter(Boolean);
  for (const evidence of records) {
    if (!/^evidence\/[a-f0-9]{64}\.json$/.test(evidence.ref)) throw Error('invalid evidence reference');
    const raw = await read(evidence.ref);
    if (createHash('sha256').update(raw).digest('hex') !== evidence.sha256 || !isDeepStrictEqual(JSON.parse(raw),evidence.record)) throw Error('evidence summary does not match immutable record');
  }
}
