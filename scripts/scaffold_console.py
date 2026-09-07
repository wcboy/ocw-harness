#!/usr/bin/env python3
"""Create a new console from the maintained source, never a frozen old UI template."""
import argparse
import json
from pathlib import Path
import shutil


def scaffold(reference, destination):
    reference, destination = Path(reference).resolve(), Path(destination).resolve()
    release = json.loads((reference / 'ui-release.json').read_text())
    if release.get('designVersion') != 'checkpoint-paths-2' or release.get('graphContract') != 'ocw-graph-2':
        raise ValueError('reference does not provide the current parallel-path UI contract')
    for required in ['src/graph-layout.ts', 'src/components/OrthogonalJourney.tsx', 'scripts/ocw_graph.py', 'scripts/ensure-ui.mjs']:
        if not (reference / required).is_file():
            raise ValueError('incomplete latest UI source: ' + required)
    destination.mkdir(parents=True, exist_ok=False)
    for directory in ['src','scripts','desktop','public','docs','.github']:
        if (reference / directory).is_dir():
            shutil.copytree(reference / directory, destination / directory, ignore=shutil.ignore_patterns('__pycache__','.DS_Store','*.log'))
    for name in ['server.mjs','init.sh','index.html','package.json','package-lock.json','tsconfig.json','tsconfig.node.json','vite.config.ts','ui-release.json','harness-ui.json']:
        shutil.copy2(reference / name, destination / name)
    for name in ['README.md', 'SKILL.md', 'RUNTIME-RELIABILITY.md', '.gitignore']:
        if (reference / name).is_file():
            shutil.copy2(reference / name, destination / name)
    config = json.loads((destination / 'harness-ui.json').read_text())
    config['frontend_dir'] = 'dist'
    (destination / 'harness-ui.json').write_text(json.dumps(config, ensure_ascii=False, indent=2) + '\n')
    # Task-specific labels, registry records, canonical state and prebuilt assets
    # deliberately do not enter the new console.
    (destination / 'labels').mkdir()
    if (reference / 'labels/README.md').is_file():
        shutil.copy2(reference / 'labels/README.md', destination / 'labels/README.md')
    (destination / 'TEMPLATE-SOURCE.json').write_text(json.dumps({'reference':str(reference), **release},indent=2)+'\n')
    return {'destination':str(destination), **release}


if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--reference', required=True)
    parser.add_argument('--destination', required=True)
    args=parser.parse_args()
    print(json.dumps(scaffold(args.reference,args.destination),ensure_ascii=False))
