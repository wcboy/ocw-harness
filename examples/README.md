# Examples

## quickstart

A complete, runnable checkpoint plan. It creates everything under one scratch
directory and an isolated registry, so it cannot touch a real task or your
default registry.

```sh
./examples/quickstart/run.sh
```

Expected output:

```
  CP-INVENTORY     accepted
  CP-BASELINE      accepted
  CP-CROSSCHECK    accepted
revision: 16
delivered: CP-BASELINE-<digest>.txt, CP-CROSSCHECK-<digest>.txt, CP-INVENTORY-<digest>.txt
```

The plan is small but exercises the parts that are hard to infer from the
contract alone:

| Feature | Where to look |
|---|---|
| Two ALL groups, one AND join | `groups` and `transitions` in `make_plan.py` |
| In-group ordering vs parallelism | `CP-BASELINE` declares `depends_on: [CP-INVENTORY]`; without it both run in parallel |
| Alternative paths sharing endpoints | `PATH-VERIFY-FULL` and `PATH-VERIFY-SAMPLED` on `TR-VERIFY` |
| Per-path command override | `PATH-VERIFY-SAMPLED.commands` |
| Replay-safe work command | `checkpoint.py` prints deterministic bytes for a given input binding |
| Independent acceptance oracle | `acceptance.py` verifies the delivered file's digest, not the exit code |
| Input-bound delivery names | Delivered filenames carry `OCW_INPUT_DIGEST`, so invalidation re-delivers instead of colliding |

### Files

| File | Role |
|---|---|
| `run.sh` | Orchestrates plan → `init` → `run` → `status`, then prints console instructions |
| `make_plan.py` | Emits a valid `ocw-plan-2`; run it directly to inspect the JSON |
| `checkpoint.py` | The work command. Its stdout becomes one immutable delivery |
| `acceptance.py` | The acceptance oracle. Reads `$OCW_RESULT_FILE`, exits 0 to accept |

### Why the plan is generated rather than committed

`checkpoints[].cwd` must be an existing directory and `delivery_dir` must be
absolute, so no checked-in JSON is portable across machines. To read the shape
without running anything:

```sh
python3 examples/quickstart/make_plan.py --workspace "$PWD" | less
```

The field-by-field contract is in [docs/plan-contract.md](../docs/plan-contract.md).

### Trying the decision and invalidation paths

After `run.sh` finishes, the scratch directory holds an accepted runtime you can
experiment against. Both commands need the current revision, which is how they
refuse to act on stale reads:

```sh
runtime=/path/from/run.sh/output
revision=$(python3 scripts/ocw_runtime.py status --root "$runtime" | python3 -c 'import json,sys; print(json.load(sys.stdin)["revision"])')

# Adopt the alternative path. This re-decides the transition, which invalidates
# CP-CROSSCHECK and everything downstream of it, then requires re-acceptance.
python3 scripts/ocw_runtime.py decide-path --root "$runtime" \
  --path-id PATH-VERIFY-SAMPLED --adopt \
  --actor operator --reason 'trying the cheaper alternative' \
  --expected-revision "$revision"

python3 scripts/ocw_runtime.py run --root "$runtime" --workers 1
```

A failed command lands in the attempt history and does **not** refute a path.
Refutation is a separate, evidence-carrying decision:

```sh
python3 scripts/ocw_runtime.py decide-path --root "$runtime" \
  --path-id PATH-VERIFY-SAMPLED --verdict refuted \
  --actor operator --reason 'sampling missed a case' \
  --expected-revision "$revision" \
  --evidence-file /absolute/counterexample.json
```
