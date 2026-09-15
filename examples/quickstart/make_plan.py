#!/usr/bin/env python3
"""Emit a valid `ocw-plan-2` for the quickstart walkthrough.

A plan is generated rather than committed as a static file because
`checkpoints[].cwd` must be an existing directory and `delivery_dir` must be
absolute, so no checked-in JSON can be portable. `docs/plan-contract.md` is the
field-by-field reference; this script is the runnable one.

    python3 make_plan.py --workspace /absolute/workspace > plan.json
"""
import argparse
import json
from pathlib import Path
import sys

HERE = Path(__file__).resolve().parent


def make_plan(workspace):
    """Two ALL groups joined by one transition that carries two alternatives."""
    workspace = Path(workspace).resolve()
    work = [sys.executable, str(HERE / 'checkpoint.py')]
    oracle = {'version': 'quickstart-delivery-v1', 'argv': [sys.executable, str(HERE / 'acceptance.py')], 'timeout_seconds': 60}

    def checkpoint(cid, objective, claim, depends_on=()):
        return {
            'id': cid,
            'label': objective,
            'objective': objective,
            'cwd': str(workspace),
            'argv': work + [claim],
            'execution': 'replay_safe',
            'depends_on': list(depends_on),
            'max_attempts': 3,
            'timeout_seconds': 120,
            'acceptance': oracle,
        }

    return {
        'schema_version': 'ocw-plan-2',
        'task_id': 'QUICKSTART',
        'objective': 'Demonstrate ALL groups, an AND join and alternative paths',
        'delivery_dir': str(workspace / 'delivery'),
        # Every checkpoint belongs to exactly one group; a group completes only
        # when all of its members are accepted (policy is always "all").
        'groups': [
            {'id': 'GR-SURVEY', 'label': 'Survey', 'policy': 'all', 'checkpoint_ids': ['CP-INVENTORY', 'CP-BASELINE']},
            {'id': 'GR-VERIFY', 'label': 'Cross-check', 'policy': 'all', 'checkpoint_ids': ['CP-CROSSCHECK']},
        ],
        # One incoming transition per group. `from: []` starts at ROOT; several
        # source groups would mean an AND join.
        'transitions': [
            {'id': 'TR-SURVEY', 'from': [], 'to': 'GR-SURVEY', 'initial_path_id': 'PATH-SURVEY-DIRECT'},
            {'id': 'TR-VERIFY', 'from': ['GR-SURVEY'], 'to': 'GR-VERIFY', 'initial_path_id': 'PATH-VERIFY-FULL'},
        ],
        # Alternatives share the same endpoints, so the UI draws them between
        # the same two nodes. `commands` may override argv for checkpoints in
        # the transition's target group only.
        'paths': [
            {'id': 'PATH-SURVEY-DIRECT', 'transition_id': 'TR-SURVEY', 'label': 'Direct survey',
             'short_label': 'direct', 'mechanism': 'Run both survey checkpoints with their default commands'},
            {'id': 'PATH-VERIFY-FULL', 'transition_id': 'TR-VERIFY', 'label': 'Full cross-check',
             'short_label': 'full', 'mechanism': 'Re-derive the record from the delivered survey artifacts'},
            {'id': 'PATH-VERIFY-SAMPLED', 'transition_id': 'TR-VERIFY', 'label': 'Sampled cross-check',
             'short_label': 'sampled', 'mechanism': 'Cheaper alternative kept pending until a decision adopts it',
             'commands': {'CP-CROSSCHECK': work + ['sampled-crosscheck']}},
        ],
        'checkpoints': [
            checkpoint('CP-INVENTORY', 'List the inputs', 'inventory'),
            # An in-group dependency orders these two; without it they run in parallel.
            checkpoint('CP-BASELINE', 'Record a baseline', 'baseline', depends_on=['CP-INVENTORY']),
            checkpoint('CP-CROSSCHECK', 'Cross-check the survey', 'full-crosscheck'),
        ],
    }


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--workspace', required=True, help='Existing absolute directory used as command cwd')
    arguments = parser.parse_args()
    print(json.dumps(make_plan(arguments.workspace), indent=2))
