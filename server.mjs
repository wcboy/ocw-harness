import { createHash, randomUUID } from "node:crypto";
import { createReadStream, unwatchFile, watchFile } from "node:fs";
import { access, readFile, readdir, stat } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { registrationLiveness, terminalOutcome, projectActivity, workerKey } from "./scripts/runtime-state.mjs";
import { attachSseWriter } from "./scripts/sse-writer.mjs";
import { SourceCache } from "./scripts/source-cache.mjs";
import { SnapshotStore } from "./scripts/snapshot-store.mjs";
import { managedSource, restoredArtifact } from "./scripts/managed-source.mjs";
import { validateNativeGraph, validateNativeEvidence, checkpointState, aggregateStates } from "./scripts/native-graph.mjs";
import { releaseIdentity, buildStatus } from "./scripts/ui-release.mjs";
import { AsyncLocalStorage } from "node:async_hooks";
import { defaultRegistryDir, listRegistrations } from "./scripts/harness-registry.mjs";
import {
  anchorPaths,
  collectEdgeAttempts,
  deriveTopology,
  discoverSources,
  memoRefsFromAccepted,
  normalizeLabelOverlay,
  overlayField,
  parsePathMemo,
  resolveWorkflowRef,
} from "./scripts/workflow-projection.mjs";
import {
  checkpointStatusForGoal,
  normalizeAgentActivity,
  normalizeCheckpointTree,
  normalizeEvent,
  normalizeJourney,
  normalizeRouteFlow,
  phaseDefinitions,
  phaseProgress,
  stageStatus,
  validateEventChain,
} from "./scripts/snapshot-projection.mjs";

const appRoot = dirname(fileURLToPath(import.meta.url));
const loadedRelease = await releaseIdentity(appRoot);
const registryDir = defaultRegistryDir();
const port = Number(process.env.PORT || 4173);
const isDev = process.argv.includes("--dev");
const runtimeStartedAt = new Date().toISOString();
const bindingId = `bind-${randomUUID().slice(0, 8)}`;
const frontendUrl = `http://127.0.0.1:${port}`;

function launchTokenFrom(url) {
  const value = url.searchParams.get("launch") || "";
  return /^[A-Za-z0-9-]{8,80}$/.test(value) ? value : null;
}

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

const sourceReads = new AsyncLocalStorage();

async function readUtf8WithRetry(path, attempts = 3) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      sourceReads.getStore()?.add(path);
      return await readFile(path, { encoding: "utf8", signal: AbortSignal.timeout(1500) });
    } catch (error) {
      lastError = error;
      if (attempt < attempts - 1) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 90 * (attempt + 1)));
      }
    }
  }
  throw lastError;
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readUtf8WithRetry(path));
  } catch (error) {
    if (fallback !== undefined) return fallback;
    throw new Error(`无法读取 ${path}: ${error.message}`);
  }
}

async function readText(path, fallback = "") {
  try {
    return await readUtf8WithRetry(path);
  } catch {
    return fallback;
  }
}

const bindingConfig = await readJson(join(appRoot, "harness-ui.json"));
const distRoot = process.env.OCW_BUILD_DIR ? resolve(process.env.OCW_BUILD_DIR) : resolve(appRoot, bindingConfig.frontend_dir || "dist");

/**
 * Read a file named by a ref the canonical data declared about itself.
 *
 * Canonical state is authoritative but is still untrusted input to this process,
 * so every ref-driven read is contained inside the workflow root. A ref that
 * escapes, or that names a missing file, yields the fallback instead of throwing:
 * a stale ref must degrade one panel, not the whole snapshot.
 */
async function readRefJson(workflowRoot, ref, fallback = null) {
  const path = resolveWorkflowRef(workflowRoot, ref);
  if (!path) return fallback;
  return readJson(path, fallback);
}

async function readRefText(workflowRoot, ref, fallback = "") {
  const path = resolveWorkflowRef(workflowRoot, ref);
  if (!path) return fallback;
  return readText(path, fallback);
}


/**
 * Load the optional app-side display overlay for a task. Absent means the console
 * shows raw identifiers; overlays are never read from or written to a workflow root.
 */
async function loadLabelOverlay(taskId) {
  const key = String(taskId || "");
  if (!/^[A-Za-z0-9._-]+$/.test(key)) return normalizeLabelOverlay(null);
  const overlay = normalizeLabelOverlay(await readJson(join(appRoot, "labels", `${key}.json`), null));
  return overlay;
}

async function readEvents(path) {
  const body = await readUtf8WithRetry(path);
  return body
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`events.jsonl 第 ${index + 1} 行解析失败: ${error.message}`);
      }
    });
}

// Digests are content-addressed by (path, mtime, size). The product file and its
// delivery mirror are ~434 KB each and never change between accepted revisions,
// so hashing them on every 1s poll was pure waste.
const digestCache = new Map();
let digestComputations = 0;

async function fileDigest(path) {
  sourceReads.getStore()?.add(path);
  const info = await stat(path).catch(() => null);
  if (!info) throw new Error(`cannot stat ${path}`);
  const key = `${path}\u0000${info.mtimeMs}\u0000${info.size}`;
  const cached = digestCache.get(key);
  if (cached) return cached;

  digestComputations += 1;
  const hash = createHash("sha256");
  const stream = createReadStream(path);
  for await (const chunk of stream) hash.update(chunk);
  const digest = hash.digest("hex");
  // Only the newest entry per path is useful; drop stale mtimes as we go.
  for (const existing of digestCache.keys()) {
    if (existing.startsWith(`${path}\u0000`)) digestCache.delete(existing);
  }
  digestCache.set(key, digest);
  return digest;
}

/**
 * Share verified canonical facts per source and invalidate on tracked file changes.
 * Session/liveness/attachment data are decorated after the shared build.
 */
const sourceCache = new SourceCache({ store: new SnapshotStore(join(registryDir, '.snapshots')) });
const sourceDependencies = new Map();
const sourceVersions = new Map();
const fingerprintJobs = new Map();
let observationSeq = 0;

function sourceKey(registration) { return `${resolve(registration.sourceRoot)}\0${registration.taskId}`; }

async function anchorFingerprint(workflowRoot, dependencies = []) {
  const paths = [...new Set([join(workflowRoot, 'ocw-head.json'), ...Object.values(anchorPaths(workflowRoot)), ...dependencies])];
  const stats = await Promise.all(paths.map(path => stat(path).then(info => `${path}:${info.mtimeMs}:${info.ctimeMs}:${info.size}`).catch(() => `${path}:missing`)));
  return createHash("sha256").update(stats.join("|")).digest("hex");
}

async function fingerprintFor(registration) {
  const key = sourceKey(registration);
  if (!fingerprintJobs.has(key)) {
    const job = anchorFingerprint(resolve(registration.sourceRoot), sourceDependencies.get(key)).finally(() => fingerprintJobs.delete(key));
    fingerprintJobs.set(key, job);
  }
  return fingerprintJobs.get(key);
}

async function getSnapshot(registration) {
  const key = sourceKey(registration);
  // Stat/read work belongs inside the bounded source job too: a stuck volume must
  // not occupy every HTTP handler before it reaches a timeout.
  const epoch = sourceVersions.get(key) || 0;
  const result = await sourceCache.read(key, epoch, async () => {
    const dependencies = new Set();
    const before = await fingerprintFor(registration);
    const snapshot = await sourceReads.run(dependencies, () => buildSnapshot(registration));
    if (snapshot.task.id !== registration.taskId) throw new Error("注册身份与 canonical task_id 不一致");
    if (!snapshot.integrity.chainHealthy) throw new Error(`提交尚不一致：${snapshot.integrity.chainIssues.join("; ")}`);
    const after = await fingerprintFor(registration);
    if (before !== after) throw new Error("读取期间 canonical 数据发生变化");
    sourceDependencies.set(key, [...dependencies]);
    void refreshWatches().catch(() => {});
    snapshot.contentFingerprint = createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
    return snapshot;
  });
  const liveness = await registrationLiveness(registration);
  const current = projectActivity(result.value, result.error ? "unknown" : liveness);
  current.generatedAt = new Date().toISOString();
  current.sourceStatus = result.error ? "degraded" : "ready";
  current.sourceError = result.error || null;
  current.persistenceError = result.persistenceError || null;
  current.verifiedAt = result.verifiedAt;
  current.runtime = { ...current.runtime, bindingId, startedAt: runtimeStartedAt,
    registrationId: registration.registrationId, sessionId: registration.sessionId,
    instanceId: registration.instanceId || null, liveness,
    status: result.error ? "degraded" : "bound",
    ui: loadedRelease, observationSeq: ++observationSeq,
    connectedClients: clientCountFor(registration.registrationId), frontendAttached: clientCountFor(registration.registrationId) > 0,
  };
  return current;
}

function cacheStats() {
  return { digestComputations, snapshotBuilds: sourceCache.builds, digestEntries: digestCache.size,
    sourceCacheEntries: sourceCache.entries.size, activeSourceReads: sourceCache.active, queuedSourceReads: sourceCache.queue.length };
}

/**
 * Read every ref-addressed source for one workflow root.
 *
 * Only the four protocol anchors are read by fixed name. Accepted records, path
 * memories, r2/r4 results, route bodies, assignment specs and the feature ledger
 * are all reached through refs the canonical data declares, so a harness with
 * different ids, revisions or directory names needs no code change.
 */
async function readAssignmentSpecs(workflowRoot, state, graph, sources = null) {
  const refs = (sources || discoverSources(state, graph)).assignmentSpecRefs;
  const specs = new Map();
  await Promise.all(
    [...refs].map(async ([assignmentId, ref]) => {
      const spec = await readRefJson(workflowRoot, ref, null);
      if (spec) specs.set(assignmentId, spec);
    }),
  );
  return specs;
}

/**
 * Find the feature ledger by the route it froze.
 *
 * The ledger records its own `route_id`, so matching on that is exact; deriving a
 * directory name from the selected route id would be a guess.
 */
async function readFeatureLedger(workflowRoot, state, implementationRoot = "task-memory/implementation") {
  const selectedRoute = state.user_gate?.selected_route || null;
  const dirs = await readdir(join(workflowRoot, implementationRoot)).catch(() => []);
  let fallback = { features: [] };
  for (const dir of dirs) {
    const ledger = await readRefJson(workflowRoot, `${implementationRoot}/${dir}/features.json`, null);
    if (!ledger) continue;
    if (!selectedRoute || ledger.route_id === selectedRoute) return ledger;
    if (!fallback.features.length) fallback = ledger;
  }
  return fallback;
}

async function readDiscoveredSources(workflowRoot, state, graph) {
  const sources = discoverSources(state, graph);
  const assignmentSpecs = await readAssignmentSpecs(workflowRoot, state, graph, sources);

  const routeBodies = {};
  await Promise.all(
    [...sources.routeRefs].map(async ([routeId, ref]) => {
      routeBodies[routeId] = await readRefText(workflowRoot, ref, "");
    }),
  );

  // Per-edge evidence: the current accepted record, its superseded predecessors,
  // the exploration results, and the path memories those records point at.
  const edgeEvidence = new Map();
  await Promise.all(
    [...sources.acceptedByEdge].map(async ([edgeId, entry]) => {
      const [current, ...history] = await Promise.all(
        [entry.current, ...entry.history]
          .filter(Boolean)
          .map((record) => readRefJson(workflowRoot, record.ref, null)),
      );
      const results = await Promise.all(
        (sources.resultsByEdge.get(edgeId) || []).map((record) => readRefJson(workflowRoot, record.ref, null)),
      );

      const memoRefs = new Map();
      for (const record of [current, ...history].filter(Boolean)) {
        for (const [pathId, ref] of memoRefsFromAccepted(record)) {
          if (!memoRefs.has(pathId)) memoRefs.set(pathId, ref);
        }
      }
      const memos = new Map();
      await Promise.all(
        [...memoRefs].map(async ([pathId, ref]) => {
          const body = await readRefText(workflowRoot, ref, "");
          if (body) memos.set(pathId, parsePathMemo(body));
        }),
      );

      edgeEvidence.set(edgeId, {
        attempts: collectEdgeAttempts(current, history.filter(Boolean)),
        supplementalAttempts: results.flatMap((item) => item?.attempts || []),
        legacyAttempts: history.filter(Boolean).flatMap((item) => item?.accepted_attempts || []),
        memos,
        priorRevisions: entry.history.map((record) => ({
          revision: record.revision,
          ref: record.ref,
          status: record.status,
          invalidationReason: record.invalidationReason,
        })),
      });
    }),
  );

  // The R4 result is the assignment whose result lands in the r4 inbox.
  const r4Ref = (sources.phaseResults.get("R4") || [])[0]?.ref || null;
  const [result, features] = await Promise.all([
    r4Ref ? readRefJson(workflowRoot, r4Ref, {}) : Promise.resolve({}),
    readFeatureLedger(workflowRoot, state, sources.implementationRef),
  ]);

  return { assignmentSpecs, routeBodies, edgeEvidence, result, features, sources };
}

async function buildSnapshot(registration) {
  const managed = await managedSource(resolve(registration.sourceRoot), readUtf8WithRetry);
  const workflowRoot = managed.root;
  const paths = anchorPaths(workflowRoot);
  const [state, graph, decision, events] = await Promise.all([
    readJson(paths.state),
    readJson(paths.graph),
    readJson(paths.decision, {}),
    readEvents(paths.events),
  ]);

  const [discovered, overlay] = await Promise.all([
    readDiscoveredSources(workflowRoot, state, graph),
    loadLabelOverlay(state.task_id),
  ]);
  const { assignmentSpecs, routeBodies, edgeEvidence, result, features } = discovered;
  if (registration.recoveryPaths) {
    result.product_ref = restoredArtifact(result.product_ref, registration.recoveryPaths);
    if (result.write_set?.delivery_mirror) result.write_set.delivery_mirror.ref = restoredArtifact(result.write_set.delivery_mirror.ref, registration.recoveryPaths);
  }
  const native = validateNativeGraph(graph);
  if (native) await validateNativeEvidence(graph, ref => readUtf8WithRetry(resolveWorkflowRef(workflowRoot, ref)));
  const topology = deriveTopology(graph);
  if (managed.execution) {
    topology.executionStates = new Map((graph.goal_tree || []).map(goal => {
      const states = (graph.checkpoints || []).filter(cp => cp.l1_id === goal.l1_id).map(cp => cp.execution_status);
      return [goal.l1_id, states.every(s => s === 'accepted') ? 'complete' : states.includes('failed') ? 'attention' : states.includes('running') ? 'active' : 'pending'];
    }));
  }

  const activePhase = state.phase;
  const phases = phaseDefinitions.map((definition) => {
    const gateStatus = state.gate_status?.[definition.gate] || "pending";
    const status = stageStatus(gateStatus, definition.activePhases.includes(activePhase));
    return {
      ...definition,
      ...(managed.execution && definition.id === 'R4' ? {title:'执行与验收', owner:'Workers / Oracles', description:'按依赖并行执行，由各检查点的验收合同确认结果。'} : {}),
      status,
      gateStatus,
      progress: status === "complete" ? 100 : phaseProgress(definition.id, state, features),
    };
  });

  const acceptedEdges = new Map(
    [...discovered.sources.acceptedByEdge]
      .filter(([, entry]) => entry.current)
      .map(([edgeId, entry]) => [edgeId, entry.current]),
  );
  const checkpointsByGroup = new Map();
  for (const checkpoint of graph.checkpoints || []) {
    const items = checkpointsByGroup.get(checkpoint.l1_id) || [];
    items.push(checkpoint);
    checkpointsByGroup.set(checkpoint.l1_id, items);
  }

  const groups = (graph.goal_tree || []).map((goal, index) => {
    const goalId = goal.l1_id || `L1-${index + 1}`;
    const record = topology.byGoalId.get(goalId);
    const accepted = record?.edgeId ? acceptedEdges.get(record.edgeId) : null;
    const derived = checkpointStatusForGoal(goalId, acceptedEdges, activePhase, topology);
    const checkpoints = (checkpointsByGroup.get(goal.l1_id) || []).map((checkpoint) => ({
      id: checkpoint.checkpoint_id,
      l1Id: checkpoint.l1_id,
      objective: checkpoint.objective,
      targetRules: checkpoint.target_rules || [],
      preconditions: checkpoint.preconditions || [],
      postconditions: checkpoint.postconditions || [],
      invariants: checkpoint.invariants || [],
      acceptanceOracle: checkpoint.acceptance_oracle,
      dependsOn: checkpoint.depends_on || [],
      providesTo: checkpoint.provides_to || [],
      ...(checkpoint.execution_status ? checkpointState(checkpoint) : derived),
      label: checkpoint.label || checkpoint.objective,
      acceptance: checkpoint.acceptance || null,
    }));
    return {
      id: goalId,
      label: overlayField(overlay, "goals", goalId) || goal.label || record?.label || goalId,
      sequence: record?.sequence ?? index + 1,
      edgeId: record?.edgeId || null,
      objective: goal.objective,
      status: native ? aggregateStates(checkpoints.map(cp => cp.status)) : derived.status,
      statusSource: native ? 'derived' : derived.statusSource,
      acceptedRevision: accepted?.revision ?? null,
      acceptedRef: accepted?.ref ?? null,
      progress: checkpoints.length ? Math.round((checkpoints.filter((item) => item.status === "complete").length / checkpoints.length) * 100) : 0,
      checkpoints,
    };
  });

  const featureItems = features.features || [];
  const passedFeatures = featureItems.filter((item) => item.passes).length;
  const chain = validateEventChain(events, state);
  const productRef = result.product_ref || null;
  const productDigest = productRef ? await fileDigest(productRef).catch(() => null) : null;
  const expectedProductDigest = result.product_sha256 || null;
  const mirror = result.write_set?.delivery_mirror || null;
  const mirrorDigest = mirror?.ref ? await fileDigest(mirror.ref).catch(() => null) : null;
  const agentActivity = normalizeAgentActivity(state, assignmentSpecs, native);
  const checkpointTree = normalizeCheckpointTree(graph, acceptedEdges, activePhase, agentActivity, topology, overlay);
  const routeFlow = normalizeRouteFlow(state, decision, result, routeBodies);
  const journey = normalizeJourney(
    graph,
    groups,
    routeFlow,
    edgeEvidence,
    agentActivity,
    checkpointTree,
    topology,
    overlay,
  );
  if (managed.execution) {
    const states = [...topology.executionStates.values()];
    journey.root.status = managed.execution.restoreHold || managed.execution.unknownOperations || managed.execution.backup?.status === 'failed' || states.includes('attention') ? 'attention'
      : states.every(status => status === 'complete') ? 'complete' : states.includes('active') ? 'active' : 'pending';
  }

  return {
    generatedAt: new Date().toISOString(),
    sourceRoot: resolve(registration.sourceRoot),
    execution: managed.execution,
    runtime: {
      bindingId,
      dataEpoch: managed.dataEpoch,
      sourceObservationSeq: managed.execution?.observationSeq || 0,
      required: bindingConfig.frontend_required === true,
      status: "bound",
      startedAt: runtimeStartedAt,
      frontendUrl,
      sourceRoot: resolve(registration.sourceRoot),
      sourceMode: bindingConfig.source_mode,
      renderMode: bindingConfig.render_mode,
      registryMode: true,
      registryDir,
      registrationId: registration.registrationId,
      sessionId: registration.sessionId,
      connectedClients: clientCountFor(registration.registrationId),
      frontendAttached: clientCountFor(registration.registrationId) > 0,
    },
    task: {
      id: state.task_id,
      objective: state.objective || graph.root_goal,
      revision: state.revision,
      phase: state.phase,
      updatedAt: state.updated_at,
      nextAction: state.next_action,
      blockers: state.blockers || [],
      selectedRoute: state.user_gate?.selected_route || decision.selected_route || null,
      decisionStatus: state.user_gate?.status || decision.status || "unknown",
    },
    phases,
    groups: groups.sort((a, b) => a.sequence - b.sequence),
    checkpointTree,
    routeFlow,
    journey,
    agentActivity: {
      workingCount: agentActivity.workingCount,
      assignments: agentActivity.assignments,
    },
    events: events.map(normalizeEvent),
    metrics: {
      featuresPassed: passedFeatures,
      featuresTotal: featureItems.length,
      checkpointsComplete: groups.flatMap((group) => group.checkpoints).filter((item) => item.status === "complete").length,
      checkpointsTotal: groups.flatMap((group) => group.checkpoints).length,
      events: events.length,
      revision: state.revision,
    },
    integrity: {
      chainHealthy: chain.healthy,
      chainIssues: chain.issues,
      productDigest,
      expectedProductDigest,
      productDigestMatches: Boolean(productDigest && productDigest === expectedProductDigest),
      mirrorDigest,
      mirrorDigestMatches: Boolean(mirrorDigest && mirrorDigest === expectedProductDigest),
      mirrorReview: mirror?.independent_R5 || "unavailable",
      baselineDigest: result.source_bindings?.frozen_v0_1?.sha256 || state.base_revision?.value || null,
    },
  };
}

function clientCountFor(registrationId) {
  return [...clients].filter((client) => client.registrationId === registrationId).length;
}

function latestTimestamp(...values) {
  return values
    .filter(Boolean)
    .map((value) => ({ value, time: Date.parse(value) }))
    .filter((item) => Number.isFinite(item.time))
    .sort((a, b) => b.time - a.time)[0]?.value || null;
}

async function buildRegistrationSummary(registration) {
  const summaryBase = { ...registration, frontendPath: `/?harness=${encodeURIComponent(registration.registrationId)}` };
  try {
    const snapshot = await getSnapshot(registration);
    const { task, agentActivity, phases } = snapshot;
    const workingAssignments = agentActivity.assignments.filter(a => a.working && (!a.sessionId || a.sessionId === registration.sessionId));
    const outcome = terminalOutcome(task.phase);
    const liveness = snapshot.runtime.liveness;
    const presence = registration.lifecycle === "closed" ? "closed"
      : snapshot.sourceStatus !== "ready" ? "unavailable"
      : outcome || (liveness === "live" ? workingAssignments.length ? "working" : "active" : liveness === "lost" ? "lost" : "idle");
    return { ...summaryBase, available: true, sourceStatus: snapshot.sourceStatus, liveness,
      backupStatus: snapshot.execution?.backup?.status || null,
      presence, taskId: task.id, objective: task.objective, phase: task.phase,
      revision: task.revision, updatedAt: task.updatedAt, verifiedAt: snapshot.verifiedAt,
      lastActivityAt: latestTimestamp(task.updatedAt, registration.heartbeatAt), nextAction: task.nextAction || "",
      blockers: task.blockers.length, workingAgents: new Set(workingAssignments.map(a => workerKey(a, snapshot.sourceRoot))).size,
      activeAssignments: workingAssignments.length, workingAssignments,
      unverifiedAssignments: agentActivity.unverifiedAssignmentCount,
      ownership: agentActivity.assignments.some(a => !a.sessionId) ? "task_shared" : "session",
      checkpointsComplete: snapshot.metrics.checkpointsComplete, checkpointsTotal: snapshot.metrics.checkpointsTotal,
      progress: snapshot.execution ? Math.round(snapshot.execution.accepted * 100 / Math.max(1, snapshot.execution.total)) : Math.round(phases.reduce((total, phase) => total + phase.progress, 0) / phases.length), phases,
      error: snapshot.sourceError,
    };
  } catch (error) {
    return { ...summaryBase, available: false, sourceStatus: "unavailable", liveness: "unknown",
      presence: registration.lifecycle === "closed" ? "closed" : "unavailable", objective: registration.label,
      phase: "unavailable", revision: null, updatedAt: null, lastActivityAt: registration.heartbeatAt,
      nextAction: "", blockers: 0, workingAgents: 0, activeAssignments: 0, workingAssignments: [],
      unverifiedAssignments: 0, ownership: "unknown", checkpointsComplete: 0, checkpointsTotal: 0, progress: 0,
      phases: phaseDefinitions.map(phase => ({ id: phase.id, title: phase.title, status: "pending", progress: 0 })), error: error.message };
  }
}

let registryPending = null;
let registryCached = null;
let registryCacheAt = 0;
let registryRevision = 0;
let registryFingerprint = "";
async function buildRegistrySnapshot() {
  if (registryCached && Date.now() - registryCacheAt < 700) return { ...registryCached, generatedAt: new Date().toISOString(), runtime: { ...registryCached.runtime, connectedClients: clients.size, frontendAttached: clients.size > 0 } };
  if (registryPending) return registryPending;
  registryPending = (async () => {
    const registry = await listRegistrations(registryDir);
    const registrations = await Promise.all(registry.registrations.map(buildRegistrationSummary));
    const order = { working: 0, active: 1, lost: 2, failed: 3, idle: 4, complete: 5, cancelled: 6, closed: 7, unavailable: 8 };
    registrations.sort((a, b) => (order[a.presence] ?? 99) - (order[b.presence] ?? 99) || a.registrationId.localeCompare(b.registrationId));
    const workers = registrations.flatMap(r => r.workingAssignments.map(a => workerKey(a, r.sourceRoot)));
    const fingerprint = JSON.stringify([registrations, registry.errors]);
    if (fingerprint !== registryFingerprint) { registryRevision++; registryFingerprint = fingerprint; }
    registryCached = {
      schemaVersion: registry.schemaVersion, generatedAt: new Date().toISOString(), revision: registryRevision,
      runtime: { bindingId, ui: loadedRelease, required: bindingConfig.frontend_required === true, status: "bound", startedAt: runtimeStartedAt,
        frontendUrl, registryMode: true, registryDir, connectedClients: clients.size, frontendAttached: clients.size > 0 },
      counts: { registrations: registrations.length, tasks: new Set(registrations.map(r => `${r.sourceRoot}\0${r.taskId}`)).size,
        sessions: registrations.length, working: registrations.filter(r => r.presence === "working").length,
        active: registrations.filter(r => ["working", "active"].includes(r.presence)).length,
        unavailable: registrations.filter(r => r.sourceStatus !== "ready").length, workingAgents: new Set(workers).size,
        activeAssignments: new Set(registrations.flatMap(r => r.workingAssignments.map(a => `${r.sourceRoot}\0${a.assignmentId}`))).size },
      registrations, errors: registry.errors,
    };
    registryCacheAt = Date.now();
    return registryCached;
  })().finally(() => { registryPending = null; });
  return registryPending;
}

async function resolveRegistration(registrationId) {
  const registry = await listRegistrations(registryDir);
  if (registrationId) {
    return registry.registrations.find((item) => item.registrationId === registrationId) || null;
  }
  const open = registry.registrations.filter((item) => item.lifecycle !== "closed");
  if (open.length === 1) return open[0];
  if (open.length === 0 && registry.registrations.length === 1) return registry.registrations[0];
  return null;
}

function writeJson(response, statusCode, value) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(value));
}

const clients = new Set();
const watchedPaths = new Map();
let pendingBroadcast = null;
let recoveryBroadcast = null;

function sendEvent(client, event, payload) {
  client.send(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

/**
 * Watch the protocol anchors for every registration, plus the refs those anchors
 * currently point at.
 *
 * Watching the anchors alone would be enough for correctness, since any ref change
 * implies a `state.json` revision, but watching the refs too means an in-place edit
 * to an accepted record or a path memo is picked up immediately. The set is
 * re-derived on each refresh so it follows the data instead of a fixed path list.
 */
async function refreshWatches(registrySnapshot = null) {
  const registry = registrySnapshot || await listRegistrations(registryDir);
  const desired = new Map([[registryDir, null]]);
  for (const registration of registry.registrations) {
    const key = sourceKey(registration);
    for (const path of [join(registration.sourceRoot, 'ocw-head.json'), ...Object.values(anchorPaths(resolve(registration.sourceRoot))), ...(sourceDependencies.get(key) || [])]) {
      if (!desired.has(path)) desired.set(path, new Set());
      desired.get(path)?.add(key);
    }
  }
  for (const [path, keys] of desired) {
    if (watchedPaths.has(path)) { watchedPaths.get(path).keys = keys; continue; }
    const entry = { keys };
    entry.listener = () => {
      registryCacheAt = 0;
      for (const key of entry.keys || []) { sourceVersions.set(key, (sourceVersions.get(key) || 0) + 1); }
      scheduleBroadcast();
    };
    watchFile(path, { interval: 500 }, entry.listener);
    watchedPaths.set(path, entry);
  }
  for (const [path, entry] of watchedPaths) if (!desired.has(path)) { unwatchFile(path, entry.listener); watchedPaths.delete(path); }
}

async function broadcastSnapshots() {
  try {
    const registry = await buildRegistrySnapshot();
    await refreshWatches(registry);
    if (recoveryBroadcast) {
      clearTimeout(recoveryBroadcast);
      recoveryBroadcast = null;
    }
    // One build per registration per broadcast, even with several clients
    // watching the same harness. `getSnapshot` handles that across requests too.
    const perBroadcast = new Map();
    await Promise.all([...clients].map(async (client) => {
      if (client.channel === "registry") {
        sendEvent(client, "registry", registry);
        return;
      }
      const registration = registry.registrations.find((item) => item.registrationId === client.registrationId);
      if (!registration) {
        sendEvent(client, "source-error", { message: "该 Harness 注册已不存在", at: new Date().toISOString() });
        return;
      }
      if (!perBroadcast.has(registration.registrationId)) {
        perBroadcast.set(
          registration.registrationId,
          registration.available
            ? getSnapshot(registration).catch((error) => ({ error }))
            : Promise.resolve({ error: new Error(registration.error || "canonical 数据源不可用") }),
        );
      }
      const result = await perBroadcast.get(registration.registrationId);
      if (result.error) sendEvent(client, "source-error", { message: result.error.message, at: new Date().toISOString() });
      else sendEvent(client, "snapshot", result);
    }));
  } catch (error) {
    clients.forEach((client) => sendEvent(client, "source-error", { message: error.message, at: new Date().toISOString() }));
    if (!recoveryBroadcast) {
      recoveryBroadcast = setTimeout(() => {
        recoveryBroadcast = null;
        void broadcastSnapshots();
      }, 1500);
    }
  }
}

function scheduleBroadcast() {
  if (pendingBroadcast) clearTimeout(pendingBroadcast);
  pendingBroadcast = setTimeout(() => {
    pendingBroadcast = null;
    void broadcastSnapshots();
  }, 120);
}

const heartbeat = setInterval(() => {
  clients.forEach((client) => { if (!client.response.writableNeedDrain) client.send(`: heartbeat ${Date.now()}\n\n`); });
}, 15000);

let vite;
if (isDev) {
  const { createServer } = await import("vite");
  vite = await createServer({
    root: appRoot,
    server: { middlewareMode: true },
    appType: "spa",
  });
}

async function serveStatic(request, response) {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  const requested = decodeURIComponent(url.pathname);
  const relative = requested === "/" ? "index.html" : requested.replace(/^\/+/, "");
  let path = normalize(join(distRoot, relative));
  if (path !== distRoot && !path.startsWith(`${distRoot}/`)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }
  try {
    const info = await stat(path);
    if (info.isDirectory()) path = join(path, "index.html");
    await access(path);
  } catch {
    path = join(distRoot, "index.html");
  }
  if (path === join(distRoot, 'index.html') && !isDev) {
    const build = await buildStatus(distRoot, loadedRelease);
    if (build.status !== 'current' || createHash('sha256').update(await readFile(path)).digest('hex') !== build.indexDigest) {
      response.writeHead(503, {'Content-Type':'text/plain; charset=utf-8'});
      response.end('界面版本尚未就绪，请通过最新版启动入口重新构建。'); return;
    }
  }
  const extension = extname(path);
  response.writeHead(200, {
    "Content-Type": contentTypes[extension] || "application/octet-stream",
    "Cache-Control": path.startsWith(join(distRoot, 'assets') + sep) ? "public, max-age=31536000, immutable" : "no-cache",
  });
  createReadStream(path).pipe(response);
}

const server = createHttpServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);

  // This console is strictly read-only over canonical workflow data. Nothing here
  // accepts a body, so anything other than a read is refused rather than being
  // quietly served as a GET.
  const method = (request.method || "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    response.writeHead(405, { "Content-Type": "application/json; charset=utf-8", Allow: "GET, HEAD" });
    response.end(JSON.stringify({ error: `${method} 不被支持：该 Harness 控制台只读`, allow: ["GET", "HEAD"] }));
    return;
  }

  if (url.pathname === "/api/health") {
    try {
      // Keep launcher health checks independent from canonical workflow reads.
      // A source may live on a slow/removable volume; the registry metadata and
      // live SSE clients are sufficient to prove this server and launch binding.
      const registry = await listRegistrations(registryDir);
      const single = registry.registrations.length === 1 ? registry.registrations[0] : null;
      const launchToken = launchTokenFrom(url);
      const launchClients = launchToken ? [...clients].filter((client) => client.launchToken === launchToken).length : 0;
      writeJson(response, 200, {
        ok: true,
        binding: {
          bindingId,
          adapterVersion: loadedRelease.adapterVersion,
          ui: await buildStatus(distRoot, loadedRelease),
          sourceDigest: loadedRelease.sourceDigest,
          required: bindingConfig.frontend_required === true,
          status: "bound",
          startedAt: runtimeStartedAt,
          frontendUrl,
          registryMode: true,
          registryDir,
          connectedClients: clients.size,
          frontendAttached: clients.size > 0,
          registryCount: registry.registrations.length,
          taskCount: new Set(registry.registrations.map((item) => item.taskId)).size,
          sessionCount: new Set(registry.registrations.map((item) => `${item.taskId}\0${item.sessionId}`)).size,
          capabilities: { sourceRecovery: "persistent_verified_snapshot", executorTakeover: "ocw-local-executor-1_and_2", hostBackup: "verified_backup_cli", canonicalWrites: false },
          activeHarnesses: registry.registrations.filter((item) => item.lifecycle !== "closed").length,
          launchAttached: launchToken ? launchClients > 0 : null,
          launchClients,
          sourceRoot: single?.sourceRoot || null,
          taskId: single?.taskId || null,
          revision: null,
        },
      });
    } catch (error) {
      writeJson(response, 503, { ok: false, error: error.message });
    }
    return;
  }

  if (url.pathname === "/api/registry") {
    try {
      writeJson(response, 200, await buildRegistrySnapshot());
    } catch (error) {
      writeJson(response, 503, { error: error.message });
    }
    return;
  }

  // Cache effectiveness counters, so the polling cost is measurable rather than
  // asserted. Not part of the UI contract.
  if (url.pathname === "/api/diagnostics") {
    writeJson(response, 200, {
      ...cacheStats(),
      connectedClients: clients.size,
      uptimeMs: Date.now() - Date.parse(runtimeStartedAt),
    });
    return;
  }

  if (url.pathname === "/api/snapshot") {
    try {
      const registration = await resolveRegistration(url.searchParams.get("harness"));
      if (!registration) {
        writeJson(response, 409, { error: "请选择一个 Harness 注册项", registryRequired: true });
        return;
      }
      writeJson(response, 200, await getSnapshot(registration));
    } catch (error) {
      writeJson(response, 503, { error: error.message });
    }
    return;
  }

  if (url.pathname === "/api/stream") {
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    response.write("retry: 1800\n\n");
    const channel = url.searchParams.get("channel") === "registry" ? "registry" : "snapshot";
    const registrationId = channel === "snapshot" ? url.searchParams.get("harness") : null;
    const client = { response, send: attachSseWriter(response), channel, registrationId, launchToken: launchTokenFrom(url) };
    clients.add(client);
    scheduleBroadcast();
    request.on("close", () => {
      clients.delete(client);
      scheduleBroadcast();
    });
    try {
      if (channel === "registry") {
        sendEvent(client, "registry", await buildRegistrySnapshot());
      } else {
        const registration = await resolveRegistration(registrationId);
        if (!registration) throw new Error("请选择一个有效的 Harness 注册项");
        sendEvent(client, "snapshot", await getSnapshot(registration));
      }
    } catch (error) {
      sendEvent(client, "source-error", { message: error.message });
    }
    return;
  }

  if (vite) {
    vite.middlewares(request, response, () => {
      response.writeHead(404);
      response.end("Not found");
    });
    return;
  }

  await serveStatic(request, response);
});

await listRegistrations(registryDir);
await refreshWatches();

server.listen(port, "127.0.0.1", () => {
  console.log(`OCW Harness registry frontend: ${frontendUrl}`);
  console.log(`Runtime binding: ${bindingId} (${bindingConfig.schema_version})`);
  console.log(`Registry: ${registryDir}`);
});

async function shutdown() {
  clearInterval(heartbeat);
  if (recoveryBroadcast) clearTimeout(recoveryBroadcast);
  for (const [path, entry] of watchedPaths) unwatchFile(path, entry.listener);
  clients.forEach((client) => client.response.end());
  if (vite) await vite.close();
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
