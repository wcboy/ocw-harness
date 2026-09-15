# HTTP API

The adapter is a read-only observer of canonical state. It binds `127.0.0.1`
only, on `$PORT` (default 4173).

`docs/openapi.yaml` is the machine-readable version of this document, and
`tests/api-contract.test.mjs` checks a live server's responses against it, so
adding or removing a response field fails the test suite until the contract is
updated.

## Rules that apply to every route

| Rule | Behavior |
|---|---|
| Methods | `GET` and `HEAD` only. Anything else returns 405 with `{error, allow: ["GET","HEAD"]}` |
| Request bodies | Never read. There is no route that mutates canonical state |
| JSON responses | `Content-Type: application/json; charset=utf-8` and `Cache-Control: no-store` |
| Errors | `{error: string}`, plus `registryRequired: true` on a 409 from `/api/snapshot` |
| Versioning | Not in the URL. `GET /api/health` reports `binding.adapterVersion`, and `harness-ui.json` declares the binding schema. Pin against those |

There is no authentication. The listener is loopback-only and read-only; treat
access to the port as equivalent to read access to the canonical roots it
observes.

## `GET /api/health`

Launcher and liveness probe. Also the one call that tells you what this adapter
is bound to and what it refuses to do.

| Query | Meaning |
|---|---|
| `launch` | Optional launch token, `[A-Za-z0-9-]{8,80}`. Anything else is ignored rather than rejected |

`200` returns `{ok: true, binding: {...}}`. Notable fields in `binding`:

| Field | Meaning |
|---|---|
| `adapterVersion`, `ui`, `sourceDigest` | What contract and build are being served |
| `status` | `current`, `stale`, `incomplete`, `corrupt` or `missing` build state |
| `registryMode`, `registryDir` | Which registry this adapter reads |
| `registrationCount`, `taskCount`, `sessionCount` | Registry totals |
| `connectedClients`, `frontendAttached`, `launchAttached` | Observation, not authority |
| `capabilities` | `sourceRecovery`, `executorTakeover`, `hostBackup`, `canonicalWrites`. All report what this process will **not** do |

`503` returns `{ok: false, error}` when the registry cannot be listed.

A 200 here proves the adapter is bound and answering. It does not prove a
browser is visible to a user, and `connectedClients` is not a claim that any
agent is working.

## `GET /api/registry`

Every registration the active registry holds. This is the directory view.

`200` top-level keys:

| Key | Meaning |
|---|---|
| `schemaVersion` | `ocw-harness-registry-1` |
| `generatedAt` | When this response was built |
| `runtime` | The same binding fields as `/api/health` |
| `counts` | `registrations`, `tasks`, `sessions`, `working`, `active`, `unavailable`, `workingAgents`, `activeAssignments` |
| `registrations` | Array of registration summaries |
| `errors` | Per-file `{file, message}` for records that failed to parse. A bad record degrades one row, not the response |

Each registration carries `registrationId`, `taskId`, `sessionId`, `sourceRoot`,
`lifecycle`, `presence`, `liveness`, `ownership`, `progress`,
`checkpointsComplete` / `checkpointsTotal`, `workingAgents`,
`activeAssignments` and `blockers`. `liveness` is computed per response and is
deliberately separate from assignment history: an expired or unverified
registration reads as unknown rather than working, and a terminal task has zero
current workers.

Responses are cached in memory for 700ms.

## `GET /api/snapshot`

The full projection for one registration.

| Query | Required | Meaning |
|---|---|---|
| `harness` | Yes | A `registrationId` from `/api/registry` |

| Status | Body |
|---|---|
| 200 | The snapshot |
| 409 | `{error, registryRequired: true}` when the harness is missing or ambiguous |
| 503 | `{error}` when the source cannot be read or the projection fails |

`200` top-level keys:

| Key | Meaning |
|---|---|
| `generatedAt`, `verifiedAt` | When built, and when the underlying facts were last verified |
| `sourceRoot`, `contentFingerprint` | What was read, and its content identity |
| `sourceStatus`, `sourceError`, `persistenceError` | Degradation is explicit, never silent |
| `execution` | Executor summary for a managed root, else `null` |
| `runtime` | Liveness, observation sequence, instance and UI identity |
| `task`, `phases` | Task metadata and the R1-R5 protocol strip |
| `groups`, `checkpointTree` | ALL groups and the recursive checkpoint tree |
| `routeFlow`, `journey` | Route adjudication and the path graph the UI draws |
| `agentActivity` | `assignments`, `workingCount`, `activeAssignmentCount`, `unverifiedAssignmentCount` |
| `events`, `metrics`, `integrity` | Event chain, counters, and the chain validation result |

Every status carries a `statusSource` naming where it came from:
`runtime_checkpoint` for native per-checkpoint acceptance, `edge_accepted` for
an edge-scoped accepted record, `derived` for aggregation, `phase_inferred` for
a guess from the current phase. Do not present a `phase_inferred` or
`edge_accepted` status as independent per-checkpoint acceptance, and do not read
an R5 verdict that no auditor produced.

Field-level types are in `src/types.ts` (`WorkflowSnapshot`).

## `GET /api/stream`

Server-sent events. Long-lived.

| Query | Meaning |
|---|---|
| `channel` | `registry` for the directory stream; anything else means the snapshot stream |
| `harness` | Registration id, when `channel` is not `registry` |
| `launch` | Optional launch token, counted in `/api/health` |

Headers: `text/event-stream; charset=utf-8`, `Cache-Control: no-cache, no-transform`,
`Connection: keep-alive`, `X-Accel-Buffering: no`. The first frame is
`retry: 1800`.

| Event | `data` payload |
|---|---|
| `registry` | Identical to `GET /api/registry` |
| `snapshot` | Identical to `GET /api/snapshot` |
| `source-error` | `{message, at?}` |

Comment lines `: heartbeat <timestamp>` arrive every 15s. Broadcasts are
debounced 120ms. A client that stalls for more than 10s, or a frame larger than
1MB, is dropped rather than buffered.

**SSE does not replace polling.** The frontend runs both: SSE for push and a
non-overlapping 1s `GET`. Either transport can deliver a frame older than one
you already have, so a client must reject a lower canonical revision, a lower
observation sequence at the same revision, an older adapter response sequence
and a retired binding. The one exception is recovery: a higher `dataEpoch`
legitimately carries a lower revision.

## `GET /api/diagnostics`

Cache and process counters: `digestComputations`, `snapshotBuilds`,
`digestEntries`, `sourceCacheEntries`, `activeSourceReads`, `queuedSourceReads`,
`connectedClients`, `uptimeMs`. Always 200.

This is an operational aid and is explicitly **not** part of the UI contract.
Do not build a client against it.

## Static routes

Everything else serves the built SPA from `$OCW_BUILD_DIR` (default `dist`).

| Case | Response |
|---|---|
| Path escapes the build directory | 403 |
| `index.html` when the build is stale or its digest mismatches | 503 |
| `assets/*` | 200, `Cache-Control: public, max-age=31536000, immutable` |
| Other files | 200, `Cache-Control: no-cache` |

The 503 is deliberate: serving a stale bundle against a newer adapter is how a
console silently shows the wrong thing. Run `npm run ensure-ui`.

## Writing a client

1. `GET /api/health`. Record `binding.adapterVersion` and `binding.status`.
2. `GET /api/registry`. Pick a `registrationId`.
3. Open `GET /api/stream?harness=<id>` and poll `GET /api/snapshot?harness=<id>`
   every second without overlapping requests.
4. Drop any frame whose `dataEpoch`, canonical revision or observation sequence
   is not newer than what you hold, unless `dataEpoch` increased.
5. Treat `sourceStatus`, `sourceError` and `persistenceError` as first-class:
   render degradation instead of an empty success state.

To register a root so it appears in step 2, use the registry CLI — registration
is a write and does not belong to this API:

```sh
node scripts/harness-registry.mjs register --source /absolute/root --session my-session
```
