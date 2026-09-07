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
import { validateNativeGraph, validateNativeEvidence, checkpointState, aggregateStates, nativePath } from "./scripts/native-graph.mjs";
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
  parseRouteMarkdown,
  resolveWorkflowRef,
} from "./scripts/workflow-projection.mjs";

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

// R1-R5 is the OCW protocol contract rather than per-task data, so it is the one
// structure that legitimately stays in code. Everything task-specific below is
// derived from the canonical workflow root.
const phaseDefinitions = [
  {
    id: "R1",
    title: "拆解与建模",
    owner: "Planner",
    gate: "G1",
    activePhases: ["decomposing", "decomposition_ready"],
    description: "建立目标树、检查点图和验收边界。",
  },
  {
    id: "R2",
    title: "路径探索",
    owner: "Explorers",
    gate: "G2",
    activePhases: ["exploring", "exploration_complete"],
    description: "并行探索正反路径，保留全部可证伪证据。",
  },
  {
    id: "R3",
    title: "路线协调",
    owner: "Coordinator",
    gate: "G3",
    activePhases: ["coordinating", "awaiting_user_decision"],
    description: "组合兼容路径并等待用户绑定路线。",
  },
  {
    id: "R4",
    title: "单写者实现",
    owner: "Generator",
    gate: "G4",
    activePhases: ["implementing", "verifying", "rework_required"],
    description: "在授权范围内生成候选并闭合返工。",
  },
  {
    id: "R5",
    title: "独立终审",
    owner: "Evaluators",
    gate: "G5",
    activePhases: ["auditing"],
    description: "以全新上下文复核硬门、证据和交付边界。",
  },
];

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

function stageStatus(gateStatus, active) {
  const value = String(gateStatus || "pending").toLowerCase();
  if (value.includes("pass")) return "complete";
  if (value.includes("fail") || value.includes("block") || value.includes("rework")) return "attention";
  if (active) return "active";
  return "pending";
}

function phaseProgress(id, state, features) {
  if (id === "R1") return state.checkpoint_summary?.l1_total ? 100 : 24;
  if (id === "R2") {
    const total = state.edge_summary?.total || 0;
    return total ? Math.round(((state.edge_summary?.exploration_complete || 0) / total) * 100) : 0;
  }
  if (id === "R3") return state.user_gate?.status === "selected" ? 100 : state.route_index?.length ? 72 : 0;
  if (id === "R4") {
    const items = features.features || [];
    return items.length ? Math.round((items.filter((item) => item.passes).length / items.length) * 100) : 0;
  }
  return String(state.gate_status?.G5 || "").includes("pass") ? 100 : state.phase === "auditing" ? 76 : 0;
}

function validateEventChain(events, state) {
  const issues = [];
  events.forEach((event, index) => {
    if (event.from_revision !== index || event.to_revision !== index + 1) {
      issues.push(`revision gap at ${event.event_id || index + 1}`);
    }
    if (index > 0 && events[index - 1].to_phase !== event.from_phase) {
      issues.push(`phase gap at ${event.event_id || index + 1}`);
    }
  });
  if (state.revision !== events.length) issues.push("state revision does not equal event count");
  const tail = events.at(-1);
  if (tail && tail.to_phase !== state.phase) issues.push("event tail phase does not equal state phase");
  return { healthy: issues.length === 0, issues };
}

/**
 * Status a goal inherits from its edge's accepted interface.
 *
 * Accepted records are edge/bundle scoped and carry no per-checkpoint verdict, so
 * this is deliberately a derivation and `statusSource` records that. The UI must
 * not present it as independent per-checkpoint acceptance.
 */
function checkpointStatusForGoal(goalId, acceptedEdges, activePhase, topology) {
  if (topology.executionStates?.has(goalId)) return { status: topology.executionStates.get(goalId), statusSource: 'runtime_checkpoint' };
  const record = topology?.byGoalId?.get(goalId);
  const accepted = record?.edgeId ? acceptedEdges.get(record.edgeId) : null;
  if (accepted) return { status: "complete", statusSource: "edge_accepted" };
  return {
    status: activePhase === "exploring" ? "active" : "pending",
    statusSource: "phase_inferred",
  };
}

function nodeId(raw, fallback) {
  if (typeof raw === "string") return raw;
  return raw?.checkpoint_id || raw?.goal_id || raw?.id || raw?.l1_id || fallback;
}

function childReferences(raw, depth, flatChildrenByParent) {
  if (!raw || typeof raw !== "object") return [];
  const id = nodeId(raw, "");
  const direct = raw.children || raw.checkpoints || raw.checkpoint_children || raw[`l${depth + 1}`] || [];
  const items = Array.isArray(direct) ? direct : [];
  const flat = id ? flatChildrenByParent.get(id) || [] : [];
  const seen = new Set();
  return [...items, ...flat].filter((item) => {
    const key = nodeId(item, JSON.stringify(item));
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeCheckpointTree(graph, acceptedEdges, activePhase, agentActivity, topology, overlay) {
  const checkpointMap = new Map(
    (graph.checkpoints || []).map((checkpoint) => [checkpoint.checkpoint_id, checkpoint]),
  );
  const flatChildrenByParent = new Map();
  for (const checkpoint of graph.checkpoints || []) {
    const parentId = checkpoint.parent_checkpoint_id || checkpoint.parent_goal_id || checkpoint.parent_id;
    if (!parentId) continue;
    const children = flatChildrenByParent.get(parentId) || [];
    children.push(checkpoint);
    flatChildrenByParent.set(parentId, children);
  }

  function buildNode(source, depth, inherited, path = new Set(), fallbackId = "node") {
    const resolved = typeof source === "string" ? checkpointMap.get(source) || { checkpoint_id: source } : source;
    const id = nodeId(resolved, fallbackId);
    if (path.has(id) || depth > 32) return null;
    const isCheckpoint = Boolean(resolved?.checkpoint_id || checkpointMap.has(id));
    const cp = isCheckpoint ? (checkpointMap.get(id) || resolved) : null;
    const nextPath = new Set(path);
    nextPath.add(id);
    const children = childReferences(resolved, depth, flatChildrenByParent)
      .map((child, index) => buildNode(child, depth + 1, inherited, nextPath, `${id}-${index + 1}`))
      .filter(Boolean);
    const record = topology?.byGoalId?.get(id) || null;
    const edgeId = record?.edgeId || inherited.edgeId || null;
    const worker = resolveWorker(agentActivity, { checkpointId: isCheckpoint ? id : null, edgeId });

    return {
      id,
      label: overlayField(overlay, "goals", id) || resolved?.label || resolved?.title || id,
      objective: cp?.objective || resolved?.objective || record?.objective || "等待补充节点说明",
      depth,
      kind: isCheckpoint ? "checkpoint" : "goal",
      ...(cp?.execution_status ? checkpointState(cp) : children.length && graph.schema_version === 'ocw-graph-2' ? {status: aggregateStates(children.map(child => child.status)), statusSource: 'derived'} : {status: inherited.status, statusSource: inherited.statusSource}),
      edgeId,
      checkpointId: isCheckpoint ? id : null,
      worker,
      acceptanceOracle: cp?.acceptance_oracle || null,
      invariants: cp?.invariants || [],
      dependsOn: cp?.depends_on || [],
      providesTo: cp?.provides_to || [],
      children,
    };
  }

  const roots = (graph.goal_tree || []).map((goal, index) => {
    const goalId = nodeId(goal, `L1-${index + 1}`);
    const derived = checkpointStatusForGoal(goalId, acceptedEdges, activePhase, topology);
    return buildNode(
      goal,
      1,
      { ...derived, edgeId: topology?.byGoalId?.get(goalId)?.edgeId || null },
      new Set(),
      goalId,
    );
  }).filter(Boolean);
  const rootStatus = roots.every((node) => node.status === "complete") ? "complete" : "active";
  const root = {
    id: "R1",
    label: "拆解与建模",
    objective: graph.root_goal || "建立目标树、检查点图和验收边界。",
    depth: 0,
    kind: "phase",
    status: rootStatus,
    statusSource: "derived",
    edgeId: null,
    checkpointId: null,
    children: roots,
  };
  let currentMaxDepth = 0;
  function measure(node) {
    currentMaxDepth = Math.max(currentMaxDepth, node.depth);
    node.children.forEach(measure);
  }
  measure(root);
  return {
    schemaVersion: String(graph.schema_version || "unknown"),
    currentMaxDepth,
    rendererMaxDepth: 32,
    recursive: true,
    root,
  };
}

function normalizeRouteFlow(state, decision, result, routeBodies) {
  const candidates = (state.route_index || [])
    .map((route) => {
      const parsed = parseRouteMarkdown(routeBodies[route.route_id] || "");
      return {
        id: route.route_id,
        revision: route.route_revision,
        title: parsed.title,
        rank: route.rank,
        routeClass: route.route_class,
        status: route.status,
        selected: route.status === "selected" || decision.selected_route === route.route_id,
        recommended: Boolean(route.recommended),
        selectedAtRevision: route.selected_at_revision ?? null,
        evidenceCeiling: route.evidence_ceiling,
        ref: route.ref,
        digest: route.sha256,
        pathSequence: parsed.pathSequence,
      };
    })
    .sort((a, b) => a.rank - b.rank);

  const candidateHistory = (result.candidate_history || []).map((candidate) => ({
    number: candidate.candidate,
    digest: candidate.product_sha256,
    semanticVerdict: candidate.independent_semantic_verdict || "unknown",
    mechanicalVerdict: candidate.mechanical_boundary_verdict || "unknown",
    status: candidate.status || "reviewed",
    corrections: candidate.bounded_corrections || [],
    passed: candidate.R5_verdict === "pass" || String(candidate.status || "").includes("complete"),
  }));
  const mirror = result.write_set?.delivery_mirror;

  return {
    candidates,
    decision: {
      id: decision.decision_id || "unavailable",
      status: decision.status || state.user_gate?.status || "unknown",
      selectedRoute: decision.selected_route || state.user_gate?.selected_route || null,
      routeRevision: decision.route_revision ?? state.user_gate?.route_revision ?? null,
      stateRevision: decision.state_revision ?? state.user_gate?.selected_at_revision ?? null,
      phaseScope: decision.allowed_scope?.phase || null,
      requiredContent: decision.allowed_scope?.required_content || [],
      explicitOutOfScope: decision.explicit_out_of_scope || [],
    },
    implementation: {
      routeId: decision.selected_route || state.user_gate?.selected_route || null,
      status: result.status || "pending",
      productRef: result.product_ref || null,
      productDigest: result.product_sha256 || null,
      productLines: result.product_metrics?.lines ?? null,
      productWords: result.product_metrics?.words ?? null,
      vectorCount: result.embedded_vector_inventory?.deterministically_expanded_total ?? null,
      mirrorPassed: mirror?.independent_R5 === "pass",
      r5Verdict: candidateHistory.at(-1)?.passed ? "pass" : "pending",
      deploymentStatus: result.deployment_status || "unknown",
      claimCeiling: result.claim_ceiling || {},
      candidateHistory,
    },
  };
}

function compactAttemptDetails(attempts) {
  return new Map(
    (attempts || [])
      .filter((attempt) => attempt?.path_id)
      .map((attempt) => [attempt.path_id, attempt]),
  );
}

function selectedPathParts(routeFlow) {
  const exact = new Set();
  const suffixes = new Set();
  const selectedRoute = routeFlow.candidates.find((route) => route.selected);
  for (const entry of selectedRoute?.pathSequence || []) {
    const [base, suffix] = entry.split("@");
    exact.add(base);
    if (suffix) suffixes.add(suffix);
  }
  return { exact, suffixes };
}

/** Turn `R2_path_explorer` into `R2 路径探索` without a per-edge lookup table. */
function roleLabel(rawRole, phase) {
  const role = String(rawRole || "").trim();
  if (!role) return phase ? `${phase} 子代理` : "未记录角色";
  const stage = role.match(/^(R\d)[_-]?/i)?.[1]?.toUpperCase() || phase || "";
  const rest = role.replace(/^R\d[_-]?/i, "").trim();
  const known = {
    path_explorer: "路径探索",
    explorer: "路径探索",
    coordinator: "路线协调",
    generator: "单写者实现",
    implementer: "单写者实现",
    single_writer: "单写者实现",
    evaluator: "独立终审",
    auditor: "独立终审",
    planner: "拆解与建模",
    reducer: "状态归约",
  }[rest.toLowerCase()];
  // An unrecognized role stays a verbatim identifier rather than being reflowed
  // into prose that reads like a translation.
  return [stage, known || rest || "子代理"].filter(Boolean).join(" ");
}

/**
 * Project the agents at work from canonical state plus each assignment's own spec.
 *
 * State lists assignments but not the checkpoints they cover; `assignments/<id>.json`
 * carries `checkpoint_ids` and `role`, so the specs are what make checkpoint-level
 * ownership real rather than inferred from the enclosing edge.
 */
function normalizeAgentActivity(state, assignmentSpecs = new Map()) {
  const rawList = Array.isArray(state.active_assignments) ? state.active_assignments : [];
  const assignmentsById = new Map(
    (Array.isArray(state.assignments) ? state.assignments : []).map((a) => [a.assignment_id, a]),
  );
  const currentAssignments = rawList
    .map((item) => (typeof item === "string" ? assignmentsById.get(item) || { assignment_id: item } : item))
    .concat(Array.isArray(state.assignments) ? state.assignments : [])
    .filter((assignment, index, self) => {
      if (!assignment || !assignment.assignment_id) return false;
      if (String(assignment.status || "").includes("invalidated_history")) return false;
      return self.findIndex((a) => a?.assignment_id === assignment.assignment_id) === index;
    });

  const assignments = currentAssignments.map((assignment) => {
    const spec = assignmentSpecs.get(assignment.assignment_id) || {};
    const status = String(assignment.status || spec.status || "unknown");
    const history = assignment.executor_history || spec.executor_history || [];
    const latestWithAgent = [...history].reverse().find((entry) => entry.agent_ref);
    const agentRef = assignment.agent_ref || spec.agent_ref || latestWithAgent?.agent_ref || null;
    const terminalSuccess = /accepted|completed|complete|passed|pass/.test(status);
    const terminalProblem = /failed|rejected|terminated|interrupted|violation|invalidated|error/.test(status);
    const looksWorking = /active|working|running|started|in_progress|dispatched|executing|repair/.test(status);
    const working = !terminalOutcome(state.phase) && !terminalSuccess && !terminalProblem && looksWorking;
    const workState = working ? "working" : terminalSuccess || state.phase === "complete" ? "complete" : terminalProblem ? "attention" : "queued";
    const phase = String(assignment.assignment_id).match(/^ASG-(R\d)/i)?.[1]?.toUpperCase() || null;
    const checkpointIds = assignment.checkpoint_ids
      || spec.checkpoint_ids
      || (assignment.checkpoint_id ? [assignment.checkpoint_id] : []);
    return {
      assignmentId: assignment.assignment_id,
      workerInstanceId: assignment.worker_instance_id || spec.worker_instance_id || null,
      sessionId: assignment.session_id || spec.session_id || null,
      // An R4 single-writer assignment has no edge; it is scoped to the route instead.
      edgeId: assignment.edge_id || spec.edge_id || null,
      routeId: assignment.route_id || spec.route_id || null,
      phase,
      agentRef,
      displayName: agentRef ? agentRef.split("/").filter(Boolean).at(-1) : "未记录 agent_ref",
      role: roleLabel(spec.role || assignment.role, phase),
      status,
      workState,
      working,
      updatedAt: state.updated_at,
      attemptId: assignment.attempt_id || null,
      leaseEpoch: assignment.lease_epoch ?? null,
      leaseExpiresAt: assignment.lease_expires_at ? new Date(assignment.lease_expires_at * 1000).toISOString() : null,
      checkpointIds: Array.isArray(checkpointIds) ? checkpointIds : [],
      pathIds: assignment.path_ids || spec.path_ids || (assignment.path_id ? [assignment.path_id] : []),
    };
  });

  const byEdge = new Map();
  const byCheckpoint = new Map();
  const byPath = new Map();
  for (const assignment of assignments) {
    if (assignment.edgeId) {
      const existing = byEdge.get(assignment.edgeId);
      // Prefer a working assignment so an edge reflects live activity, not history.
      if (!existing || (assignment.working && !existing.working)) byEdge.set(assignment.edgeId, assignment);
    }
    assignment.checkpointIds.forEach((checkpointId) => {
      const existing = byCheckpoint.get(checkpointId);
      if (!existing || (assignment.working && !existing.working)) byCheckpoint.set(checkpointId, assignment);
    });
    assignment.pathIds.forEach(pathId => { const existing = byPath.get(pathId); if (!existing || assignment.working && !existing.working) byPath.set(pathId, assignment); });
  }
  return {
    workingCount: assignments.filter((assignment) => assignment.working).length,
    assignments,
    byEdge,
    byCheckpoint,
    byPath,
  };
}

/**
 * Resolve who owns a node at the most specific scope available, and say which
 * scope it came from. Previously an edge-level assignment was silently attached
 * to every checkpoint under it, which reads as direct ownership; `scope` lets the
 * UI label inherited bindings instead of overstating them.
 */
function resolveWorker(agentActivity, { pathId = null, checkpointId = null, edgeId = null } = {}) {
  if (!agentActivity) return null;
  const direct = [
    [pathId && agentActivity.byPath?.get(pathId), "path"],
    [checkpointId && agentActivity.byCheckpoint?.get(checkpointId), "checkpoint"],
  ];
  for (const [candidate, scope] of direct) {
    if (candidate) return { ...candidate, scope, inherited: false };
  }
  const fromEdge = edgeId ? agentActivity.byEdge?.get(edgeId) : null;
  if (agentActivity.native && fromEdge && (checkpointId && fromEdge.checkpointIds.length && !fromEdge.checkpointIds.includes(checkpointId) || pathId && fromEdge.pathIds.length && !fromEdge.pathIds.includes(pathId))) return null;
  if (!fromEdge) return null;
  const ownsThisNode = checkpointId
    ? fromEdge.checkpointIds.includes(checkpointId)
    : pathId
      ? fromEdge.pathIds.includes(pathId)
      : true;
  return { ...fromEdge, scope: "edge", inherited: !ownsThisNode };
}

/** Derive a category from an id's own prefix rather than a per-task table. */
function pathCategory(attempt) {
  if (attempt.path_category) return attempt.path_category;
  const segment = String(attempt.path_id || "").match(/^PATH-([A-Z]+)/)?.[1];
  if (!segment) return "mechanism";
  return segment === "AUTHORITY" || segment === "BOOTSTRAP" ? segment.toLowerCase() : "mechanism";
}

/**
 * Project one edge's explored paths.
 *
 * Labels and summaries come from the path's own memory markdown (declared by
 * `memory_ref`) and its recorded mechanism class; the optional overlay only
 * supplies nicer display text. Attempt collection is shape-driven, replacing the
 * former `if (edgeId === "EDGE-03-...")` special cases.
 */
function normalizeJourneyPaths(edgeId, attempts, supplementalAttempts, selectedParts, legacyAttempts, memos, overlay) {
  const supplement = compactAttemptDetails(supplementalAttempts);
  const legacy = compactAttemptDetails(legacyAttempts);

  return attempts.map((attempt, index) => {
    const extra = supplement.get(attempt.path_id) || {};
    const prior = legacy.get(attempt.path_id) || {};
    const memo = memos?.get(attempt.path_id) || { title: null, summary: null };
    const selected = selectedParts.exact.has(attempt.path_id) || selectedParts.suffixes.has(attempt.path_id);
    const summary = extra.summary
      || extra.reason
      || extra.claim_scope
      || attempt.claim_scope
      || attempt.exclusion_reason
      || memo.summary
      || overlayField(overlay, "paths", attempt.path_id, "summary")
      || "该路径只记录了结构化结果，未提供额外摘要。";
    return {
      id: attempt.path_id,
      edgeId,
      label: memo.title
        || overlayField(overlay, "paths", attempt.path_id)
        || attempt.path_id,
      shortLabel: attempt.short_label || overlayField(overlay, "paths", attempt.path_id, "shortLabel") || null,
      order: index + 1,
      origin: attempt.origin || "accepted",
      category: pathCategory(attempt),
      status: attempt.status || extra.status || "unknown",
      selected,
      mechanism: attempt.mechanism || attempt.mechanism_class || extra.mechanism || extra.mechanism_class || prior.mechanism_class || attempt.path_id,
      summary,
      reason: attempt.exclusion_reason || extra.exclusion_reason || extra.reason || null,
      keyCost: extra.key_cost || null,
      claimScope: attempt.claim_scope || extra.claim_scope || null,
      evidenceLevel: attempt.evidence_level || extra.evidence_level || null,
      deploymentStatus: attempt.deployment_status || extra.deployment_status || null,
      memoryRef: attempt.memory_ref || null,
      evidenceRef: attempt.evidence_ref || null,
    };
  });
}

function normalizeJourney(graph, groups, routeFlow, edgeEvidence, agentActivity, checkpointTree, topology, overlay) {
  const graphEdges = new Map((graph.dependency_dag?.edges || []).map((edge) => [edge.edge_id, edge]));
  const groupByEdge = new Map(groups.map((group) => [group.edgeId, group]));
  const selectedParts = selectedPathParts(routeFlow);

  // One pass over whatever edges the graph declares, instead of a fixed map.
  const pathSets = new Map();
  for (const edgeId of graphEdges.keys()) {
    const evidence = edgeEvidence.get(edgeId) || {};
    if (graph.schema_version === 'ocw-graph-2') { pathSets.set(edgeId, graph.paths.filter(p => p.edge_id === edgeId).map(nativePath)); continue; }
    pathSets.set(
      edgeId,
      normalizeJourneyPaths(
        edgeId,
        evidence.attempts || [],
        evidence.supplementalAttempts || [],
        selectedParts,
        evidence.legacyAttempts || [],
        evidence.memos,
        overlay,
      ),
    );
  }

  const topologicalLayers = graph.dependency_dag?.topological_layers || [];
  const layers = topologicalLayers.map((edgeIds, layerIndex) => {
    const nodes = edgeIds.map((edgeId) => {
      const edge = graphEdges.get(edgeId);
      const group = groupByEdge.get(edgeId);
      const goalId = topology.byEdge.get(edgeId)?.goalId || group?.id || edge?.to;
      const worker = resolveWorker(agentActivity, { edgeId });
      const treeNode = checkpointTree?.root?.children?.find(
        (child) => child.id === goalId || child.edgeId === edgeId,
      ) || null;
      return {
        id: edge?.to || edgeId,
        goalId,
        edgeId: edgeId || null,
        label: group?.label || goalId,
        objective: group?.objective || "等待目标说明",
        status: group?.status || "pending",
        statusSource: group?.statusSource || "phase_inferred",
        worker,
        treeNode,
        checkpoints: (group?.checkpoints || []).map((checkpoint) => ({
          ...checkpoint,
          worker: resolveWorker(agentActivity, { checkpointId: checkpoint.id, edgeId }),
        })),
      };
    });
    return {
      index: layerIndex + 1,
      label: `正交任务层 ${layerIndex + 1}`,
      orthogonal: nodes.length > 1,
      nodes,
    };
  });

  const transitions = topologicalLayers.map((edgeIds, layerIndex) => ({
    index: layerIndex + 1,
    label: layerIndex === 0 ? "从目标展开" : `进入第 ${layerIndex + 1} 层`,
    edges: edgeIds.map((edgeId) => {
      const edge = graphEdges.get(edgeId) || {};
      const record = topology.byEdge.get(edgeId);
      const pathsForEdge = pathSets.get(edgeId) || [];
      const worker = resolveWorker(agentActivity, { edgeId });
      const group = groupByEdge.get(edgeId);
      return {
        id: edgeId,
        label: overlayField(overlay, "edges", edgeId) || record?.label || edgeId,
        shortLabel: overlayField(overlay, "edges", edgeId, "shortLabel") || record?.shortLabel || edgeId,
        from: edge.from || [],
        to: edge.to || "unknown",
        startGuarantees: edge.start_guarantees || [],
        endGuarantees: edge.end_guarantees || [],
        status: group?.status || "pending",
        statusSource: group?.statusSource || "phase_inferred",
        acceptedRevision: group?.acceptedRevision ?? null,
        priorRevisions: edgeEvidence.get(edgeId)?.priorRevisions || [],
        worker,
        paths: pathsForEdge.map((path) => ({
          ...path,
          worker: resolveWorker(agentActivity, { pathId: path.id, edgeId }),
        })),
        selectedPaths: pathsForEdge.filter((path) => path.selected).length,
      };
    }),
  }));

  return {
    root: {
      id: "ROOT",
      label: "总目标",
      objective: graph.root_goal,
      status: layers.every((layer) => layer.nodes.every((node) => node.status === "complete")) ? "complete" : "active",
    },
    layers,
    transitions,
    routes: routeFlow.candidates,
    selectedRoute: routeFlow.candidates.find((route) => route.selected) || null,
    implementation: routeFlow.implementation,
    pathGranularity: "bundle_transition",
    cycleCheck: graph.dependency_dag?.cycle_check || "unknown",
  };
}

function normalizeEvent(event) {
  const rawType = String(event.type || "workflow_event");
  const lower = rawType.toLowerCase();
  let tone = "neutral";
  if (lower.includes("fail") || lower.includes("reject") || lower.includes("violation")) tone = "danger";
  else if (lower.includes("rework") || lower.includes("pending") || lower.includes("blocked")) tone = "warning";
  else if (lower.includes("pass") || lower.includes("accept") || lower.includes("complete")) tone = "success";

  return {
    eventId: event.event_id,
    type: rawType,
    fromRevision: event.from_revision,
    toRevision: event.to_revision,
    fromPhase: event.from_phase,
    toPhase: event.to_phase,
    actor: event.actor || "unknown",
    at: event.at,
    tone,
    payload: event,
  };
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
  const agentActivity = normalizeAgentActivity(state, assignmentSpecs);
  agentActivity.native = native;
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
