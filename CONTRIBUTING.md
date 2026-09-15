# Contributing

## Setup

Node.js 22.12+ (see `.nvmrc`), npm, and Python 3.10+. The Python executor uses
only the standard library, so there is nothing to install for it.

```sh
npm ci
npm run check
```

Run the quickstart once before changing anything — it is the fastest way to see
the whole pipeline and it proves your toolchain works:

```sh
./examples/quickstart/run.sh
```

## Layout

| Path | Contents |
|---|---|
| `src/` | The only UI. React + TypeScript, built by Vite |
| `server.mjs` | Read-only HTTP adapter. Serves the API and the built SPA |
| `scripts/*.mjs` | Node libraries the adapter imports, plus a few CLI entry points |
| `scripts/ocw_runtime.py` | Optional executor. SQLite owns the facts |
| `scripts/ocw_graph.py` | Plan validation and projection to the graph contract |
| `scripts/ocw_backup.py` | Verified backup and restore-into-a-new-directory |
| `scripts/harness_registry.py` | Registry writer. Node delegates writes to it |
| `tests/` | Everything that verifies the above |
| `docs/` | The contracts: plan, graph, API |
| `examples/` | Runnable examples |

## Verification

Run the narrowest thing that covers your change, then the wider gate before
opening a pull request.

| Command | Covers | Needs |
|---|---|---|
| `node --test tests/<file>.test.mjs` | One Node module | — |
| `python3 -m unittest tests.test_ocw_runtime` | Executor behavior | — |
| `npm run typecheck` | `src/` types | — |
| `npm run check` | All unit tests, typecheck and build | — |
| `npm run e2e` | Real browser behavior | `npx playwright install chromium` |

`npm run check` is what CI runs first, followed by `npm run e2e`. Both must pass.

Use `OCW_BUILD_DIR=/absolute/isolated/dir` when verifying locally if you have a
desktop launcher or login service serving a bundle you do not want overwritten.
Use `OCW_E2E_PORT` if 4321 is taken.

## What the tests must not do

Browser and runtime tests build synthetic roots in temporary directories and use
an isolated `OCW_HARNESS_REGISTRY_DIR`. A test must never register against a real
task, write into a canonical workflow root, or depend on your default registry.
If a regression needs a fixture, add it to `tests/e2e-fixture.mjs` rather than
pointing a test at real data.

## Changing a contract

Changes to any of these are contract changes and need the corresponding document
updated in the same commit:

| If you change | Update |
|---|---|
| Plan validation in `validate_plan` or `graph_plan` | `docs/plan-contract.md` |
| Projected graph shape in `project_graph` | `docs/native-graph-v2.md` |
| Any HTTP response shape | `docs/api.md` and `src/types.ts` |
| Leases, delivery, recovery, supervision | `RUNTIME-RELIABILITY.md` |

The wire format is currently produced in `server.mjs` and hand-mirrored in
`src/types.ts`. Until those share a generated source, treat both plus
`docs/api.md` as one edit.

## Boundaries worth preserving

These are load-bearing, not stylistic. A change that removes one needs to say so
explicitly:

- The browser and adapter only ever read canonical state. `GET` and `HEAD` are the
  only accepted methods and every ref-driven read is contained in the workflow root.
- Registry metadata is not execution authority. An expired or missing lease cannot
  count as confirmed work, and a closed registration cannot be reopened by an old
  heartbeat.
- Evidence keeps its real scope. Do not infer per-checkpoint acceptance from group
  completion, and do not report an R5 verdict that no auditor produced.
- Restore writes into a new directory and holds execution until someone activates
  it with verification evidence.

## Reporting

A useful report includes the observed binding (`GET /api/health`), what you ran,
and what you saw — kept separate from what you concluded. A passing local demo, a
green test run and a backup archive are each evidence of themselves and not of a
production guarantee.
