# Changelog

Notable changes per release. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The data contracts version separately from the package and are **not** covered
by this file's semver: `ocw-plan-2`, `ocw-graph-2`, `ocw-harness-registry-1` and
    10|the adapter's `ocw-console-4`. A change to any of those is called out
explicitly below.

## [Unreleased]

## [0.2.0] - 2026-09-15

This release is about making the project callable by someone who did not write
it. No runtime behaviour, wire format or on-disk contract changed.

    20|### Added

- `LICENSE` and `NOTICE`: Apache-2.0. The project previously shipped with no
  license at all, which meant nobody could legally use it.
- `docs/plan-contract.md`: field-by-field reference for the plan JSON, stating
  what the validators actually enforce. This is now the only place numeric
  bounds are written down.
- `docs/api.md` and `docs/openapi.json`: the HTTP contract in prose and in
  machine-readable form.
- `tests/api-contract.test.mjs`: checks a live adapter against
  `docs/openapi.json` in both directions, so a response field cannot be added
    30|  or removed without failing the suite.
- `examples/quickstart/`: a plan that actually runs — four checkpoints, three
  groups, two competing paths — plus `run.sh` that executes it end to end, and
  a walkthrough that shows how to break a checkpoint on purpose.
- `pyproject.toml`: the Python side is now installable, with `ocw-runtime`,
  `ocw-backup` and `ocw-registry` console entry points. `Runtime` is a
  supported way to drive execution from your own scheduler.
- `exports` in `package.json`, exposing the reusable Node modules.
- `CONTRIBUTING.md`, `.nvmrc`, `.editorconfig`, `engines`, and this file.

    40|### Changed

- `README.md` is rewritten in English around tasks rather than rendering
  vocabulary, and documents the three ways to call the project.
- `docs/native-graph-v2.md` is translated to English and now explains
  behaviour, leaving field definitions to `docs/plan-contract.md`.
- The Python CLIs (`ocw_runtime.py`, `ocw_backup.py`, `harness_registry.py`)
  use real subcommands, so `--help` on a subcommand shows only that
  subcommand's options instead of every flag in the tool.
- `init.sh` usage lists every subcommand. `runtime`, `backup`, `service` and
    50|  `supervise` existed but were absent from the help text.
- Tests moved from `scripts/` to `tests/`, separating what ships from what
  verifies it.
- `npm run check` builds before testing. It previously tested first, so a
  stale UI build made a supervisor test fail for a reason unrelated to the
  change under test.
- The package is named `ocw-harness` (was `ocw-workflow-console`) and is no
  longer `private`.

### Migration

    60|- Node tests: `node --test scripts/*.test.mjs` becomes `npm run test:node`.
- Python tests need `PYTHONPATH=scripts`; `npm run test:python` sets it.
- If you imported a test helper from `scripts/`, it is under `tests/` now.
  Nothing under `scripts/` that ships was renamed or moved.

## [0.1.0] - 2026-09-07

Initial publish: checkpoint executor, path-graph console, native `ocw-plan-2`
contract, registry, backup and restore.

[Unreleased]: https://github.com/wcboy/ocw-harness/compare/v0.2.0...HEAD
    70|[0.2.0]: https://github.com/wcboy/ocw-harness/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/wcboy/ocw-harness/releases/tag/v0.1.0
