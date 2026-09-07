"""Versioned graph contract. Group membership, dependencies and alternatives are separate."""
import hashlib
import json
import re


def encode(value):
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')) + '\n').encode()


def layers(items, dependencies):
    remaining, seen, output = list(items), set(), []
    while remaining:
        ready = [item for item in remaining if set(dependencies(item)) <= seen]
        if not ready:
            raise ValueError('dependency cycle or unknown dependency')
        output.append(ready)
        seen.update(ready)
        remaining = [item for item in remaining if item not in seen]
    return output


def unique(items, name, limit=100):
    ids = [item['id'] for item in items]
    if not ids or len(ids) != len(set(ids)) or any(not isinstance(i, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,' + str(limit) + '}', i) for i in ids):
        raise ValueError('invalid or duplicate ' + name)
    return {item['id']: item for item in items}


def graph_plan(plan):
    """Legacy plans keep their meaning; v2 requires explicit groups and oracles."""
    cps = unique(plan['checkpoints'], 'checkpoint')
    native = plan.get('schema_version') == 'ocw-plan-2'
    if plan.get('schema_version') not in (None, 'ocw-plan-1', 'ocw-plan-2'):
        raise ValueError('unsupported plan schema')
    if not native:
        if any(key in plan for key in ('groups', 'transitions', 'paths')):
            raise ValueError('explicit graph requires schema_version=ocw-plan-2')
        groups = [{'id': 'BUNDLE-' + cid, 'label': cp.get('objective', cid), 'checkpoint_ids': [cid], 'policy': 'all'} for cid, cp in cps.items()]
        transitions = [{'id': 'EDGE-' + cid, 'from': ['BUNDLE-' + dep for dep in cp.get('depends_on', [])], 'to': 'BUNDLE-' + cid, 'initial_path_id': 'PATH-' + cid} for cid, cp in cps.items()]
        paths = [{'id': 'PATH-' + cid, 'transition_id': 'EDGE-' + cid, 'label': '计划执行', 'short_label': '计划执行', 'mechanism': '已授权的本地可重放命令'} for cid in cps]
    else:
        groups, transitions, paths = plan['groups'], plan['transitions'], plan['paths']
    limit = 100 if native else 110
    by_group, by_transition, by_path = unique(groups, 'group', limit), unique(transitions, 'transition', limit), unique(paths, 'path', limit)
    if native and (len(set(cps) | set(by_group) | set(by_transition) | set(by_path)) != len(cps) + len(by_group) + len(by_transition) + len(by_path)):
        raise ValueError('graph entity identifiers must be globally unique')
    if native and any(not isinstance(p.get('short_label'), str) or not 1 <= len(p['short_label']) <= 32 for p in paths):
        raise ValueError('paths require a concise short_label')
    if 'ROOT' in by_group or set(by_group) & set(cps):
        raise ValueError('group and checkpoint identifiers must be distinct from each other and ROOT')
    membership = {}
    for group in groups:
        members = group['checkpoint_ids']
        if group.get('policy') != 'all' or not members or len(members) != len(set(members)):
            raise ValueError('group requires nonempty unique members and policy=all')
        for cid in members:
            if cid not in cps or cid in membership:
                raise ValueError('unknown or repeated group member')
            membership[cid] = group['id']
    if set(membership) != set(cps):
        raise ValueError('every checkpoint must belong to exactly one group')
    incoming = {}
    for transition in transitions:
        to, sources = transition['to'], transition['from']
        if to not in by_group or to in incoming or len(sources) != len(set(sources)) or any(g not in by_group or g == to for g in sources):
            raise ValueError('transition requires one target, unique known prerequisites, one incoming transition per group')
        incoming[to] = transition
        alternatives = [p for p in paths if p['transition_id'] == transition['id']]
        if not alternatives or transition.get('initial_path_id') and transition['initial_path_id'] not in {p['id'] for p in alternatives}:
            raise ValueError('transition requires alternatives and an in-scope initial selection')
    if set(incoming) != set(by_group) or any(p['transition_id'] not in by_transition for p in paths):
        raise ValueError('incomplete group transitions or unknown path transition')
    for path in paths:
        commands = path.get('commands', {})
        members = by_group[by_transition[path['transition_id']]['to']]['checkpoint_ids']
        if not isinstance(commands, dict) or any(cid not in members or not isinstance(argv, list) or not argv or not all(isinstance(a, str) and a for a in argv) for cid, argv in commands.items()):
            raise ValueError('path commands must name target-group checkpoints and nonempty argv')
    group_layers = layers(by_group, lambda gid: incoming[gid]['from'])
    effective = {}
    for cid, cp in cps.items():
        deps = set(cp.get('depends_on', []))
        if deps - set(cps) or cid in deps:
            raise ValueError('unknown or self checkpoint dependency')
        source_groups = incoming[membership[cid]]['from']
        if any(membership[dep] != membership[cid] and membership[dep] not in source_groups for dep in deps):
            raise ValueError('cross-group dependency must be declared by the transition')
        deps.update(member for group in source_groups for member in by_group[group]['checkpoint_ids'])
        effective[cid] = sorted(deps)
        if native:
            oracle = cp.get('acceptance', {})
            if not 0 < oracle.get('timeout_seconds', 60) <= 300:
                raise ValueError('invalid acceptance timeout')
            if not oracle.get('version') or not isinstance(oracle.get('argv'), list) or not oracle['argv'] or not all(isinstance(a, str) and a for a in oracle['argv']):
                raise ValueError('v2 checkpoints require a versioned executable acceptance oracle')
    layers(cps, lambda cid: effective[cid])
    return {'native': native, 'groups': groups, 'transitions': transitions, 'paths': paths, 'membership': membership, 'dependencies': effective, 'layers': group_layers, 'incoming': incoming}


def project_graph(data, events):
    model = graph_plan(data['plan'])
    parsed = [json.loads(row['body']) for row in events]
    accepted_revisions = {e['payload']['attempt']: e['to_revision'] for e in parsed if e['type'] == 'checkpoint_accepted'}
    cps = {cp['id']: cp for cp in data['checkpoints']}
    attempts = {a['id']: a for a in data['attempts']}
    contexts = data.get('contexts', {})
    states = data.get('pathStates', {})
    selections = data.get('selections', {})
    graph = {'schema_version': 'ocw-graph-2', 'task_id': data['taskId'], 'root_goal': data['objective'], 'goal_tree': [], 'checkpoints': [], 'coupling_bundles': [], 'paths': [], 'dependency_dag': {'nodes': ['ROOT'] + [g['id'] for g in model['groups']], 'edges': [], 'topological_layers': [[model['incoming'][gid]['id'] for gid in layer] for layer in model['layers']], 'cycle_check': 'passed'}}
    files, assignments = {}, []
    def evidence(record):
        data = encode(record)
        digest = hashlib.sha256(data).hexdigest()
        ref = 'evidence/' + digest + '.json'
        files[ref] = data
        return {'ref': ref, 'sha256': digest, 'record': record}
    for group in model['groups']:
        gid = group['id']
        graph['goal_tree'].append({'l1_id': gid, 'label': group.get('label', gid), 'objective': group.get('objective', group.get('label', gid)), 'l2': group['checkpoint_ids']})
        graph['coupling_bundles'].append({'bundle_id': gid, 'goal_id': gid, 'units': group['checkpoint_ids'], 'policy': 'all'})
    for transition in model['transitions']:
        selection = selections.get(transition['id'])
        if transition['id'] not in selections and transition.get('initial_path_id'):
            selection = {'path_id': transition['initial_path_id'], 'revision': 1, 'actor': 'plan-author', 'reason': '计划中明确采用'}
        graph['dependency_dag']['edges'].append({'edge_id': transition['id'], 'from': transition['from'] or ['ROOT'], 'to': transition['to'], 'prerequisite_policy': 'all', 'selection': selection})
    for cid, cp in cps.items():
        spec = json.loads(cp['spec'])
        gid = model['membership'][cid]
        transition = model['incoming'][gid]
        result = json.loads(cp['result']) if cp['result'] else {}
        acceptance = result.get('acceptance')
        if cp['status'] == 'accepted':
            files['accepted/' + cid + '.json'] = encode({'checkpoint_id': cid, 'edge_id': transition['id'], 'accepted_at_revision': accepted_revisions.get(cp['attempt']), 'acceptance': acceptance, 'result': result})
        # v1 facts still have independent execution status but only command/receipt evidence.
        graph['checkpoints'].append({'checkpoint_id': cid, 'l1_id': gid, 'label': spec.get('label', spec.get('objective', cid)), 'objective': spec.get('objective', cid), 'depends_on': model['dependencies'][cid], 'execution_status': cp['status'], 'acceptance_oracle': spec.get('acceptance', {}).get('version', '命令成功且交付操作已确认'), 'acceptance': evidence(acceptance) if acceptance else None, 'acceptance_policy': 'executable_oracle' if model['native'] else 'legacy_command_receipt', 'invariants': spec.get('invariants', []), 'postconditions': spec.get('postconditions', [])})
        if cp['attempt']:
            attempt = attempts[cp['attempt']]
            context = contexts.get(cp['attempt'], {})
            assignments.append({'assignment_id': cp['attempt'], 'attempt_id': cp['attempt'], 'edge_id': transition['id'], 'checkpoint_ids': [cid], 'path_ids': [context['path_id']] if context.get('path_id') else [], 'agent_ref': attempt['owner'], 'worker_instance_id': attempt['owner'], 'lease_epoch': cp['epoch'], 'lease_expires_at': cp['expires'], 'status': 'active_executing' if cp['status'] == 'running' else cp['status']})
    for path in model['paths']:
        item = states.get(path['id'], {})
        transition = next(t for t in graph['dependency_dag']['edges'] if t['edge_id'] == path['transition_id'])
        selected = (transition.get('selection') or {}).get('path_id') == path['id'] and item.get('verdict') not in ('refuted', 'invalidated')
        history = []
        for attempt in data['attempts']:
            context = contexts.get(attempt['id'], {})
            if context.get('path_id') == path['id'] or not model['native'] and model['membership'][attempt['checkpoint']] == transition['to']:
                result = json.loads(attempt['result']) if attempt['result'] else {}
                history.append({k: attempt[k] for k in ('id', 'checkpoint', 'epoch', 'owner', 'started', 'ended', 'status')} | {'inputDigest': context.get('input_digest'), 'acceptance': evidence(result['acceptance']) if result.get('acceptance') else None})
        verdict = item.get('verdict', 'pending')
        if not model['native'] and all(cps[c]['status'] == 'accepted' for c in next(g for g in model['groups'] if g['id'] == transition['to'])['checkpoint_ids']):
            verdict = 'supported'
        graph['paths'].append({'path_id': path['id'], 'edge_id': path['transition_id'], 'label': path.get('label', path['id']), 'short_label': path.get('short_label', path.get('label', path['id'])), 'mechanism': path.get('mechanism', ''), 'verdict': verdict, 'selected': selected, 'selection': transition.get('selection'), 'reason': item.get('reason'), 'evidence': evidence(item['evidence']) if item.get('evidence') else None, 'attempt_history': history})
    state = {'task_id': data['taskId'], 'objective': data['objective'], 'revision': data['revision'], 'phase': parsed[-1]['to_phase'], 'updated_at': parsed[-1]['at'], 'next_action': '检查依赖、路径决策与单点验收', 'blockers': [o['key'] for o in data['operations'] if o['state'] in ('unknown', 'dispatching')], 'gate_status': {'G1': 'passed', 'G2': 'not_applicable', 'G3': 'not_applicable', 'G4': 'passed' if all(c['status'] == 'accepted' for c in cps.values()) else 'pending', 'G5': 'not_applicable'}, 'active_assignments': assignments, 'accepted_interfaces': []}
    execution = {key: data[key] for key in ('taskId', 'dataEpoch', 'revision')}
    execution['observationSeq'] = data.get('observationSeq', 0)
    execution.update({'engine': 'ocw-local-executor-2', 'backup': data['backupStatus'], 'restoreHold': data['restoreHold'], 'accepted': sum(c['status'] == 'accepted' for c in cps.values()), 'total': len(cps), 'interruptedAttempts': sum(a['status'] == 'interrupted' for a in data['attempts']), 'unknownOperations': len(state['blockers']), 'attempts': [{k: a[k] for k in ('id', 'checkpoint', 'epoch', 'owner', 'started', 'ended', 'status')} for a in data['attempts']]})
    files.update({'state.json': encode(state), 'checkpoint-graph.json': encode(graph), 'events.jsonl': b''.join(encode(e) for e in parsed), 'decision.json': encode({'task_id': data['taskId'], 'status': 'authorized_local_plan', 'path_selections': selections}), 'execution.json': encode(execution)})
    return files
