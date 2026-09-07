import type { AgentBinding, Checkpoint, CheckpointTreeNode, JourneyEdge, PathAttempt, RouteImplementation, WorkflowSnapshot, WorkflowStatus } from "./types";

// Deliberately local to the browser. This replay never opens a harness stream,
// registers an executor, or writes a result to the real runtime.
export const demoSteps = [
  { title: "两组并行检查，运行验收等待前置条件", states: ["complete", "active", "pending", "active", "pending", "pending", "pending", "pending", "pending"] },
  { title: "授权边界通过，状态快照开始核验", states: ["complete", "complete", "active", "complete", "active", "pending", "pending", "pending", "pending"] },
  { title: "发现摘要不一致，证据组需要处理", states: ["complete", "complete", "complete", "complete", "attention", "pending", "pending", "pending", "pending"] },
  { title: "摘要重新核验通过，补齐交付索引", states: ["complete", "complete", "complete", "complete", "complete", "active", "pending", "pending", "pending"] },
  { title: "两组必要条件全部满足，开始运行验收", states: ["complete", "complete", "complete", "complete", "complete", "complete", "active", "pending", "pending"] },
  { title: "依赖校验通过，正在演练故障恢复", states: ["complete", "complete", "complete", "complete", "complete", "complete", "complete", "active", "pending"] },
  { title: "恢复演练通过，结果复验进行中", states: ["complete", "complete", "complete", "complete", "complete", "complete", "complete", "complete", "active"] },
] satisfies Array<{ title: string; states: WorkflowStatus[] }>;

const sections = [
  { id: "structure", label: "结构与授权", checks: ["角色划分", "权限边界", "操作范围"], paths: ["分权执行", "共享权限", "临时授权"], from: ["DEMO-ROOT"] },
  { id: "evidence", label: "状态与证据", checks: ["状态快照", "摘要核验", "交付索引"], paths: ["版本投影", "快照直读", "事件回放"], from: ["DEMO-ROOT"] },
  { id: "verification", label: "运行与验收", checks: ["依赖校验", "故障恢复", "结果复验"], paths: ["租约续跑", "直接重试", "人工接管"], from: ["DEMO-structure", "DEMO-evidence"] },
];
const aggregate = (checks: Checkpoint[]): WorkflowStatus => checks.some(cp => cp.status === "attention") ? "attention" : checks.every(cp => cp.status === "complete") ? "complete" : checks.some(cp => cp.status !== "pending") ? "active" : "pending";
const implementation: RouteImplementation = { routeId: null, status: "pending", productRef: null, productDigest: null, productLines: null, productWords: null, vectorCount: null, mirrorPassed: false, r5Verdict: "pending", deploymentStatus: "demo_only", claimCeiling: { scope: "仅演示，不代表真实执行" }, candidateHistory: [] };

export function createDemoSnapshot(step: number): WorkflowSnapshot {
  const frame = demoSteps[step % demoSteps.length];
  const at = new Date(Date.UTC(2026, 8, 7, 10, 0, step * 5)).toISOString();
  const assignments: AgentBinding[] = [];
  const groups = sections.map((section, index) => {
    const id = `DEMO-${section.id}`;
    const checkpoints: Checkpoint[] = section.checks.map((objective, cpIndex) => {
      const cpId = `${id}-${cpIndex + 1}`;
      const status = frame.states[index * 3 + cpIndex];
      const worker: AgentBinding | null = status === "active" ? {
        assignmentId: `demo-work-${cpId}`, edgeId: `edge-${id}`, routeId: null, phase: index === 2 ? "R4" : "R2", agentRef: `demo-agent-${index + 1}`, displayName: `演示代理 ${index + 1}`, role: "模拟检查", status: "demo_running", workState: "working", working: true, updatedAt: at, checkpointIds: [cpId], pathIds: [], scope: "checkpoint", inherited: false, liveness: "demo",
      } : null;
      if (worker) assignments.push(worker);
      return { id: cpId, l1Id: id, objective, status, statusSource: "demo", worker, targetRules: ["本组所有必要条件均需通过"], preconditions: section.from, postconditions: [`${objective}通过独立检查`], invariants: ["演示不会修改真实任务"], acceptanceOracle: `演示规则：${objective}检查通过；真实系统应附对应证据与验收版本。`, dependsOn: [], providesTo: [] };
    });
    return { id, label: section.label, sequence: index + 1, edgeId: `edge-${id}`, objective: `${section.label}的三个检查点需要同时满足`, status: aggregate(checkpoints), statusSource: "demo" as const, acceptedRevision: null, acceptedRef: null, progress: Math.round(checkpoints.filter(cp => cp.status === "complete").length / 3 * 100), checkpoints };
  });
  const treeNodes: CheckpointTreeNode[] = groups.map(group => ({ id: `goal-${group.id}`, label: group.label, objective: group.objective, depth: 1, kind: "goal", status: group.status, statusSource: "demo", edgeId: group.edgeId, checkpointId: null, children: group.checkpoints.map(cp => ({ ...cp, label: cp.objective, depth: 2, kind: "checkpoint", edgeId: group.edgeId, checkpointId: cp.id, children: [] })) }));
  const nodes = groups.map((group, i) => ({ ...group, goalId: treeNodes[i].id, worker: null, treeNode: treeNodes[i] }));
  const edges: JourneyEdge[] = groups.map((group, index) => {
    const adopted = index < 2 || step >= 4;
    const paths: PathAttempt[] = sections[index].paths.map((label, pathIndex) => ({
      id: `${group.id}-path-${pathIndex + 1}`, edgeId: group.edgeId!, label, shortLabel: label, order: pathIndex + 1, origin: "demo", category: "演示备选方案", status: pathIndex === 1 ? "refuted" : pathIndex === 0 && adopted ? "succeeded" : "inconclusive", selected: pathIndex === 0 && adopted,
      mechanism: ["按版本绑定输入、执行和验收结果", "缺少隔离或版本约束的反例方案", "保留为尚未验证的后备方案"][pathIndex], summary: `演示路径：${label}。所有连线共享同一组起点和终点。`, reason: pathIndex === 1 ? "演示反例：存在重复执行或读取旧状态的风险，因此证伪。" : null, keyCost: "仅用于 UI 交互演示", claimScope: "不代表生产验证", evidenceLevel: "DEMO", deploymentStatus: "demo_only", memoryRef: null, evidenceRef: null, worker: null,
    }));
    return { id: group.edgeId!, label: group.label, shortLabel: group.label, from: sections[index].from, to: group.id, startGuarantees: index === 2 ? ["结构与授权全部满足", "状态与证据全部满足"] : ["目标已定义"], endGuarantees: [group.objective], status: group.status, statusSource: "demo", acceptedRevision: null, priorRevisions: [], paths, selectedPaths: paths.filter(path => path.selected).length, worker: null };
  });
  const complete = groups.flatMap(group => group.checkpoints).filter(cp => cp.status === "complete").length;
  return {
    contentFingerprint: `demo-${step}`, sourceStatus: "ready", sourceError: null, verifiedAt: at, generatedAt: at, sourceRoot: "浏览器内置演示 · 不绑定真实数据源",
    runtime: { bindingId: "demo-only", required: false, status: "degraded", startedAt: at, frontendUrl: "?demo=paths", sourceRoot: "demo-only", sourceMode: "demo", renderMode: "demo", registryMode: true, registryDir: "", registrationId: "", liveness: "demo", instanceId: null, sessionId: "演示会话", connectedClients: 0, frontendAttached: false },
    task: { id: "DEMO-OCW", objective: "让并行任务可追踪、可恢复", revision: step + 1, phase: step >= 4 ? "implementing" : "exploring", updatedAt: at, nextAction: frame.title, blockers: step === 2 ? ["演示摘要不一致"] : [], selectedRoute: null, decisionStatus: "demo" },
    phases: ["定义目标", "探索路径", "选择方案", "执行验证", "最终复验"].map((title, i) => ({ id: `R${i + 1}`, title, owner: "演示代理", gate: `G${i + 1}`, gateStatus: i === 0 || step >= 4 && i < 3 ? "passed" : "pending", activePhases: [], description: "演示阶段；实际运行时由已验证的阶段门控制。", status: i === 0 || step >= 4 && i < 3 ? "complete" : (step >= 4 ? i === 3 : i === 1) ? "active" : "pending", progress: i === 0 || step >= 4 && i < 3 ? 100 : (step >= 4 ? i === 3 : i === 1) ? 50 : 0 })),
    groups, checkpointTree: { schemaVersion: "demo-1", currentMaxDepth: 2, rendererMaxDepth: 8, recursive: true, root: { id: "DEMO-ROOT", label: "任务目标", objective: "让并行任务可追踪、可恢复", depth: 0, kind: "goal", status: "active", statusSource: "demo", edgeId: null, checkpointId: null, children: treeNodes } },
    routeFlow: { candidates: [], decision: { id: "demo-decision", status: "pending", selectedRoute: null, routeRevision: null, stateRevision: null, phaseScope: null, requiredContent: [], explicitOutOfScope: ["真实执行"] }, implementation },
    journey: { root: { id: "DEMO-ROOT", label: "任务目标", objective: "让并行任务可追踪、可恢复", status: "active" }, layers: [{ index: 1, label: "并行准备", orthogonal: true, nodes: nodes.slice(0, 2) }, { index: 2, label: "联合验收", orthogonal: false, nodes: nodes.slice(2) }], transitions: [{ index: 1, label: "并行探索", edges: edges.slice(0, 2) }, { index: 2, label: "汇合后验收", edges: edges.slice(2) }], routes: [], selectedRoute: null, implementation, pathGranularity: "bundle_transition", cycleCheck: "passed" },
    agentActivity: { workingCount: assignments.length, activeAssignmentCount: assignments.length, unverifiedAssignmentCount: 0, assignments },
    events: [{ eventId: `demo-step-${step}`, type: "demo_progress", fromRevision: step, toRevision: step + 1, fromPhase: "demo", toPhase: "demo", actor: "演示播放器", at, tone: step === 2 ? "warning" : "neutral", payload: { summary: frame.title } }],
    metrics: { featuresPassed: 0, featuresTotal: 0, checkpointsComplete: complete, checkpointsTotal: 9, events: 1, revision: step + 1 },
    integrity: { chainHealthy: false, chainIssues: ["演示无真实证据链"], productDigest: null, expectedProductDigest: null, productDigestMatches: false, mirrorDigest: null, mirrorDigestMatches: false, mirrorReview: "demo", baselineDigest: null },
  };
}
