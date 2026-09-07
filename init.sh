#!/bin/sh
set -eu

cd "$(dirname "$0")"

case "${1:-}" in
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

command -v node >/dev/null 2>&1
command -v npm >/dev/null 2>&1

if [ ! -d node_modules ]; then
  npm install
fi

case "${1:-check}" in
  check)
    npm run typecheck
    ;;
  dev)
    exec npm run dev
    ;;
  run)
    exec ./scripts/run-bound-ui.sh "${2:-}"
    ;;
  serve)
    exec ./scripts/run-bound-ui.sh "${2:-}"
    ;;
  desktop)
    exec ./scripts/install-desktop-launcher.sh "${2:-$HOME/Desktop/OCW Harness.app}"
    ;;
  *)
    printf 'usage: ./init.sh [check|dev|run|serve|desktop|register|registry|heartbeat|close] [path-or-id] [session-id]\n' >&2
    exit 2
    ;;
esac
