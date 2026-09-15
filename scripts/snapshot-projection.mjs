/**
 * Canonical workflow data in, UI wire shapes out.
 *
 * Every function here takes already-parsed canonical data and returns the shape
 * the console renders, with no filesystem, network or process access of its own.
 * That separation is what makes the projection rules testable in isolation and
 * reusable by a different frontend; the server keeps transport, reads, caching
 * and orchestration on its side of the boundary.
 */

import { overlayField, parseRouteMarkdown } from "./workflow-projection.mjs";
import { checkpointState, aggregateStates, nativePath } from "./native-graph.mjs";
import { terminalOutcome } from "./runtime-state.mjs";

// R1-R5 is the OCW protocol contract rather than per-task data, so it is the one
// structure that legitimately stays in code. Everything task-specific below is
// derived from the canonical workflow root.
export const phaseDefinitions = [
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

export function stageStatus(gateStatus, active) {
  const value = String(gateStatus || "pending").toLowerCase();
  if (value.includes("pass")) return "complete";
  if (value.includes("fail") || value.includes("block") || value.includes("rework")) return "attention";
  if (active) return "active";
  return "pending";
}

export function phaseProgress(id, state, features) {
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

export function validateEventChain(events, state) {
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
export function checkpointStatusForGoal(goalId, acceptedEdges, activePhase, topology) {
  if (topology.executionStates?.has(goalId)) return { status: topology.executionStates.get(goalId), statusSource: 'runtime_checkpoint' };
  const record = topology?.byGoalId?.get(goalId);
  const accepted = record?.edgeId ? acceptedEdges.get(record.edgeId) : null;
  if (accepted) return { status: "complete", statusSource: "edge_accepted" };
  return {
    status: activePhase === "exploring" ? "active" : "pending",
    statusSource: "phase_inferred",
  };
}

export function nodeId(raw, fallback) {
  if (typeof raw === "string") return raw;
  return raw?.checkpoint_id || raw?.goal_id || raw?.id || raw?.l1_id || fallback;
}

export function childReferences(raw, depth, flatChildrenByParent) {
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

export function normalizeCheckpointTree(graph, acceptedEdges, activePhase, agentActivity, topology, overlay) {
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

export function normalizeRouteFlow(state, decision, result, routeBodies) {
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

export function compactAttemptDetails(attempts) {
  return new Map(
    (attempts || [])
      .filter((attempt) => attempt?.path_id)
      .map((attempt) => [attempt.path_id, attempt]),
  );
}

export function selectedPathParts(routeFlow) {
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
export function roleLabel(rawRole, phase) {
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
export function normalizeAgentActivity(state, assignmentSpecs = new Map()) {
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
export function resolveWorker(agentActivity, { pathId = null, checkpointId = null, edgeId = null } = {}) {
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
export function pathCategory(attempt) {
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
export function normalizeJourneyPaths(edgeId, attempts, supplementalAttempts, selectedParts, legacyAttempts, memos, overlay) {
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

export function normalizeJourney(graph, groups, routeFlow, edgeEvidence, agentActivity, checkpointTree, topology, overlay) {
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

export function normalizeEvent(event) {
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
