#!/usr/bin/env python3
"""Install/status/reset/remove only named OCW per-user macOS login services."""
import argparse
import json
import os
from pathlib import Path
import plistlib
import shutil
import socket
import subprocess
import sys
from ocw_runtime import atomic, encoded, identifier


def installed_label(kind, name):
    """Label of an already-installed service for this kind/name, whatever prefix installed it.

    A launchd label is immutable once loaded, so a service must stay addressable
    under the label it was installed with even after the bundle prefix changes.
    The service's identity is kind and name; the prefix only namespaces it.
    """
    agents = Path.home() / 'Library/LaunchAgents'
    if not agents.is_dir():
        return None
    found = sorted(path.name[:-len('.plist')] for path in agents.glob(f'*.ocw-{kind}-{name}.plist'))
    if len(found) > 1:
        raise ValueError(f'multiple services claim {kind}/{name}: {found}; remove the stale one first')
    return found[0] if found else None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['install', 'status', 'reset', 'remove'])
    parser.add_argument('--kind', choices=['console', 'executor'], default='console')
    parser.add_argument('--name', default='default')
    parser.add_argument('--registry', required=True)
    parser.add_argument('--runtime')
    parser.add_argument('--workers', type=int, default=2)
    parser.add_argument('--backup-config')
    parser.add_argument('--port', type=int, default=4173)
    parser.add_argument('--app', default=str(Path(__file__).resolve().parent.parent))
    parser.add_argument('--build-dir', help='Explicit prebuilt frontend directory, including a restored frontend item')
    parser.add_argument('--node', default=shutil.which('node'))
    args = parser.parse_args()
    if sys.platform != 'darwin':
        parser.error('macOS launchd only; use the foreground entry with your Linux service manager')
    identifier(args.name)
    # An existing service keeps the label it was installed under, so changing
    # OCW_BUNDLE_PREFIX cannot orphan one; a new install takes the current
    # prefix, and `install` still refuses a kind/name another prefix already holds.
    label = installed_label(args.kind, args.name) \
        or os.environ.get('OCW_BUNDLE_PREFIX', 'io.github.wcboy') + '.ocw-' + args.kind + '-' + args.name
    domain = f'gui/{os.getuid()}'
    plist = Path.home() / 'Library/LaunchAgents' / (label + '.plist')
    state = Path(args.registry).resolve().parent / 'services' / label
    target = domain + '/' + label
    if args.command == 'status':
        result = subprocess.run(['launchctl', 'print', target], capture_output=True, text=True)
        print(json.dumps({'installed': plist.exists(), 'loaded': result.returncode == 0, 'label': label, 'status': result.stdout or result.stderr}))
        return result.returncode
    if args.command in ('reset', 'remove'):
        saved = plistlib.loads(plist.read_bytes())
        if saved.get('Label') != label:
            raise ValueError('service identity mismatch')
        if args.command == 'remove':
            subprocess.run(['launchctl', 'bootout', target], check=True)
            plist.unlink()
        else:
            if args.kind == 'console':
                atomic(Path(saved['EnvironmentVariables']['OCW_SUPERVISOR_STATE']), encoded({'crashes': [], 'tripped': False}))
            subprocess.run(['launchctl', 'kickstart', '-k', target], check=True)
        print(json.dumps({'label': label, 'action': args.command}))
        return 0
    if plist.exists():
        raise ValueError('service already installed; inspect status or explicitly remove before replacing')
    app = Path(args.app).resolve()
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    environment = {'OCW_HARNESS_REGISTRY_DIR': str(Path(args.registry).resolve()),
                   'PATH': os.pathsep.join(dict.fromkeys([str(Path(args.node).parent), str(Path(sys.executable).parent), '/usr/bin', '/bin', '/usr/sbin', '/sbin']))}
    if args.kind == 'console':
        with socket.socket() as probe:
            if probe.connect_ex(('127.0.0.1', args.port)) == 0:
                raise ValueError('port occupied; verify and stop the exact existing OCW service before installing')
        if not Path(args.node).is_file() or not (app / 'scripts/supervise-console.mjs').is_file():
            raise ValueError('missing node or console supervisor')
        argv = [args.node, str(app / 'scripts/supervise-console.mjs')]
        environment.update(PORT=str(args.port), OCW_SUPERVISOR_STATE=str(state / 'circuit.json'))
        if args.build_dir:
            if not (Path(args.build_dir) / 'index.html').is_file():
                raise ValueError('prebuilt frontend index.html is missing')
            environment['OCW_BUILD_DIR'] = str(Path(args.build_dir).resolve())
        keep_alive = True  # The child-error breaker stays alive until an explicit reset.
    else:
        if not args.runtime or not (Path(args.runtime) / 'runtime.sqlite3').is_file():
            raise ValueError('initialized executor root required')
        argv = [sys.executable, str(app / 'scripts/ocw_runtime.py'), 'run', '--root', str(Path(args.runtime).resolve()),
                '--workers', str(args.workers), '--registry', environment['OCW_HARNESS_REGISTRY_DIR'], '--service-mode']
        keep_alive = {'SuccessfulExit': False}  # Includes SIGKILL; planned attention exits are handled below.
        if args.backup_config:
            argv.extend(['--backup-config', str(Path(args.backup_config).resolve())])
    definition = {'Label': label, 'ProgramArguments': argv, 'WorkingDirectory': str(app), 'EnvironmentVariables': environment,
                  'RunAtLoad': True, 'KeepAlive': keep_alive, 'ThrottleInterval': 30, 'AbandonProcessGroup': False,
                  'StandardOutPath': str(state / 'stdout.log'), 'StandardErrorPath': str(state / 'stderr.log')}
    plist.parent.mkdir(parents=True, exist_ok=True)
    atomic(plist, plistlib.dumps(definition))
    subprocess.run(['plutil', '-lint', str(plist)], check=True, capture_output=True)
    subprocess.run(['launchctl', 'bootstrap', domain, str(plist)], check=True)
    print(json.dumps({'label': label, 'plist': str(plist), 'logs': str(state), 'scope': 'current_user_login', 'kind': args.kind}))
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (ValueError, OSError, KeyError, subprocess.SubprocessError) as error:
        print('OCW service: ' + str(error), file=sys.stderr)
        sys.exit(1)
