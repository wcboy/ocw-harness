/**
 * Pure projection helpers for an OCW canonical workflow root.
 *
 * The console reads exactly four protocol anchors by name; every other file it
 * needs is reachable through a ref the canonical data declares about itself
 * (`accepted_interfaces[].ref`, `route_index[].ref`, `active_assignments[].result_ref`,
 * `dependency_dag.edges[].assignment_ref`, `accepted_attempts[].memory_ref`).
 * Nothing here may hardcode a specific task's goal, bundle, edge, route or path ids.
 *
 * Functions in this module do no I/O so they stay unit-testable: they return
 * workflow-relative refs and derived topology, and the server performs the reads.
 */

import { isAbsolute, join, normalize, sep } from "node:path";

/** The only filenames the protocol fixes. Everything else is discovered. */
export const ANCHORS = Object.freeze({
  state: "state.json",
  events: "events.jsonl",
  graph: "checkpoint-graph.json",
  decision: "decision.json",
});

export function anchorPaths(workflowRoot) {
  const root = normalize(workflowRoot);
  return {
    state: join(root, ANCHORS.state),
    events: join(root, ANCHORS.events),
    graph: join(root, ANCHORS.graph),
    decision: join(root, ANCHORS.decision),
  };
}

/**
 * Resolve a workflow-relative ref to an absolute path, refusing anything that
 * would escape the workflow root. State files are canonical but still untrusted
 * input to this process, so every ref-driven read passes through here.
 *
 * Absolute refs are rejected rather than silently re-rooted. Genuinely external
 * artifacts (`result.product_ref`, the delivery mirror) are absolute by design
 * and are read outside this guard.
 */
export function resolveWorkflowRef(workflowRoot, ref) {
  if (typeof ref !== "string") return null;
  const trimmed = ref.trim();
  if (!trimmed || trimmed.includes("\0") || isAbsolute(trimmed)) return null;
  const root = normalize(workflowRoot);
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  const path = normalize(join(root, trimmed));
  if (path !== root && !path.startsWith(prefix)) return null;
  return path;
}

function idOf(raw) {
  if (typeof raw === "string") return raw;
  if (!raw || typeof raw !== "object") return null;
  const direct = raw.checkpoint_id || raw.goal_id || raw.id;
  if (direct) return direct;
  // Goal levels are named by depth (`l1_id`, `l2_id`, ...), so match any of them.
  const levelKey = Object.keys(raw).find((key) => /^l\d+_id$/.test(key));
  return (levelKey && raw[levelKey]) || null;
}

/** Collect leaf unit ids under a goal at any depth (l2, l3, ... or children). */
function collectGoalUnits(goal, depth = 1, seen = new Set()) {
  if (!goal || typeof goal !== "object") return [];
  const buckets = [goal[`l${depth + 1}`], goal.children, goal.checkpoints, goal.units];
  const units = [];
  for (const bucket of buckets) {
    if (!Array.isArray(bucket)) continue;
    for (const entry of bucket) {
      const id = idOf(entry);
      if (id && !seen.has(id)) {
        seen.add(id);
        units.push(id);
      }
      if (entry && typeof entry === "object") {
        units.push(...collectGoalUnits(entry, depth + 1, seen));
      }
    }
  }
  return units;
}

/** Strip a leading positional prefix (`L1-`, `EDGE-04-`) without inventing words. */
function shortenId(id) {
  return String(id || "").replace(/^(?:L\d+|EDGE-\d+|BUNDLE)[-_]/, "") || String(id || "");
}

/**
 * Derive the goal <-> bundle <-> edge topology straight from the graph.
 *
 * Replaces the former hardcoded `groupMeta` / `edgeMeta` / `bundleToGoal` tables:
 * `dependency_dag.edges[].to` names a coupling bundle, the bundle's `units` are
 * checkpoint ids, and the goal that owns those checkpoints is the goal the edge
 * advances. Matching is by best unit overlap so a partially-listed bundle still
 * resolves instead of dropping to "UNKNOWN".
 */
export function deriveTopology(graph) {
  const dag = graph?.dependency_dag || {};
  const edges = Array.isArray(dag.edges) ? dag.edges : [];
  const topologicalLayers = Array.isArray(dag.topological_layers) ? dag.topological_layers : [];
  const bundles = Array.isArray(graph?.coupling_bundles) ? graph.coupling_bundles : [];
  const goals = Array.isArray(graph?.goal_tree) ? graph.goal_tree : [];

  const unitsByBundle = new Map(
    bundles.map((bundle) => [bundle.bundle_id, (bundle.units || []).map(idOf).filter(Boolean)]),
  );
  const goalUnits = goals.map((goal, index) => ({
    goal,
    goalId: idOf(goal) || `L1-${index + 1}`,
    units: new Set(collectGoalUnits(goal)),
  }));

  function goalForUnits(units) {
    let best = null;
    let bestOverlap = 0;
    for (const candidate of goalUnits) {
      const overlap = units.reduce((count, unit) => count + (candidate.units.has(unit) ? 1 : 0), 0);
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        best = candidate;
      }
    }
    return bestOverlap > 0 ? best : null;
  }

  const layerIndexByEdge = new Map();
  topologicalLayers.forEach((edgeIds, layerIndex) => {
    (Array.isArray(edgeIds) ? edgeIds : []).forEach((edgeId) => {
      if (!layerIndexByEdge.has(edgeId)) layerIndexByEdge.set(edgeId, layerIndex + 1);
    });
  });

  const flatOrder = topologicalLayers.flat().filter(Boolean);
  const records = [];
  const byEdge = new Map();
  const byGoalId = new Map();
  const byBundle = new Map();

  edges.forEach((edge, index) => {
    const edgeId = edge?.edge_id;
    if (!edgeId) return;
    const target = edge.to;
    const bundleUnits = unitsByBundle.get(target) || [];
    const matched = bundleUnits.length
      ? goalForUnits(bundleUnits)
      : goalUnits.find((candidate) => candidate.goalId === target) || null;

    const goalId = matched?.goalId || target || edgeId;
    const sequencePosition = flatOrder.indexOf(edgeId);
    const record = {
      edgeId,
      goalId,
      bundleId: unitsByBundle.has(target) ? target : null,
      objective: matched?.goal?.objective || "",
      unitIds: matched ? [...matched.units] : bundleUnits,
      layerIndex: layerIndexByEdge.get(edgeId) || 0,
      sequence: sequencePosition >= 0 ? sequencePosition + 1 : index + 1,
      label: goalId,
      shortLabel: shortenId(goalId),
      resolved: Boolean(matched),
    };
    records.push(record);
    byEdge.set(edgeId, record);
    if (!byGoalId.has(goalId)) byGoalId.set(goalId, record);
    if (record.bundleId && !byBundle.has(record.bundleId)) byBundle.set(record.bundleId, record);
  });

  // Goals with no edge still need a stable record so the tree can render them.
  goalUnits.forEach((candidate, index) => {
    if (byGoalId.has(candidate.goalId)) return;
    const record = {
      edgeId: null,
      goalId: candidate.goalId,
      bundleId: null,
      objective: candidate.goal?.objective || "",
      unitIds: [...candidate.units],
      layerIndex: 0,
      sequence: records.length + index + 1,
      label: candidate.goalId,
      shortLabel: shortenId(candidate.goalId),
      resolved: true,
    };
    records.push(record);
    byGoalId.set(candidate.goalId, record);
  });

  return {
    records,
    byEdge,
    byGoalId,
    byBundle,
    layerIndexByEdge,
    goalIdByBundleId: new Map([...byBundle].map(([bundleId, record]) => [bundleId, record.goalId])),
  };
}

/** True when a heading fragment is just another identifier rather than prose. */
function looksLikeIdentifier(text) {
  return /^(?:EDGE|BUNDLE|PATH|ROUTE|CP|ASG|L\d)[-_\s]?[A-Z0-9][A-Z0-9-_\s]*$/.test(String(text || "").trim());
}

/**
 * Pull a human label and mechanism summary out of a path memory markdown file.
 *
 * These files are what the former `pathLabels` / `pathFallbackDetails` tables were
 * transcribed from by hand, so reading them removes the tables and keeps the text
 * in sync with the evidence. Headings that merely echo another id (for example
 * `# PATH-02-GENERATION-POINTER — EDGE-02-STATE-EVIDENCE`) yield no title.
 */
export function parsePathMemo(markdown) {
  const body = String(markdown || "");
  if (!body.trim()) return { title: null, summary: null };

  const heading = body.match(/^#\s+(.+)$/m)?.[1]?.trim() || "";
  let title = null;
  const separated = heading.split(/\s+[—–-]\s+/);
  if (separated.length > 1) {
    const tail = separated.slice(1).join(" — ").trim();
    if (tail && !looksLikeIdentifier(tail)) title = tail;
  }

  const mechanism = body.match(/^[-*]\s*(?:机制等价类|mechanism class)\s*[：:]\s*(.+)$/im)?.[1]?.trim();
  let summary = mechanism || null;
  if (!summary) {
    const sectionBody = body.split(/^##\s+.+$/m).slice(1).join("\n");
    summary = sectionBody
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 24 && !/^[-*#>|]/.test(line) && !line.startsWith("```")) || null;
  }
  return { title, summary };
}

export function parseRouteMarkdown(markdown) {
  const headingLine = String(markdown || "").match(/^#\s+(.+)$/m)?.[1]?.trim() || "候选路线";
  const heading = headingLine.includes("—")
    ? headingLine.split("—").slice(1).join("—").trim()
    : headingLine.replace(/^ROUTE-\d+-[A-Z]+\s*[-:]\s*/, "");
  const sequenceBlock = String(markdown || "").match(/^path_sequence:\s*\n((?:\s{2}-\s+[^\n]+\n?)+)/m)?.[1] || "";
  const pathSequence = sequenceBlock
    .split(/\r?\n/)
    .map((line) => line.match(/^\s{2}-\s+(.+)$/)?.[1]?.trim())
    .filter(Boolean);
  return { title: heading, pathSequence };
}

/** An accepted interface is current unless it has been explicitly superseded. */
export function isCurrentAcceptedInterface(item) {
  if (!item) return false;
  if (item.status) return item.status === "current";
  return item.accepted_at_revision != null;
}

function assignmentPhase(assignment) {
  const ref = String(assignment?.result_ref || "");
  const fromRef = ref.match(/(?:^|\/)inbox\/(r\d)\//i)?.[1];
  if (fromRef) return fromRef.toUpperCase();
  const fromId = String(assignment?.assignment_id || "").match(/^ASG-(R\d)/i)?.[1];
  return fromId ? fromId.toUpperCase() : null;
}

/**
 * Enumerate every source the console needs, as workflow-relative refs declared
 * by the canonical data itself. Replaces the former hardcoded `workflowPaths()`
 * map, whose revision-baked filenames (`EDGE-01-STRUCTURE.rev6.json`) silently
 * went stale and whose omissions dropped real evidence.
 */
export function discoverSources(state, graph) {
  const acceptedByEdge = new Map();
  for (const item of state?.accepted_interfaces || []) {
    const edgeId = item?.edge_id;
    if (!edgeId || !item.ref) continue;
    const entry = acceptedByEdge.get(edgeId) || { current: null, history: [] };
    const record = {
      edgeId,
      ref: item.ref,
      revision: item.accepted_at_revision ?? null,
      status: item.status || null,
      invalidationReason: item.invalidation_reason || null,
      digest: item.sha256 || null,
      current: isCurrentAcceptedInterface(item),
    };
    if (record.current) entry.current = record;
    else entry.history.push(record);
    acceptedByEdge.set(edgeId, entry);
  }
  for (const entry of acceptedByEdge.values()) {
    entry.history.sort((a, b) => (a.revision ?? 0) - (b.revision ?? 0));
  }

  const resultsByEdge = new Map();
  const phaseResults = new Map();
  const assignmentSpecRefs = new Map();
  for (const assignment of state?.active_assignments || []) {
    if (!assignment || typeof assignment !== "object") continue;
    const assignmentId = assignment.assignment_id;
    if (assignmentId) {
      assignmentSpecRefs.set(assignmentId, `assignments/${assignmentId}.json`);
    }
    if (!assignment.result_ref) continue;
    const record = {
      assignmentId,
      edgeId: assignment.edge_id || null,
      ref: assignment.result_ref,
      status: assignment.status || null,
      acceptedInterfaceRef: assignment.accepted_interface_ref || null,
      phase: assignmentPhase(assignment),
    };
    if (record.edgeId) {
      const list = resultsByEdge.get(record.edgeId) || [];
      list.push(record);
      resultsByEdge.set(record.edgeId, list);
    }
    if (record.phase) {
      const list = phaseResults.get(record.phase) || [];
      list.push(record);
      phaseResults.set(record.phase, list);
    }
  }

  // Assignment specs are also declared on graph edges, which covers assignments
  // that state no longer lists as active.
  for (const edge of graph?.dependency_dag?.edges || []) {
    const ref = edge?.assignment_ref;
    if (!ref) continue;
    const assignmentId = String(ref).split("/").at(-1)?.replace(/\.json$/, "");
    if (assignmentId && !assignmentSpecRefs.has(assignmentId)) {
      assignmentSpecRefs.set(assignmentId, ref);
    }
  }

  const routeRefs = new Map();
  for (const route of state?.route_index || []) {
    if (route?.route_id && route.ref) routeRefs.set(route.route_id, route.ref);
  }

  const memoRefs = new Map();
  for (const entry of acceptedByEdge.values()) {
    for (const record of [entry.current, ...entry.history].filter(Boolean)) {
      memoRefs.set(record.ref, record.edgeId);
    }
  }

  return {
    acceptedByEdge,
    resultsByEdge,
    phaseResults,
    assignmentSpecRefs,
    routeRefs,
    acceptedRefs: [...memoRefs.keys()],
    implementationRef: "task-memory/implementation",
  };
}

/**
 * Coerce an optional display-label overlay into a known shape.
 *
 * The overlay is app-side presentation data (`labels/<task_id>.json`), never read
 * from and never written to the canonical workflow root. When it is absent the
 * console shows raw identifiers rather than inventing prose.
 */
export function normalizeLabelOverlay(raw) {
  const pick = (value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value).filter(([key, entry]) => key && (typeof entry === "string" || (entry && typeof entry === "object"))),
    );
  };
  return {
    taskId: typeof raw?.task_id === "string" ? raw.task_id : null,
    goals: pick(raw?.goals),
    edges: pick(raw?.edges),
    paths: pick(raw?.paths),
  };
}

/** Read one field out of an overlay entry that may be a bare string or an object. */
export function overlayField(overlay, group, id, field = "label") {
  const entry = overlay?.[group]?.[id];
  if (!entry) return null;
  if (typeof entry === "string") return field === "label" ? entry : null;
  const value = entry[field];
  return typeof value === "string" && value.trim() ? value : null;
}

/**
 * Path memory refs declared inside an accepted interface record. Kept separate
 * from `discoverSources` because it needs the file contents, not just state.
 */
export function memoRefsFromAccepted(acceptedRecord) {
  const attempts = [
    ...(acceptedRecord?.accepted_attempts || []),
    ...(acceptedRecord?.carried_forward_bootstrap_attempts || []),
    ...(acceptedRecord?.correction_attempts || []),
    ...(acceptedRecord?.candidate_variants_not_selected || []),
  ];
  const refs = new Map();
  for (const attempt of attempts) {
    if (attempt?.path_id && attempt.memory_ref) refs.set(attempt.path_id, attempt.memory_ref);
  }
  return refs;
}

/**
 * Every path attempt recorded against an edge, from its accepted interface plus
 * any prior-revision record. Shape-driven rather than keyed on specific edge ids,
 * which is what previously forced per-edge special cases in the caller.
 */
export function collectEdgeAttempts(current, history = []) {
  const attempts = [];
  const seen = new Set();
  const push = (attempt, origin) => {
    if (!attempt?.path_id) return;
    const key = `${attempt.path_id}\u0000${origin}`;
    if (seen.has(key)) return;
    seen.add(key);
    attempts.push({ ...attempt, origin });
  };

  for (const attempt of current?.accepted_attempts || []) push(attempt, "accepted");
  for (const attempt of current?.carried_forward_bootstrap_attempts || []) push(attempt, "carried_forward");
  for (const attempt of current?.correction_attempts || []) push(attempt, "correction");
  for (const candidate of current?.candidate_variants_not_selected || []) {
    push({ ...candidate, path_id: candidate.path_id || candidate.candidate }, "variant_not_selected");
  }
  for (const candidate of current?.storage_candidates_not_selected || []) {
    push(
      {
        path_id: candidate.path_id || candidate.candidate,
        status: candidate.status,
        mechanism_class: candidate.mechanism_class || candidate.candidate,
        path_category: candidate.path_category || "storage",
      },
      "candidate_not_selected",
    );
  }
  for (const record of history) {
    for (const attempt of record?.accepted_attempts || []) push(attempt, "prior_revision");
  }

  // Deduplicate by path id, keeping the most authoritative origin.
  const rank = {
    accepted: 0,
    correction: 1,
    carried_forward: 2,
    variant_not_selected: 3,
    candidate_not_selected: 4,
    prior_revision: 5,
  };
  const best = new Map();
  for (const attempt of attempts) {
    const existing = best.get(attempt.path_id);
    if (!existing || rank[attempt.origin] < rank[existing.origin]) best.set(attempt.path_id, attempt);
  }
  return [...best.values()];
}
