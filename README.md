# OCW Harness

Run a plan made of checkpoints, and watch it as a path graph.

A checkpoint is one replay-safe local command plus a **separate** command that
decides whether its output is acceptable. Checkpoints are grouped into layers
that must all pass, and the alternative ways of getting from one layer to the
next are drawn as competing paths between the same two nodes. Adopting a path
is a decision you record, with a reason and evidence — not something the
harness infers from a command exiting 0.

The point is that the console never shows you a green line that no oracle
produced. Status is projected from an append-only SQLite log, every status
carries the name of what produced it, and an expired worker lease reads as "not
working" rather than "still working".

```
        ┌──── GR-DRAFT ────┐                    ══ adopted (flowing green)
ROOT ═══│ CP-A  CP-B       │═══ direct ════╗    ── candidate (dashed)
        └──────────────────┘               ╠══> GR-REVIEW
                            ··· fallback ··╝    ✗  refuted (red)
```

## Try it in three commands

Needs Node.js 22.12+ and Python 3.10+ on macOS or Linux. The Python side is
standard library only.

```sh
npm ci
npm run ensure-ui
npm start
```

Then open <http://127.0.0.1:4173/?demo=paths> for a playable demo you can pause
and step. The demo renders through the real renderer and is labelled as
synthetic; it never reads a live task. The root page lists registered runtimes,
and is empty until you register one.

## Run a real plan

```sh
./examples/quickstart/run.sh /tmp/ocw-demo
```

That builds a four-checkpoint plan across three groups with two competing
paths, executes it, and prints the command to point the console at the result.
[examples/README.md](examples/README.md) walks through what each file does and
shows how to break a checkpoint on purpose to watch the failure surface.

To write your own plan, the enforced schema is in
[docs/plan-contract.md](docs/plan-contract.md) — every field, every bound, and a
minimal plan that validates. Then:

```sh
python3 scripts/ocw_runtime.py init --root /absolute/new-runtime --plan /absolute/plan.json
python3 scripts/ocw_runtime.py run  --root /absolute/new-runtime --workers 3
python3 scripts/ocw_runtime.py status --root /absolute/new-runtime
```

`init` refuses an existing directory, and a plan that fails validation leaves
nothing behind. Every command has `--help`.

## Watch a runtime you already have

Registration is observation only: it never creates or edits task state.

```sh
node scripts/harness-registry.mjs register --source /absolute/runtime-root --session session-a
```

The registry, console and executor must all agree on one registry directory.
`OCW_HARNESS_REGISTRY_DIR` overrides the default, which is what you want for
tests and for running two consoles side by side.

## Call it from your own code

Three supported entry points, in increasing order of coupling:

**HTTP, read-only.** Every route is GET or HEAD; nothing mutates canonical
state. [docs/api.md](docs/api.md) is the prose contract and
[docs/openapi.json](docs/openapi.json) the machine-readable one, which
`tests/api-contract.test.mjs` checks against a live server in both directions,
so a field cannot appear or vanish without failing the suite.

```sh
curl -s localhost:4173/api/registry | jq '.registrations[].registrationId'
curl -s "localhost:4173/api/snapshot?harness=$ID" | jq '.metrics'
```

**Python, to drive execution yourself.** `pip install -e .` and `Runtime`
becomes the surface for claiming, heartbeating and finishing work under your own
scheduler instead of `run`'s worker pool.

```python
from ocw_runtime import Runtime

runtime = Runtime('/absolute/runtime-root')
token = runtime.claim('my-scheduler-1')      # None when nothing is ready
if token:
    # token['spec']['argv'] is the command, already resolved for the adopted path
    runtime.heartbeat(token)                 # before the 30s lease expires
    runtime.finish(token, {'exitCode': 0, 'output': '...'}, True)
```

`finish` is refused if your lease expired or the checkpoint was invalidated
while you worked, which is the mechanism that stops a slow worker from
committing a stale result.

**Node, to project state into a different frontend.**
`scripts/snapshot-projection.mjs` turns canonical on-disk shapes into the UI
wire format with no filesystem, network or process access, so you can render
this data somewhere else without adopting `server.mjs`. See the `exports` map in
`package.json` for what is public.

## Documentation

| Document | Answers |
|---|---|
| [docs/plan-contract.md](docs/plan-contract.md) | What may I put in a plan, and what will be rejected? |
| [docs/api.md](docs/api.md) | What does the HTTP adapter promise? |
| [docs/native-graph-v2.md](docs/native-graph-v2.md) | How do groups, paths, decisions and invalidation behave? |
| [RUNTIME-RELIABILITY.md](RUNTIME-RELIABILITY.md) | Leases, heartbeats, supervision, idempotent delivery, backup and restore. |
| [CONTRIBUTING.md](CONTRIBUTING.md) | How do I build, test and change a contract? |
| [SKILL.md](SKILL.md) | Optional agent entry point that reuses these same scripts. |

Numeric bounds live in `docs/plan-contract.md` and nowhere else, so that the
code and the docs can only disagree in one place.

## Development

```sh
npm run check                       # build, Node + Python tests, typecheck
npx playwright install chromium && npm run e2e
```

`check` covers the graph contract, projection, concurrency, invalidation,
acceptance, recovery, the HTTP contract, types and the build. `e2e` drives a
real browser against a synthetic fixture and an isolated registry, never a real
task; set `OCW_E2E_PORT` to avoid collisions.

Layout: `src/` is the only UI, `server.mjs` the read-only adapter,
`scripts/snapshot-projection.mjs` the pure projection layer,
`scripts/ocw_runtime.py` the optional executor, `scripts/ocw_graph.py` plan
validation, `scripts/ocw_backup.py` verified backup and restore.

`ensure-ui` compares source and build fingerprints and rebuilds only when they
differ. Re-run it after changing `src/` and restart your own console process.
`PORT` and `OCW_BUILD_DIR` override the defaults; a released checkout ships
`dist/`.

To start a new console from the current design rather than a stale copy:

```sh
python3 scripts/scaffold_console.py --reference /absolute/ocw-harness --destination /absolute/new-console
```

It excludes local task labels, registry data and prebuilt output.

## Limits

`execution: "replay_safe"` is a claim you make about your own command. The
runtime bounds time and output and kills the process group, but it does not
contain what the command does — this is not a sandbox, only authorized local
execution.

Lease protection covers this harness's own commits and delivery boundary. An
external side effect is only safe if the destination itself supports an
idempotency key and an authoritative lookup; when a result is unknown it must be
reconciled, not retried blindly. Restore always writes to a new directory and
pauses for a human to check deliveries and old-host isolation before resuming.

A separate acceptance command is not a separate auditor. It gives you evidence
attributable to an oracle version, which is why the console declines to report a
final verdict that no auditor produced.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
