/**
 * Build a synthetic OCW canonical workflow root for end-to-end tests.
 *
 * Every identifier here is deliberately unlike the reference workflow's, so a
 * projection that secretly depends on the reference task's goal, bundle, edge,
 * route or path names fails these tests instead of passing by coincidence.
 *
 * The graph is three levels deep (l1 -> l2 -> l3) so the in-card branch renderer
 * is exercised beyond the reference harness's two levels.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function writeFixtureWorkflow(root, options = {}) {
  const {
    taskId = "TASK-SYNTH-001",
    phase = "exploring",
    prefix = "ALPHA",
    working = true,
    revision = 2,
  } = options;

  const goalA = `GOAL-${prefix}`;
  const goalB = `GOAL-${prefix}-SECOND`;
  const midGoal = `SUB-${prefix}`;
  const checkpoints = [`CK-${prefix}-1`, `CK-${prefix}-2`, `CK-${prefix}-3`];
  const edgeA = `LINK-${prefix}-1`;
  const edgeB = `LINK-${prefix}-2`;
  const bundleA = `PACK-${prefix}-1`;
  const bundleB = `PACK-${prefix}-2`;
  const assignmentA = `WORK-${prefix}-A`;
  const assignmentB = `WORK-${prefix}-B`;
  const assignmentWriter = `WRITE-${prefix}`;
  const routeId = `PLAN-${prefix}`;
  const pathOk = `TRY-${prefix}-01`;
  const pathBad = `TRY-${prefix}-02`;
  const agentRef = `agents/synthetic/agent_${prefix.toLowerCase()}`;

  await Promise.all([
    mkdir(join(root, "accepted"), { recursive: true }),
    mkdir(join(root, "assignments"), { recursive: true }),
    mkdir(join(root, `inbox/r2/${assignmentA}`), { recursive: true }),
    mkdir(join(root, `inbox/r4/${assignmentWriter}`), { recursive: true }),
    mkdir(join(root, "task-memory/routes"), { recursive: true }),
    mkdir(join(root, `task-memory/paths/${edgeA}`), { recursive: true }),
    mkdir(join(root, `task-memory/implementation/${routeId}`), { recursive: true }),
  ]);

  const write = (relative, body) =>
    writeFile(join(root, relative), typeof body === "string" ? body : `${JSON.stringify(body, null, 1)}\n`);

  await write("checkpoint-graph.json", {
    schema_version: "synthetic-graph-0.1",
    task_id: taskId,
    root_goal: `${taskId} 的合成根目标`,
    goal_tree: [
      {
        l1_id: goalA,
        objective: `${prefix} 主目标`,
        // Nested one level deeper than the reference graph.
        l2: [{ l2_id: midGoal, objective: `${prefix} 中间子目标`, l3: [checkpoints[0], checkpoints[1]] }],
      },
      { l1_id: goalB, objective: `${prefix} 次目标`, l2: [checkpoints[2]] },
    ],
    checkpoints: [
      { checkpoint_id: checkpoints[0], l1_id: goalA, objective: `${prefix} 检查点一`, acceptance_oracle: "oracle 1", invariants: ["不变量 1"] },
      { checkpoint_id: checkpoints[1], l1_id: goalA, objective: `${prefix} 检查点二`, acceptance_oracle: "oracle 2" },
      { checkpoint_id: checkpoints[2], l1_id: goalB, objective: `${prefix} 检查点三`, acceptance_oracle: "oracle 3" },
    ],
    coupling_bundles: [
      { bundle_id: bundleA, units: [checkpoints[0], checkpoints[1]] },
      { bundle_id: bundleB, units: [checkpoints[2]] },
    ],
    dependency_dag: {
      nodes: ["ROOT", bundleA, bundleB],
      edges: [
        {
          edge_id: edgeA,
          from: ["ROOT"],
          to: bundleA,
          assignment_ref: `assignments/${assignmentA}.json`,
          start_guarantees: ["baseline 可读"],
          end_guarantees: [`${prefix} 已探索`],
        },
        { edge_id: edgeB, from: [bundleA], to: bundleB, assignment_ref: `assignments/${assignmentB}.json` },
      ],
      topological_layers: [[edgeA], [edgeB]],
      cycle_check: "passed",
    },
  });

  await write("state.json", {
    schema_version: "synthetic-state-0.1",
    task_id: taskId,
    objective: `${taskId} 的合成目标`,
    phase,
    revision,
    updated_at: new Date().toISOString(),
    next_action: `继续探索 ${prefix} 路径`,
    blockers: [],
    gate_status: { G1: "passed", G2: "pending" },
    accepted_interfaces: [{ edge_id: edgeA, accepted_at_revision: revision, ref: `accepted/${edgeA}.rev${revision}.json`, sha256: "f".repeat(64) }],
    active_assignments: [
      {
        assignment_id: assignmentA,
        edge_id: edgeA,
        status: working ? "active_executing" : "accepted_by_reducer",
        agent_ref: agentRef,
        result_ref: `inbox/r2/${assignmentA}/result.json`,
      },
      // A single-writer assignment is scoped to the route, not to an edge. It has
      // no `edge_id`, which is exactly the shape the projection used to drop.
      {
        assignment_id: assignmentWriter,
        edge_id: null,
        route_id: routeId,
        status: "accepted_by_reducer",
        agent_ref: `agents/synthetic/writer_${prefix.toLowerCase()}`,
        result_ref: `inbox/r4/${assignmentWriter}/result.json`,
      },
    ],
    route_index: [
      { route_id: routeId, route_revision: 1, rank: 1, status: "selected", ref: `task-memory/routes/${routeId}.md`, recommended: true, selected_at_revision: revision, evidence_ceiling: "E2" },
    ],
    user_gate: { status: "selected", selected_route: routeId, route_revision: 1, selected_at_revision: revision },
  });

  const at = new Date().toISOString();
  await write(
    "events.jsonl",
    [
      { event_id: "EV-1", type: "decomposition_complete", from_revision: 0, to_revision: 1, from_phase: "decomposing", to_phase: "decomposition_ready", actor: "planner", at },
      { event_id: "EV-2", type: "exploration_started", from_revision: 1, to_revision: 2, from_phase: "decomposition_ready", to_phase: phase, actor: "coordinator", at },
    ].map((event) => JSON.stringify(event)).join("\n") + "\n",
  );

  await write("decision.json", {
    schema_version: "synthetic-decision-0.1",
    decision_id: "DEC-1",
    task_id: taskId,
    status: "selected",
    selected_route: routeId,
    route_revision: 1,
    state_revision: revision,
    allowed_scope: { phase: "R4_synthetic", required_content: ["合成内容"] },
    explicit_out_of_scope: ["不改动真实协议"],
  });

  await write(`accepted/${edgeA}.rev${revision}.json`, {
    schema_version: "synthetic-accepted-0.1",
    edge_id: edgeA,
    accepted_at_revision: revision,
    accepted_attempts: [
      { path_id: pathOk, status: "succeeded", mechanism_class: `${prefix.toLowerCase()}_mechanism`, evidence_level: "E2", memory_ref: `task-memory/paths/${edgeA}/${pathOk}.md` },
      { path_id: pathBad, status: "failed", mechanism_class: `${prefix.toLowerCase()}_reject`, exclusion_reason: "反例矩阵未通过" },
    ],
  });

  // A descriptive H1 plus a mechanism bullet, which is what the projection reads
  // instead of a hardcoded label table.
  await write(
    `task-memory/paths/${edgeA}/${pathOk}.md`,
    [`# ${pathOk} — 合成的确定性 ${prefix} 机制`, "", "## 假设与机制等价类", "", `- \`assignment_id\`: \`${assignmentA}\``, `- 机制等价类：以合成守卫链证明 ${prefix} 路径可判定。`, ""].join("\n"),
  );

  await write(
    `task-memory/routes/${routeId}.md`,
    [`# ${routeId} — 合成的平衡路线`, "", "path_sequence:", `  - ${pathOk}`, ""].join("\n"),
  );

  await write(`inbox/r2/${assignmentA}/result.json`, {
    assignment_id: assignmentA,
    edge_id: edgeA,
    attempts: [{ path_id: pathOk, status: "succeeded", summary: "来自 r2 结果的补充摘要", key_cost: "需要额外一次校验" }],
  });

  // The spec is the only place checkpoint-level ownership is declared; state
  // never carries checkpoint_ids. Scoped to one checkpoint so the tests can tell
  // direct ownership from inheritance.
  await write(`assignments/${assignmentA}.json`, {
    assignment_id: assignmentA,
    task_id: taskId,
    role: "R2_path_explorer",
    edge_id: edgeA,
    bundle_id: bundleA,
    checkpoint_ids: [checkpoints[1]],
    objective: `探索 ${prefix} 路径`,
  });

  await write(`inbox/r4/${assignmentWriter}/result.json`, {
    assignment_id: assignmentWriter,
    route_id: routeId,
    status: "submitted",
    embedded_vector_inventory: { deterministically_expanded_total: 7 },
  });

  await write(`assignments/${assignmentWriter}.json`, {
    assignment_id: assignmentWriter,
    task_id: taskId,
    role: "R4_single_writer",
    route_id: routeId,
    objective: `实现 ${routeId}`,
  });

  await write(`assignments/${assignmentB}.json`, {
    assignment_id: assignmentB,
    task_id: taskId,
    role: "R2_path_explorer",
    edge_id: edgeB,
    checkpoint_ids: [checkpoints[2]],
  });

  await write(`task-memory/implementation/${routeId}/features.json`, {
    schema_version: "synthetic-ledger-0.1",
    task_id: taskId,
    route_id: routeId,
    features: [
      { id: "F01", description: "合成特性一", passes: true },
      { id: "F02", description: "合成特性二", passes: false },
    ],
  });

  return {
    root,
    taskId,
    goalA,
    goalB,
    midGoal,
    checkpoints,
    edgeA,
    edgeB,
    routeId,
    pathOk,
    pathBad,
    assignmentA,
    assignmentWriter,
    agentName: agentRef.split("/").at(-1),
  };
}
