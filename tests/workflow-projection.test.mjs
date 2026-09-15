import assert from "node:assert/strict";
import test from "node:test";

import {
  ANCHORS,
  anchorPaths,
  collectEdgeAttempts,
  deriveTopology,
  discoverSources,
  isCurrentAcceptedInterface,
  memoRefsFromAccepted,
  normalizeLabelOverlay,
  overlayField,
  parsePathMemo,
  parseRouteMarkdown,
  resolveWorkflowRef,
} from "../scripts/workflow-projection.mjs";

const ROOT = "/tmp/ocw-fixture-root";

test("anchors are the only fixed filenames", () => {
  assert.deepEqual(Object.keys(ANCHORS).sort(), ["decision", "events", "graph", "state"]);
  const paths = anchorPaths(ROOT);
  assert.equal(paths.state, `${ROOT}/state.json`);
  assert.equal(paths.graph, `${ROOT}/checkpoint-graph.json`);
});

test("resolveWorkflowRef contains refs inside the workflow root", () => {
  assert.equal(resolveWorkflowRef(ROOT, "accepted/EDGE-01.json"), `${ROOT}/accepted/EDGE-01.json`);
  assert.equal(resolveWorkflowRef(ROOT, "./inbox/r2/a/result.json"), `${ROOT}/inbox/r2/a/result.json`);
  assert.equal(resolveWorkflowRef(ROOT, "nested/../accepted/x.json"), `${ROOT}/accepted/x.json`);
});

test("resolveWorkflowRef rejects escaping, absolute and malformed refs", () => {
  assert.equal(resolveWorkflowRef(ROOT, "../../../etc/passwd"), null);
  assert.equal(resolveWorkflowRef(ROOT, "accepted/../../outside.json"), null);
  assert.equal(resolveWorkflowRef(ROOT, "/etc/passwd"), null);
  assert.equal(resolveWorkflowRef(ROOT, ""), null);
  assert.equal(resolveWorkflowRef(ROOT, "   "), null);
  assert.equal(resolveWorkflowRef(ROOT, "a\u0000b"), null);
  assert.equal(resolveWorkflowRef(ROOT, null), null);
  assert.equal(resolveWorkflowRef(ROOT, 42), null);
});

test("resolveWorkflowRef is not fooled by a sibling directory sharing the root prefix", () => {
  assert.equal(resolveWorkflowRef("/tmp/root", "../root-evil/state.json"), null);
});

// A graph shaped like the reference workflow but with entirely different ids, to
// prove nothing is keyed on the reference task's names.
const renamedGraph = {
  root_goal: "renamed root",
  goal_tree: [
    { l1_id: "GOAL-ALPHA", objective: "alpha objective", l2: ["CK-A1", "CK-A2"] },
    { l1_id: "GOAL-BETA", objective: "beta objective", l2: ["CK-B1"] },
  ],
  coupling_bundles: [
    { bundle_id: "PACK-ALPHA", units: ["CK-A1", "CK-A2"] },
    { bundle_id: "PACK-BETA", units: ["CK-B1"] },
  ],
  dependency_dag: {
    edges: [
      { edge_id: "LINK-1", from: ["ROOT"], to: "PACK-ALPHA", assignment_ref: "assignments/WORK-1.json" },
      { edge_id: "LINK-2", from: ["PACK-ALPHA"], to: "PACK-BETA", assignment_ref: "assignments/WORK-2.json" },
    ],
    topological_layers: [["LINK-1"], ["LINK-2"]],
  },
  checkpoints: [
    { checkpoint_id: "CK-A1", l1_id: "GOAL-ALPHA", objective: "a1" },
    { checkpoint_id: "CK-A2", l1_id: "GOAL-ALPHA", objective: "a2" },
    { checkpoint_id: "CK-B1", l1_id: "GOAL-BETA", objective: "b1" },
  ],
};

test("deriveTopology joins edge -> bundle -> goal with no hardcoded ids", () => {
  const topology = deriveTopology(renamedGraph);

  const first = topology.byEdge.get("LINK-1");
  assert.equal(first.goalId, "GOAL-ALPHA");
  assert.equal(first.bundleId, "PACK-ALPHA");
  assert.equal(first.objective, "alpha objective");
  assert.equal(first.layerIndex, 1);
  assert.equal(first.sequence, 1);
  assert.equal(first.resolved, true);

  const second = topology.byEdge.get("LINK-2");
  assert.equal(second.goalId, "GOAL-BETA");
  assert.equal(second.layerIndex, 2);
  assert.equal(second.sequence, 2);

  assert.equal(topology.goalIdByBundleId.get("PACK-BETA"), "GOAL-BETA");
  assert.equal(topology.byGoalId.get("GOAL-ALPHA").edgeId, "LINK-1");
});

test("deriveTopology falls back to raw ids for labels", () => {
  const topology = deriveTopology(renamedGraph);
  assert.equal(topology.byEdge.get("LINK-1").label, "GOAL-ALPHA");
  // Only positional prefixes are stripped; no words are invented.
  assert.equal(deriveTopology({
    goal_tree: [{ l1_id: "L1-HARNESS-OVERFLOW", l2: ["CP-1"] }],
    coupling_bundles: [{ bundle_id: "B", units: ["CP-1"] }],
    dependency_dag: { edges: [{ edge_id: "E", to: "B" }], topological_layers: [["E"]] },
  }).byEdge.get("E").shortLabel, "HARNESS-OVERFLOW");
});

test("deriveTopology resolves goals nested three levels deep", () => {
  const deep = {
    goal_tree: [
      {
        l1_id: "TOP",
        objective: "top",
        l2: [
          { l2_id: "MID", objective: "mid", l3: ["LEAF-1", "LEAF-2"] },
        ],
      },
    ],
    coupling_bundles: [{ bundle_id: "PACK", units: ["LEAF-2"] }],
    dependency_dag: { edges: [{ edge_id: "E1", to: "PACK" }], topological_layers: [["E1"]] },
  };
  const topology = deriveTopology(deep);
  assert.equal(topology.byEdge.get("E1").goalId, "TOP", "a leaf three levels down still maps to its L1 goal");
  assert.ok(topology.byEdge.get("E1").unitIds.includes("LEAF-1"));
  assert.ok(topology.byEdge.get("E1").unitIds.includes("MID"));
});

test("deriveTopology matches on best overlap when a bundle is partially listed", () => {
  const partial = {
    goal_tree: [
      { l1_id: "G1", l2: ["C1", "C2", "C3"] },
      { l1_id: "G2", l2: ["C9"] },
    ],
    coupling_bundles: [{ bundle_id: "B1", units: ["C2", "C3", "C-UNKNOWN"] }],
    dependency_dag: { edges: [{ edge_id: "E1", to: "B1" }], topological_layers: [["E1"]] },
  };
  assert.equal(deriveTopology(partial).byEdge.get("E1").goalId, "G1");
});

test("deriveTopology degrades instead of throwing on missing structures", () => {
  assert.deepEqual(deriveTopology(null).records, []);
  assert.deepEqual(deriveTopology({}).records, []);

  const noBundles = {
    goal_tree: [{ l1_id: "G1", l2: ["C1"] }],
    dependency_dag: { edges: [{ edge_id: "E1", to: "MISSING-BUNDLE" }], topological_layers: [["E1"]] },
  };
  const record = deriveTopology(noBundles).byEdge.get("E1");
  assert.equal(record.resolved, false, "an unresolvable edge is flagged, not silently mislabeled");
  assert.equal(record.goalId, "MISSING-BUNDLE");

  // A goal with no edge still gets a record so the tree can render it.
  assert.ok(deriveTopology(noBundles).byGoalId.has("G1"));
});

test("deriveTopology tolerates an edge pointing straight at a goal", () => {
  const direct = {
    goal_tree: [{ l1_id: "G1", objective: "obj", l2: ["C1"] }],
    coupling_bundles: [],
    dependency_dag: { edges: [{ edge_id: "E1", to: "G1" }], topological_layers: [["E1"]] },
  };
  const record = deriveTopology(direct).byEdge.get("E1");
  assert.equal(record.goalId, "G1");
  assert.equal(record.objective, "obj");
});

test("parsePathMemo extracts the descriptive title after the em dash", () => {
  const memo = [
    "# PATH-STRUCTURE-01 — 线性守卫状态机 + 单一 RACI",
    "",
    "## 假设与机制等价类",
    "",
    "- `assignment_id`: `ASG-R2-01-STRUCTURE`",
    "- 机制等价类：保留 v0.1 的线性顶层阶段，以守卫消除歧义。",
  ].join("\n");
  const parsed = parsePathMemo(memo);
  assert.equal(parsed.title, "线性守卫状态机 + 单一 RACI");
  assert.equal(parsed.summary, "保留 v0.1 的线性顶层阶段，以守卫消除歧义。");
});

test("parsePathMemo refuses a heading that merely echoes another identifier", () => {
  // Real case: the EDGE-02 memos title themselves with the edge id, which is not a label.
  const parsed = parsePathMemo("# PATH-02-GENERATION-POINTER — EDGE-02-STATE-EVIDENCE\n\n## 终态\n\n- `status`: `succeeded`\n");
  assert.equal(parsed.title, null);
});

test("parsePathMemo falls back to the first prose line when no mechanism bullet exists", () => {
  const memo = [
    "# EDGE-04 HARNESS-OVERFLOW — REV7 packaging correction",
    "",
    "## Scope",
    "",
    "REV7 is packaging-only and preserves every earlier artifact byte-for-byte.",
  ].join("\n");
  const parsed = parsePathMemo(memo);
  assert.equal(parsed.title, "REV7 packaging correction");
  assert.equal(parsed.summary, "REV7 is packaging-only and preserves every earlier artifact byte-for-byte.");
});

test("parsePathMemo handles empty and malformed input", () => {
  assert.deepEqual(parsePathMemo(""), { title: null, summary: null });
  assert.deepEqual(parsePathMemo(null), { title: null, summary: null });
  assert.deepEqual(parsePathMemo("no heading at all"), { title: null, summary: null });
});

test("parseRouteMarkdown reads the title and path sequence", () => {
  const route = [
    "# ROUTE-02-BALANCED — 平衡代际血统与授权链",
    "",
    "path_sequence:",
    "  - PATH-STRUCTURE-01",
    "  - PATH-02-GENERATION-POINTER@REV2",
  ].join("\n");
  const parsed = parseRouteMarkdown(route);
  assert.equal(parsed.title, "平衡代际血统与授权链");
  assert.deepEqual(parsed.pathSequence, ["PATH-STRUCTURE-01", "PATH-02-GENERATION-POINTER@REV2"]);
});

const referenceState = {
  task_id: "TASK-X",
  accepted_interfaces: [
    { edge_id: "E1", accepted_at_revision: 6, ref: "accepted/E1.rev6.json", sha256: "aa" },
    {
      edge_id: "E2",
      accepted_at_revision: 8,
      ref: "accepted/E2.rev8.json",
      status: "invalidated_by_downstream_finding",
      invalidation_reason: "receipt did not bind the manifest",
    },
    { edge_id: "E2", accepted_at_revision: 16, ref: "accepted/E2.rev16.json", status: "current" },
  ],
  active_assignments: [
    { assignment_id: "ASG-R2-01", edge_id: "E1", status: "accepted_by_reducer", result_ref: "inbox/r2/ASG-R2-01/result.json" },
    { assignment_id: "ASG-R2-02", edge_id: "E2", status: "accepted_by_reducer", result_ref: "inbox/r2/ASG-R2-02/revision-2/result.json" },
    { assignment_id: "ASG-R4-MAIN", status: "complete_R4_R5_passed", result_ref: "inbox/r4/ASG-R4-MAIN/result.json" },
  ],
  route_index: [
    { route_id: "ROUTE-A", ref: "task-memory/routes/ROUTE-A.md", status: "selected" },
    { route_id: "ROUTE-B", ref: "task-memory/routes/ROUTE-B.md", status: "not_selected" },
  ],
};

test("discoverSources keeps both current and superseded accepted interfaces", () => {
  const sources = discoverSources(referenceState, renamedGraph);
  const e2 = sources.acceptedByEdge.get("E2");
  assert.equal(e2.current.ref, "accepted/E2.rev16.json");
  assert.equal(e2.history.length, 1, "the superseded revision is retained as history");
  assert.equal(e2.history[0].ref, "accepted/E2.rev8.json");
  assert.equal(e2.history[0].invalidationReason, "receipt did not bind the manifest");
  assert.equal(sources.acceptedByEdge.get("E1").current.revision, 6);
});

test("discoverSources finds results per edge and keeps the phase-only R4 result", () => {
  const sources = discoverSources(referenceState, renamedGraph);
  assert.equal(sources.resultsByEdge.get("E1")[0].ref, "inbox/r2/ASG-R2-01/result.json");
  assert.equal(sources.resultsByEdge.get("E2")[0].ref, "inbox/r2/ASG-R2-02/revision-2/result.json");

  // The R4 single-writer assignment has no edge_id; it must still be discoverable.
  assert.equal(sources.resultsByEdge.has("R4"), false);
  const r4 = sources.phaseResults.get("R4");
  assert.equal(r4.length, 1);
  assert.equal(r4[0].assignmentId, "ASG-R4-MAIN");
  assert.equal(sources.phaseResults.get("R2").length, 2);
});

test("discoverSources collects assignment specs from state and from graph edges", () => {
  const sources = discoverSources(referenceState, renamedGraph);
  assert.equal(sources.assignmentSpecRefs.get("ASG-R2-01"), "assignments/ASG-R2-01.json");
  // Declared only on the graph edge, not in state.
  assert.equal(sources.assignmentSpecRefs.get("WORK-1"), "assignments/WORK-1.json");
  assert.equal(sources.assignmentSpecRefs.get("WORK-2"), "assignments/WORK-2.json");
});

test("discoverSources maps routes by id", () => {
  const sources = discoverSources(referenceState, renamedGraph);
  assert.equal(sources.routeRefs.get("ROUTE-A"), "task-memory/routes/ROUTE-A.md");
  assert.equal(sources.routeRefs.size, 2);
});

test("discoverSources survives an empty or partial state", () => {
  const empty = discoverSources({}, {});
  assert.equal(empty.acceptedByEdge.size, 0);
  assert.equal(empty.routeRefs.size, 0);
  assert.equal(empty.assignmentSpecRefs.size, 0);
  assert.doesNotThrow(() => discoverSources(null, null));
});

test("isCurrentAcceptedInterface distinguishes current from superseded", () => {
  assert.equal(isCurrentAcceptedInterface({ accepted_at_revision: 6 }), true);
  assert.equal(isCurrentAcceptedInterface({ status: "current" }), true);
  assert.equal(isCurrentAcceptedInterface({ status: "invalidated_by_x", accepted_at_revision: 8 }), false);
  assert.equal(isCurrentAcceptedInterface({}), false);
  assert.equal(isCurrentAcceptedInterface(null), false);
});

test("memoRefsFromAccepted exposes the per-path evidence refs", () => {
  const refs = memoRefsFromAccepted({
    accepted_attempts: [{ path_id: "P1", memory_ref: "task-memory/paths/E1/P1.md" }],
    correction_attempts: [{ path_id: "P2", memory_ref: "task-memory/paths/E1/P2.md" }],
    candidate_variants_not_selected: [{ path_id: "P3" }],
  });
  assert.equal(refs.get("P1"), "task-memory/paths/E1/P1.md");
  assert.equal(refs.get("P2"), "task-memory/paths/E1/P2.md");
  assert.equal(refs.has("P3"), false, "an attempt with no memory_ref yields no ref");
});

test("collectEdgeAttempts gathers every attempt shape without per-edge special cases", () => {
  const attempts = collectEdgeAttempts(
    {
      accepted_attempts: [{ path_id: "P1", status: "succeeded" }],
      carried_forward_bootstrap_attempts: [{ path_id: "P2", status: "succeeded" }],
      correction_attempts: [{ path_id: "P3", status: "succeeded" }],
      storage_candidates_not_selected: [{ candidate: "store_a", status: "feasible_unselected" }],
    },
    [{ accepted_attempts: [{ path_id: "P-OLD", status: "failed" }] }],
  );
  const byId = new Map(attempts.map((attempt) => [attempt.path_id, attempt]));
  assert.deepEqual([...byId.keys()].sort(), ["P-OLD", "P1", "P2", "P3", "store_a"]);
  assert.equal(byId.get("store_a").path_category, "storage");
  assert.equal(byId.get("store_a").mechanism_class, "store_a");
  assert.equal(byId.get("P-OLD").origin, "prior_revision");
});

test("collectEdgeAttempts prefers the accepted record over a prior revision", () => {
  const attempts = collectEdgeAttempts(
    { accepted_attempts: [{ path_id: "P1", status: "succeeded" }] },
    [{ accepted_attempts: [{ path_id: "P1", status: "failed" }] }],
  );
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].status, "succeeded");
  assert.equal(attempts[0].origin, "accepted");
});

test("collectEdgeAttempts handles an absent accepted record", () => {
  assert.deepEqual(collectEdgeAttempts(null, []), []);
  assert.deepEqual(collectEdgeAttempts({}, []), []);
});

test("label overlay is optional and shape-guarded", () => {
  const overlay = normalizeLabelOverlay({
    task_id: "TASK-X",
    goals: { G1: "结构与授权" },
    edges: { E1: { label: "结构路径", shortLabel: "结构" } },
    paths: { P1: { label: "线性守卫状态机", summary: "摘要" } },
    junk: "ignored",
  });
  assert.equal(overlayField(overlay, "goals", "G1"), "结构与授权");
  assert.equal(overlayField(overlay, "edges", "E1", "shortLabel"), "结构");
  assert.equal(overlayField(overlay, "paths", "P1", "summary"), "摘要");
  assert.equal(overlayField(overlay, "goals", "MISSING"), null, "absent overlay entries yield null so callers fall back to raw ids");
  assert.equal(overlayField(overlay, "goals", "G1", "summary"), null, "a bare string only supplies a label");

  const blank = normalizeLabelOverlay(null);
  assert.deepEqual(blank.goals, {});
  assert.equal(overlayField(blank, "paths", "anything"), null);
});
