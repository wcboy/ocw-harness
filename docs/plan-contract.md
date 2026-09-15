# Plan contract

Field-by-field reference for the JSON consumed by `ocw_runtime.py init --plan`.
This describes what the validators actually enforce. Where the enforced bound
differs from prose elsewhere in the repo, the bound here is the one in code.

Validation happens in two stages, both at `init` (and again on
`activate-restore`):

| Stage | Function | Enforces |
|---|---|---|
| 1 | `validate_plan` in `scripts/ocw_runtime.py` | Command safety, resource bounds, delivery directory |
| 2 | `graph_plan` in `scripts/ocw_graph.py` | Schema version, graph shape, membership, acyclicity, acceptance oracles |

A plan that fails either stage leaves no runtime directory behind.

## Top level

| Field | Required | Enforced constraint |
|---|---|---|
| `schema_version` | No | Absent, `"ocw-plan-1"`, or `"ocw-plan-2"`. Anything else is rejected. Absent and `ocw-plan-1` behave identically |
| `task_id` | Yes | Matches `[A-Za-z0-9_-]{1,100}` |
| `objective` | Yes | Free text; surfaced as the graph's root goal |
| `delivery_dir` | Yes | Must be an absolute path. Created on first delivery, so it need not exist yet |
| `checkpoints` | Yes | 1 to 1000 entries |
| `groups`, `transitions`, `paths` | Only in v2 | Rejected outright unless `schema_version` is `ocw-plan-2` |

Do not reuse a `task_id` for an unrelated job: it is part of the idempotent
operation key, so reuse collides with the previous job's delivery identity.

## `checkpoints[]`

| Field | Required | Enforced constraint |
|---|---|---|
| `id` | Yes | `[A-Za-z0-9_-]{1,100}`, unique, and in v2 also distinct from every group, transition and path id |
| `argv` | Yes | Nonempty array of nonempty strings |
| `cwd` | Yes | Must name an existing directory. The validator does not additionally require it to be absolute, but relative paths resolve against the calling process and are not reproducible — use absolute |
| `execution` | Yes | Must be exactly `"replay_safe"` |
| `depends_on` | No | Known checkpoint ids, never itself. A dependency in another group is only legal if that group appears in the target group's transition `from` |
| `acceptance` | Yes in v2 | See below. Not required for v1 plans, which fall back to command-and-receipt evidence |
| `max_attempts` | No | Default 3, range 1 to 20 |
| `timeout_seconds` | No | Default 300, range greater than 0 up to 86400 |
| `label` | No | Falls back to `objective`, then `id` |
| `objective` | No | Falls back to `id` |
| `invariants`, `postconditions` | No | Copied into the projected graph unchanged |

`execution: "replay_safe"` is a claim the caller makes, not a sandbox. The
runtime bounds time and output and will kill the process group, but it does not
contain what the command does. Use it only for local work you have authorized
and that tolerates being run again.

### `acceptance`

Required for every checkpoint in an `ocw-plan-2` plan.

| Field | Required | Enforced constraint |
|---|---|---|
| `version` | Yes | Truthy. Recorded with each verdict so evidence stays attributable to an oracle version |
| `argv` | Yes | Nonempty array of nonempty strings |
| `timeout_seconds` | No | Default 60, range greater than 0 up to 300. Enforced by `graph_plan` only |

The oracle runs as a separate process after the work command succeeds. Exit 0
accepts; any other exit code keeps the failure evidence and retries within
`max_attempts`. An independent command is not an independent auditor: this
satisfies G4, and the console will not report an R5 verdict that no auditor
produced.

## `groups[]` (v2)

| Field | Required | Enforced constraint |
|---|---|---|
| `id` | Yes | Globally unique, and never `ROOT` |
| `checkpoint_ids` | Yes | Nonempty, no duplicates. Every checkpoint must belong to exactly one group |
| `policy` | Yes | Must be exactly `"all"`. There is no any-of group |
| `label` | No | Falls back to `id` |
| `objective` | No | Falls back to `label`, then `id` |

Within a group, only explicit `depends_on` creates ordering. Everything else is
eligible to run in parallel.

## `transitions[]` (v2)

| Field | Required | Enforced constraint |
|---|---|---|
| `id` | Yes | Globally unique |
| `to` | Yes | A known group id. Exactly one transition per target group |
| `from` | Yes | Array of known group ids, unique, never equal to `to`. `[]` starts at ROOT. Several entries mean an AND join |
| `initial_path_id` | No | If present, must be a path belonging to this transition. A transition with no initial selection waits for a decision |

Every transition needs at least one path, and every group needs exactly one
incoming transition, so the group graph is total and acyclic.

## `paths[]` (v2)

| Field | Required | Enforced constraint |
|---|---|---|
| `id` | Yes | Globally unique |
| `transition_id` | Yes | A known transition. Paths on the same transition share endpoints and render as alternatives between the same two nodes |
| `short_label` | Yes | 1 to 32 characters |
| `label` | No | Falls back to `id` |
| `mechanism` | No | Free text shown in the inspector |
| `commands` | No | Object mapping checkpoint id to argv. Keys must be members of the transition's **target** group; each argv a nonempty string array |

A path may override the command for checkpoints in the group it leads into, and
only those. It cannot change another group's commands, and it never overrides
`cwd`, resource bounds or the acceptance oracle — those stay on the checkpoint.

## Command environment

The work command receives the parent environment plus:

| Variable | Meaning |
|---|---|
| `OCW_CHECKPOINT_ID` | The claimed checkpoint |
| `OCW_PATH_ID` | The currently selected path |
| `OCW_INPUT_DIGEST` | Digest of the checkpoint's input binding. Changes when an upstream checkpoint is invalidated |

The acceptance oracle instead receives:

| Variable | Meaning |
|---|---|
| `OCW_RESULT_FILE` | Path to JSON `{checkpoint_id, result, context}`. `result.receipt` carries the real delivery path and sha256 |

Commands inherit the environment, so do not put credentials in `argv` or rely on
the plan to hide them.

## Output and delivery

The work command's stdout becomes the content of one immutable delivery file in
`delivery_dir`, named `<checkpoint>-<inputDigest[:16]>.txt` for v2 plans. stderr
is merged into stdout. Limits:

| Stream | Limit |
|---|---|
| Work command output | 8 MiB. Exceeding it fails the attempt |
| Acceptance output | 1 MiB |

Deliveries are never overwritten. A re-run after invalidation gets a new input
digest and therefore a new filename, which is why the previous bytes survive.

## Exit codes

`ocw_runtime.py` returns:

| Code | Meaning |
|---|---|
| 0 | Success. For `run`, every checkpoint is `accepted` |
| 1 | Rejected input or an I/O, schema or database error. Also a post-run backup failure |
| 2 | `run` completed but at least one checkpoint is not `accepted` |

`--service-mode` remaps a non-zero result to 0 after printing to stderr, so a
supervisor treats "stopped for attention" as a normal stop instead of retrying.

## Minimal valid plan

The smallest plan that passes both validators. Replace both paths with real
absolute ones:

```json
{
  "schema_version": "ocw-plan-2",
  "task_id": "MINIMAL",
  "objective": "One checkpoint, one group, one path",
  "delivery_dir": "/absolute/delivery",
  "groups": [
    {"id": "GR-ONLY", "label": "Only", "policy": "all", "checkpoint_ids": ["CP-ONLY"]}
  ],
  "transitions": [
    {"id": "TR-ONLY", "from": [], "to": "GR-ONLY", "initial_path_id": "PATH-ONLY"}
  ],
  "paths": [
    {"id": "PATH-ONLY", "transition_id": "TR-ONLY", "label": "Direct", "short_label": "direct", "mechanism": "Authorized local replay-safe command"}
  ],
  "checkpoints": [
    {
      "id": "CP-ONLY",
      "label": "Do the thing",
      "objective": "Do the thing",
      "cwd": "/absolute/existing/dir",
      "argv": ["echo", "done"],
      "execution": "replay_safe",
      "depends_on": [],
      "acceptance": {"version": "v1", "argv": ["true"]}
    }
  ]
}
```

For a working multi-group version, see
[examples/quickstart](../examples/README.md).

## Decisions after init

The plan is immutable once initialized. Changing which path is adopted, or
recording a verdict, is a separate authenticated write that compares against the
current revision:

```sh
python3 scripts/ocw_runtime.py decide-path --root <root> \
  --path-id <path> [--adopt] [--verdict pending|supported|refuted|invalidated] \
  --actor <who> --reason <why> --expected-revision <n> \
  [--evidence-file /absolute/evidence.json]

python3 scripts/ocw_runtime.py invalidate-checkpoint --root <root> \
  --checkpoint-id <id> --actor <who> --reason <why> --expected-revision <n>
```

Both refuse a stale `--expected-revision`. Recording a `--verdict` additionally
requires `--evidence-file`; `--adopt` alone does not. Adoption and verdict are
independent: adopting a path draws it as flowing green but says nothing about
whether its checkpoints are accepted, and a failed command produces attempt
history rather than a refutation.

Re-deciding a transition, or invalidating a checkpoint, revokes that checkpoint
and its dependents, bumps the input generation and voids any running lease, so
an old worker can no longer commit.

> `--evidence` is a different flag and belongs to `activate-restore`, where it
> takes a free-text verification string rather than a JSON file.
