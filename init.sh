#!/bin/sh
# Single dispatcher for the OCW harness. Run without arguments for help.
set -eu

cd "$(dirname "$0")"

usage() {
  cat <<'EOF'
usage: ./init.sh <command> [arguments]

Executor and plans (Python, standard library only)
  runtime <args>              scripts/ocw_runtime.py -- init, run, status, publish,
                              decide-path, invalidate-checkpoint, activate-restore
  backup <args>               scripts/ocw_backup.py -- create, verify, restore
  service <args>              scripts/manage-service.py -- macOS login service

Registry (task and session registration; metadata only, never write authority)
  register <root> [session]   Register an existing canonical or executor root
  registry                    List every registration in the active registry
  heartbeat <id> <instance> <seq>
                              Report liveness with a strictly increasing sequence
  close <id> <instance>       Close a registration

Console (Node)
  dev                         Vite dev server with the read-only adapter
  run [workflow-root]         Guarded launcher: verify the build, bind, open a browser
  serve [workflow-root]       Alias of run
  supervise                   Run the adapter under the restart supervisor
  desktop [app-path]          Install the macOS desktop launcher
                              (default: ~/Desktop/OCW Harness.app)

Verification
  check                       npm run check -- tests, typecheck and build
  typecheck                   npm run typecheck only

Each subcommand forwards --help where the underlying tool provides one, for
example `./init.sh runtime --help`. Port is taken from $PORT (default 4173) and
the registry from $OCW_HARNESS_REGISTRY_DIR.
EOF
}

case "${1:-help}" in
  help|-h|--help)
    usage
    exit 0
    ;;
  runtime)
    shift
    exec python3 ./scripts/ocw_runtime.py "$@"
    ;;
  backup)
    shift
    exec python3 ./scripts/ocw_backup.py "$@"
    ;;
  service)
    shift
    exec python3 ./scripts/manage-service.py "$@"
    ;;
  register)
    command -v node >/dev/null 2>&1
    exec node ./scripts/harness-registry.mjs register --source "${2:?usage: ./init.sh register <canonical-root> [session-id]}" --session "${3:-${CODEX_THREAD_ID:-${CODEX_SESSION_ID:-default}}}"
    ;;
  registry)
    command -v node >/dev/null 2>&1
    exec node ./scripts/harness-registry.mjs list
    ;;
  supervise)
    exec node ./scripts/supervise-console.mjs
    ;;
  heartbeat)
    command -v node >/dev/null 2>&1
    exec node ./scripts/harness-registry.mjs heartbeat --id "${2:?registration-id required}" --instance "${3:?instance-id required}" --seq "${4:?increasing sequence required}"
    ;;
  close)
    command -v node >/dev/null 2>&1
    exec node ./scripts/harness-registry.mjs close --id "${2:?registration-id required}" --instance "${3:?instance-id required}"
    ;;
esac

# Everything below needs the npm toolchain, so dependencies are resolved first.
command -v node >/dev/null 2>&1
command -v npm >/dev/null 2>&1

if [ ! -d node_modules ]; then
  npm install
fi

case "$1" in
  check)
    exec npm run check
    ;;
  typecheck)
    exec npm run typecheck
    ;;
  dev)
    exec npm run dev
    ;;
  run|serve)
    exec ./scripts/run-bound-ui.sh "${2:-}"
    ;;
  desktop)
    exec ./scripts/install-desktop-launcher.sh "${2:-$HOME/Desktop/OCW Harness.app}"
    ;;
  *)
    printf 'unknown command: %s\n\n' "$1" >&2
    usage >&2
    exit 2
    ;;
esac
