# Native graph and execution contract v2

The design version is declared in `ui-release.json`, currently
`checkpoint-paths-2`. The graph contract is `ocw-graph-2` and the plan contract
is `ocw-plan-2`.

This document explains how the pieces *behave*: what a group means, what
adopting a path does, what invalidation revokes. For the field list and the
enforced bounds, see [plan-contract.md](plan-contract.md) — the numbers live
there and only there, so code and prose can disagree in at most one place.

## Shape

**Groups** are layers of checkpoints that must all pass. Every checkpoint
belongs to exactly one group. Inside a group, only an explicit `depends_on`
creates ordering; everything else may run in parallel.

**Transitions** connect groups. A group has exactly one incoming transition, so
the graph is total and acyclic. A transition with several entries in `from` is
an AND join: all those groups must complete. An empty `from` starts at ROOT.

**Paths** are the alternative ways to take one transition. Because they share a
transition they share endpoints, which is why they render as competing lines
between the same two nodes rather than as separate branches. A path may override
the `argv` of checkpoints in the group it leads *into*, and only those. It never
overrides working directory, resource bounds or the acceptance oracle — those
stay on the checkpoint, so swapping paths cannot quietly relax how the work is
judged.

## Execution and acceptance

A checkpoint's work command reads `OCW_PATH_ID`, `OCW_CHECKPOINT_ID` and
`OCW_INPUT_DIGEST`. Its stdout becomes the bytes of one immutable delivery file.

The acceptance oracle runs afterwards as a **separate process** and reads the
JSON at `OCW_RESULT_FILE`: `{checkpoint_id, result, context}`, where
`result.receipt` carries the real delivery path and digest. Exit 0 accepts; any
other exit code keeps the failure evidence and retries. An oracle should open
the delivered artifact and check it, not merely observe that the work command
exited 0 — that is the whole reason it is a separate command.

The generator and the oracle may be different local programs, or an external
scheduler may drive `Runtime.claim` / `heartbeat` / `finish` directly. But an
independent command is not an independent auditor: when no auditor has produced
a final verdict, the console does not invent one.

## Decisions, invalidation and history

```sh
python3 scripts/ocw_runtime.py decide-path --root <root> --path-id <path> \
  [--adopt] [--verdict pending|supported|refuted|invalidated] \
  --actor <who> --reason <why> --expected-revision <n> [--evidence-file <json>]
```

The write compares `--expected-revision` against the current revision and
rejects a stale one, so two actors cannot both believe they decided. Recording a
verdict requires structured evidence.

**Adoption and verdict are independent.** A flowing green line means someone
adopted that path. It does not mean its checkpoints are accepted, and it does
not mean an agent is working. Candidates are dashed; a refutation is a red line
with a cross. A failed command produces attempt history — it does not refute a
path by itself, because a command can fail for reasons that say nothing about
the approach.

Changing the conclusion on a selected path, selecting a different path, or
`invalidate-checkpoint` revokes the affected checkpoints and their dependents,
bumps the input generation, and voids any running lease. An old worker then
cannot commit, renew, or call a protected delivery. Re-acceptance runs with a
new input digest and therefore a new delivery filename, which is exactly why the
previous bytes and acceptance history survive. Re-confirming an adoption you
already hold is still a new decision and still triggers re-acceptance, so do not
submit it idly.

Every attempt pins `checkpoint / attempt / worker / lease epoch`, the selected
path, the path decision revision, the upstream acceptance digest, the command
digest, the oracle version and the input generation. All of it is re-checked
against the live lease immediately before the result is committed. The v2
idempotency key is `task / checkpoint / operation / inputDigest`, so retries of
the same input share a key. An unknown external result must still be
reconciled; changing paths is not a licence to replay blindly.

## Projection and live observation

SQLite is the executable source of truth. The exporter writes hash-verified
immutable generations and switches `ocw-head.json` last, so a reader never sees
a half-written generation. `ocw-graph-2` states each checkpoint's
`execution_status` and `acceptance_policy`, its acceptance record reference and
digest, and per stable path the verdict, selection and attempt history. The
adapter validates structure and evidence bytes, and deliberately does not infer
that every checkpoint in a group is complete from the group being complete.

An agent must report precise `checkpoint_ids` / `path_ids`, `attempt_id`,
`worker_instance_id` and `lease_epoch` / `lease_expires_at`. Precision does not
propagate: a claim about one checkpoint says nothing about another. An expired
lease is not "working", though its history remains attributable.

Heartbeats increment `observationSeq` and publish, without faking a business
revision. The browser rejects a stale `dataEpoch`, a stale revision, a stale
source observation sequence within the same revision, a stale adapter response
sequence, and a retired binding. SSE and the one-second GET run together
without overlapping requests. A recovered runtime's new `dataEpoch` is allowed
to carry an older revision, and an open page keeps its selection across the
change.

## Compatibility, recovery and staying current

v1 plans remain readable and executable, projected as single-checkpoint groups
with a stable `PATH-{checkpoint}` and marked `legacy_command_receipt`. Older
protocol files keep being shown at their historical evidence granularity: the
original files are not rewritten and per-checkpoint acceptance is not
fabricated. To use multi-checkpoint groups and independent acceptance, write a
v2 plan for a new execution instance — do not edit a historical immutable plan
in place.

Restore targets a new directory. The restore script rewrites path arguments it
can see — declared `cwd`, work command, path command overrides and acceptance
command — preserves historical bytes, voids old leases, and pauses. An operator
confirms scripts, dependencies, delivery files, old-host isolation and any
unknown operations before activating. Paths embedded inside a `-c` string cannot
be rewritten reliably, so pass them as arguments to a standalone script instead.

Treat the maintained reference checkout as the only UI template; historical
commits are change evidence, not a source to copy from.
`scripts/scaffold_console.py --reference <reference> --destination <new-dir>`
copies the current renderer, runtime and entry points without historical data or
prebuilt pages. Run `npm ci` in the new directory and register a source
explicitly before starting.

`ui-release.json` is the design and contract version; `ui-build.json` records
the source fingerprint and the index and JS/CSS hashes. Entry points run
`ensure-ui`, which builds in isolation and then publishes when source and output
do not match; an old adapter is never reused just because the port matches. The
page checks the build version every five seconds, keeps your selection across a
refresh, and auto-refreshes at most once for the same new fingerprint. Shipping
prebuilt output is only safe while source and config fingerprints match —
restoring into a location that changes the config needs a rebuild.

## Verification

`npm run check` covers the native graph, path decisions, per-checkpoint
acceptance, leases, idempotency, recovery, synchronization, the HTTP contract,
types and the build. `npm run e2e` additionally drives a real browser against an
isolated registry and a synthetic fixture; `?demo=paths` is a clearly labelled
demo that never connects to a real task API.

A new design must keep: competing lines between shared endpoints, the red
cross / dashed / flowing-green vocabulary, all-required-checkpoints groups, a
single collapsible detail panel, and canvas scrolling on mobile.
