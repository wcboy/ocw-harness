#!/usr/bin/env bash
# End-to-end quickstart: plan -> init -> run -> register -> inspect.
#
# Everything is created under one scratch directory and an isolated registry,
# so this never touches a real task or the default registry.
#
#   ./examples/quickstart/run.sh [scratch-dir]
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
scratch="${1:-$(mktemp -d "${TMPDIR:-/tmp}/ocw-quickstart.XXXXXX")}"

workspace="$scratch/workspace"
runtime_root="$scratch/runtime"
registry="$scratch/registry"
mkdir -p "$workspace" "$registry"

python3 "$here/make_plan.py" --workspace "$workspace" > "$scratch/plan.json"
echo "plan:     $scratch/plan.json"

# `init` refuses an existing directory, so the runtime root must not be created above.
python3 "$repo/scripts/ocw_runtime.py" init --root "$runtime_root" --plan "$scratch/plan.json" > "$scratch/init.json"
echo "runtime:  $runtime_root"

# Two workers claim independent leases; CP-BASELINE waits for CP-INVENTORY and
# CP-CROSSCHECK waits for the whole GR-SURVEY group.
set +e
python3 "$repo/scripts/ocw_runtime.py" run --root "$runtime_root" --workers 2 --registry "$registry" > "$scratch/run.json"
run_status=$?
set -e

python3 "$repo/scripts/ocw_runtime.py" status --root "$runtime_root" > "$scratch/status.json"

python3 - "$scratch/status.json" "$workspace/delivery" <<'PY'
import json, pathlib, sys
state = json.loads(pathlib.Path(sys.argv[1]).read_text())
for checkpoint in state['checkpoints']:
    print(f"  {checkpoint['id']:<16} {checkpoint['status']}")
print(f"revision: {state['revision']}")
deliveries = sorted(p.name for p in pathlib.Path(sys.argv[2]).glob('*.txt'))
print('delivered: ' + (', '.join(deliveries) or '(none)'))
PY

if [ "$run_status" -ne 0 ]; then
  echo "run exited $run_status (2 means some checkpoint is not accepted)" >&2
fi

cat <<EOF

Inspect it in the console. Both commands need the same isolated registry,
otherwise the console reads your default one and shows nothing:

  cd "$repo"
  npm ci && npm run ensure-ui
  export OCW_HARNESS_REGISTRY_DIR="$registry"
  node scripts/harness-registry.mjs register --source "$runtime_root" --session quickstart
  npm start
  # then open http://127.0.0.1:4173

Scratch directory (safe to delete): $scratch
EOF

# Propagate the run's own exit code so this is usable as a check, not just a demo.
exit "$run_status"
