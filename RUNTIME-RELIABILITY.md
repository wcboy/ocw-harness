# Runtime reliability

The browser and HTTP adapter observe canonical OCW files read-only. An optional separate Python CLI now executes explicitly initialized local checkpoint plans. It does not intercept arbitrary tools or retrofit historical protocol tasks.

The adapter needs Node.js; registry writes use Python 3 with POSIX flock (macOS/Linux, standard library only). The Node registration API/CLI delegates to `scripts/harness_registry.py`; the portable checkpoint-harness-ui skill uses an identical copy. Set `OCW_PYTHON` for Node calls only if python3 is not on PATH.

Registration returns `registrationId` and `instanceId`. Keep both in the owning runtime. Heartbeat must include a strictly increasing sequence:

```sh
node scripts/harness-registry.mjs register --source /path/to/.agent-workflow --session session-a --pid 12345
./init.sh heartbeat harness-... returned-instance-id 1
./init.sh close harness-... returned-instance-id
```

A closed or replaced instance cannot heartbeat. A fresh process/run uses `register --new-instance`; this changes the metadata instance, not canonical write authority. Legacy registrations are readable and upgraded on explicit registration. Duplicate legacy identities are reported, not automatically deleted. The registration key uses realpath, session ID and task ID; source identity drift becomes a source error.

`./init.sh supervise` starts the adapter under a supervisor. It retries its own crashed child with backoff and stops after five failures in 60 seconds. With `OCW_SUPERVISOR_STATE`, the circuit persists and waits for an explicit reset. `./init.sh service install --registry /absolute/registry` installs the macOS current-user login service: launchd also recovers a crashed supervisor. It refuses an occupied port; inspect and stop the exact known prior service first. Use `service status`, `service reset` after fixing a fault, or `service remove` with the same registry/kind/name. Login service scope does not imply a privileged service available before login.

Liveness is distinct from assignment state. Initial viewer registration without verified PID/start identity or sequence heartbeats is unknown. Heartbeats within 30 seconds are live, 30–90 seconds suspect, older lost. Failed/cancelled tasks are distinct from successful completion. Worker totals deduplicate per canonical source; missing session attribution is explicitly task-shared.

Canonical facts are cached per source/task, with discovered file dependencies watched for changes. Connection/session/liveness fields are computed per response. Source builds have bounded concurrency and caller timeouts; a timed-out build is not duplicated while pending. Verified observations are atomically saved with a checksum under `registry/.snapshots`; an adapter restart plus source corruption can still serve a visibly degraded snapshot with its original verification time and no confirmed working agents. These observations never grant execution authority. A cache write error appears separately without hiding a valid source.

The frontend uses one cancellable transport hook for registry and selected source. It polls each second, uses full SSE snapshots, rejects decreasing revisions and retired bindings, and ignores retired selections. Managed sources carry `dataEpoch`: only an increased epoch permits a lower canonical revision after a verified restore; late data from a previous epoch is refused by both observer cache and browser.

## Execute and resume a local plan

New tasks use the explicit `ocw-plan-2` contract described in [native-graph-v2.md](docs/native-graph-v2.md): ALL groups, stable path decisions and command selection, independent checkpoint acceptance, input-bound attempts, and dependency invalidation. The unversioned plan below remains supported for historical compatibility. The current UI is declared in `ui-release.json`; use `ensure-ui` or the guarded launcher to validate source and asset hashes.

`scripts/ocw_runtime.py` uses Python 3 standard library and local SQLite WAL/FULL transactions. `init` requires a new directory and validates an acyclic checkpoint plan. Each checkpoint has `id`, `depends_on`, absolute `cwd`, an `argv` array, `execution: "replay_safe"`, optional `max_attempts` (default 3), and `timeout_seconds` (default 300). The plan has `task_id`, `objective`, and an absolute `delivery_dir`. Commands inherit the invoking process environment: do not put credentials in plan arguments. A replay-safe declaration is a caller contract, not OS containment; use this only for approved local work that tolerates repetition. External mutations belong in a connector with idempotency and lookup.

```sh
./init.sh runtime init --root /absolute/new-runtime --plan /absolute/plan.json
./init.sh runtime run --root /absolute/new-runtime --workers 3 --registry /absolute/registry
./init.sh runtime status --root /absolute/new-runtime
```

Workers atomically claim ready checkpoints under separate leases. Every heartbeat, result and operation dispatch checks the current attempt, owner, fencing epoch and expiration at the SQLite write boundary. An expired lease cannot renew. New attempts preserve interrupted/failed attempts and append events; exhaustion stops retrying. Completed checkpoints are skipped on resume. Commands have time/output bounds. A successful command output is durably recorded before delivery, so a lost delivery receipt resumes the original output instead of rerunning a successful command with different timestamps.

Committed SQLite facts are exported to immutable `generations/<id>/` directories. Every file is hashed in `manifest.json`; only after files and directories are fsynced is `ocw-head.json` atomically switched. The adapter pins one generation, checks the manifest and every declared file, and never writes it. A publisher crash can leave an orphan generation or an older complete head; `runtime publish` or `run` reconstructs the latest committed facts. The portable registrar supports this root format too.

The runtime reports checkpoint/attempt recovery separately from the R1–R5 protocol. A local plan validates its DAG (G1) and executes checkpoints (G4); route exploration, user route adjudication and independent R5 evaluation are shown as not enabled, rather than manufactured pass verdicts.

## Operations and ambiguous results

The Python integration surface is `Runtime.claim/heartbeat/finish`, `prepare_operation(token, name, request)`, `dispatch(token, key, connector)` and `reconcile(key, connector)`. The stable operation key is derived from task/checkpoint/logical-operation identity, not from the attempt. Reusing it with different request bytes is refused. Do not reuse task IDs for unrelated logical jobs.

The built-in `FileDelivery` creates immutable files in one configured destination, refuses symlinks/path traversal/overwrite, and checks exact bytes when reconciling. A connector implements `execute(key, request)` and `lookup(key, request)`. It must enforce stable-key idempotency at the actual destination. Lookup returns `confirmed` or `absent` with authoritative evidence; `absent` must guarantee no old request can arrive later, or that such arrivals deduplicate by the same key. A timeout becomes `unknown`, blocks checkpoint acceptance and automatic retry, and requires lookup. Only the built-in local file connector reconciles automatically. This is not an exactly-once guarantee for arbitrary HTTP APIs or tools.

## Backup and host restoration

`scripts/ocw_backup.py create --config /absolute/backup.json --destination /absolute/backups` creates a checksum-verified archive. Config `items` contain a unique `name`, absolute `path`, and `kind` (`runtime`, `registry`, or omitted for regular files). A runtime item uses SQLite online backup while writers are excluded and includes confirmed immutable deliveries. Other items are rejected if their file inventory changes during copying. The optional `required_mount` prevents silently backing up onto the system disk when an external volume is absent. Scope is capped at 1 GiB; dependency folders, Git metadata and logs are excluded and recorded.

`verify --archive <archive>` checks every entry and rejects unsafe names/symlinks/duplicates. `restore --archive <archive> --destination <new-directory>` verifies before extracting, refuses an existing destination, remaps known root paths, closes restored registrations, expires running attempts, increments the data epoch and places execution on hold. It preserves accepted checkpoint evidence and unknown operation outcomes. Restore never overwrites or automatically starts the old execution root.

Inspect `RESTORE-REPORT.json`, dependency/runtime availability and delivery hashes. Reconcile unknown operations using the destination connector; then explicitly run `runtime activate-restore --root <restored-runtime> --evidence '<verification evidence>'`. Only after this may `runtime run` continue pending work. Commands and delivery destinations on the original host must be accounted for before activating a replacement. A replacement machine needs Python 3 and Node. When a verified prebuilt frontend is included, start the restored read-only console with `service install --app <restore>/console --build-dir <restore>/frontend --registry <restore>/registry`; no node_modules or rebuild is required. Development/rebuilding still needs lockfile-based `npm ci` or a verified offline dependency cache. Wait for each source to leave its initial loading state before evaluating readiness.

The RPO is the last completed backup per item, not zero; separate items are not a distributed transaction. `runtime run --backup-config <config>` can create a backup after the run closes its registration; this config also has `destination`. Backup creation/restore timestamps and checkpoint revisions are evidence for measuring RPO/RTO. Backup running/success/failure observations are durable runtime metadata and appear separately in both the directory and task view. Checkpoint completion never implies backup success. macOS backup copies use buffered bytes rather than native FileProvider cloning. No periodic/offsite service or credential is silently configured. An external local disk survives system-disk loss but is not an offsite backup. Process-kill drills do not prove physical power-loss behavior.

For executor login/crash recovery, use `service install --kind executor --name <unique-name> --runtime <root> --registry <registry> --workers 3`. The registered plan is the only authority to run commands. Launchd restarts abnormal crashes, but a normal completion or an unknown-result/failed-plan exit stays stopped for attention. It rechecks pending leases on restart rather than force-taking live work.

Validation:

- `npm run check`: registration, projection, reliability tests, typecheck and build.
- `npm run e2e`: synthetic browser tests, including real delayed GET after newer SSE.
- Set `OCW_BUILD_DIR` to an isolated absolute directory for both build and server/tests, so verification does not overwrite a currently served desktop bundle.
- `scripts/runtime-resilience.test.mjs` covers lifecycle/identity conflicts, worker deduplication, dead process detection, referenced-file invalidation, incomplete commits, adapter restart/supervision, bounded slow-source work, SSE backpressure and a 100-registration/10-reader synthetic workload.

The completed reference protocol task remains immutable and is not retrofitted with execution. Validate executor/backup behavior using the included Python failure suite and the managed-generation browser test. Record actual service and external-disk restoration separately from those isolated tests.
