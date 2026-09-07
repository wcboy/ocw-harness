---
name: ocw-harness
description: Build, bind, inspect or maintain the OCW checkpoint harness and its realtime path UI. Use for grouped checkpoints, alternative paths, agent ownership, concurrent execution, snapshot synchronization or harness recovery; not for ordinary dashboards.
---

# OCW Harness

Use this repository as the implementation, not a frozen code template. Read `ui-release.json` first. Preserve the current `checkpoint-paths-2` design: one left-to-right graph, dashed ALL regions with independent checkpoint points, and expandable alternatives sharing the same endpoints. Adopted paths flow green, pending paths are dashed, refuted paths are red with a cross. Keep labels short and details in a dismissible inspector. The `?demo=paths` example uses the same renderer and must retain its simulation identity.

## Choose the relevant contract

- For setup, registration, verification and generation, read [README.md](README.md).
- Before changing plans, paths, checkpoint evidence, ownership or the UI adapter, read [docs/native-graph-v2.md](docs/native-graph-v2.md).
- Before changing leases, synchronization, supervision, delivery or recovery, read [RUNTIME-RELIABILITY.md](RUNTIME-RELIABILITY.md).

Inspect the explicitly chosen runtime root and its declared references. Do not search the machine for tasks, transcribe one task's IDs into code, or initialize over a historical root. Use `scripts/scaffold_console.py` for a new console; it copies the maintained renderer and runtime together without task data.

## Preserve the boundaries

The browser and server only observe canonical state. Keep GET/HEAD enforcement, root containment checks, immutable generation verification and explicit degraded fallback. Registry metadata is separate from execution authority. Match task, source, session, runtime instance and binding; an old heartbeat must not reopen a closed registration.

Resolve ownership at path, checkpoint, then enclosing edge scope. Confirm liveness separately from assignment history. Missing or expired ownership cannot count as confirmed work; terminal tasks have zero current workers. Show the actual evidence scope: native per-checkpoint acceptance, historical edge acceptance, phase inference or demo. Do not invent a verdict or R5 completion.

SSE and one-second non-overlapping GET remain active together. Reject retired selections, bindings and older epoch/revision/observation frames. Only a newer recovery epoch allows a lower canonical revision. Check source and build hashes before reuse; retain the selected task/checkpoint across a newer UI release.

Runtime mutations go through `Runtime` and its SQLite write guards. Commands require explicit replay safety; local leases do not sandbox arbitrary programs or intercept third-party tools. Unknown external effects block replay and acceptance until authoritative destination lookup. Keep path decisions separate from verdicts, use expected revisions, and invalidate dependent evidence and old attempts when inputs change.

Restore only into a new directory, expire restored leases/registrations and hold execution. Inspect the restore report, command paths, delivery state, unknown operations and original executor before activation. Observer recovery is not executor takeover; a login service is not availability before login.

## Verify the changed surface

Run the relevant existing tests, `npm run check` for shared runtime/adapter changes, and `npm run e2e` for UI/transport changes. Keep new browser regressions reproducible with synthetic roots and isolated registries. Verify folding, path states, scope-specific workers and mobile overflow when editing the graph. A desktop launch additionally needs actual foreground browser evidence; a connected client alone does not prove visibility.

Report observed binding, behavior and recovery evidence separately. Do not equate a local demo, passed test, backup archive or Git push with a production execution guarantee.
