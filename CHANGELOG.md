# Changelog

Notable changes per release. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The data contracts version separately from the package and are **not** covered
by this file's semver: `ocw-plan-2`, `ocw-graph-2`, `ocw-harness-registry-1` and
the adapter's `ocw-console-4`. A change to any of those is called out
explicitly below.

## [Unreleased]

## [0.2.0] - 2026-09-15

This release is about making the project callable by someone who did not write
it. No runtime behaviour, wire format or on-disk contract changed.

### Added

- `LICENSE` and `NOTICE`: Apache-2.0. The project previously shipped with no
  license at all, which meant nobody could legally use it.
- `docs/plan-contract.md`: field-by-field reference for the plan JSON, stating
  what the validators actually enforce. This is now the only place numeric
  bounds are written down.
- `docs/api.md` and `docs/openapi.json`: the HTTP contract in prose and in
  machine-readable form.
- `tests/api-contract.test.mjs`: checks a live adapter against
  `docs/openapi.json` in both directions, so a response field cannot be added
  or removed without failing the suite. Covers both projection branches — a
  synthetic OCW-protocol source and a real executed `ocw-plan-2` runtime.
- `scripts/snapshot-projection.mjs`: the pure projection layer, split out of
  `server.mjs` and exported as `ocw-harness/snapshot-projection`, so another
  frontend can render this data without running the adapter.
- `tests/snapshot-projection.test.mjs`: unit tests for the projection rules
  that carry the project's honesty claims — status provenance, group acceptance
  never posing as per-checkpoint acceptance, assignment history never counting
  as liveness, and inherited edge ownership being labelled as inherited. Also
  asserts every `exports` entry imports, since a stale entry would only break
  for the external consumer.
- `examples/quickstart/`: a plan that actually runs — three checkpoints, two
  groups, two competing paths into the second — plus `run.sh` that executes it
  end to end, and a walkthrough that shows how to break a checkpoint on
  purpose. CI runs it.
- `pyproject.toml`: the Python side is now installable, with `ocw-runtime`,
  `ocw-backup` and `ocw-registry` console entry points, which CI also
  exercises. `Runtime` is a supported way to drive execution from your own
  scheduler.
- `exports` in `package.json`, exposing the reusable Node modules.
- `CONTRIBUTING.md`, `.nvmrc`, `.editorconfig`, `engines`, and this file.

### Changed

- `server.mjs` is 917 lines instead of 1513; the projection logic it used to
  hold is now importable. Verified as a pure move: every relocated line is
  byte-identical, and a pre/post API capture differs only in the source digest.
- `README.md` is rewritten in English around tasks rather than rendering
  vocabulary, and documents the three ways to call the project.
- `docs/native-graph-v2.md` is translated to English and now explains
  behaviour, leaving field definitions to `docs/plan-contract.md`.
- The Python CLIs (`ocw_runtime.py`, `ocw_backup.py`, `harness_registry.py`)
  use real subcommands, so `--help` on a subcommand shows only that
  subcommand's options instead of every flag in the tool.
- `init.sh` usage lists every subcommand. `runtime`, `backup`, `service` and
  `supervise` existed but were absent from the help text.
- Tests moved from `scripts/` to `tests/`, separating what ships from what
  verifies it.
- `npm run check` builds before testing. It previously tested first, so a stale
  UI build made a supervisor test fail for a reason unrelated to the change
  under test.
- `examples/quickstart/run.sh` exits with the runtime's own status instead of
  always exiting 0, so it is usable as a check.
- The package is named `ocw-harness` (was `ocw-workflow-console`) and is no
  longer `private`.
- The macOS bundle identifier and launchd label no longer hardcode one
  developer's reverse-DNS prefix. `OCW_BUNDLE_PREFIX` overrides it, defaulting
  to `io.github.wcboy`. A service is now located by kind and name whatever
  prefix installed it, so an existing service stays addressable across the
  change — verified against two live launchd services, which `service status`
  still resolves under their original labels.

### Fixed

- `scripts/harness-registry.mjs` and `scripts/ui-release.mjs` did nothing —
  exiting 0 with no output — when invoked through a path containing a symlink,
  which on macOS includes anything under `/tmp`. Both main-module guards
  compared a `path.resolve`d `argv[1]` against `import.meta.url`, and `resolve`
  does not follow symlinks. Now share `isEntrypoint`, which compares real
  paths.

### Removed

- `public/README.md`, a Chinese duplicate of the root README that was copied
  into `dist/` and served as a web asset. It had already drifted.

### Migration

- Node tests: `node --test scripts/*.test.mjs` becomes `npm run test:node`.
- Python tests need `PYTHONPATH=scripts`; `npm run test:python` sets it.
- If you imported a test helper from `scripts/`, it is under `tests/` now.
  Nothing under `scripts/` that ships was renamed or moved.

## [0.1.0] - 2026-09-07

Initial publish: checkpoint executor, path-graph console, native `ocw-plan-2`
contract, registry, backup and restore.

[Unreleased]: https://github.com/wcboy/ocw-harness/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/wcboy/ocw-harness/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/wcboy/ocw-harness/releases/tag/v0.1.0
