import { X } from "@phosphor-icons/react/X";
import { ArrowLeft } from "@phosphor-icons/react/ArrowLeft";
import { CheckCircle } from "@phosphor-icons/react/CheckCircle";
import { ClockCounterClockwise } from "@phosphor-icons/react/ClockCounterClockwise";
import { FileText } from "@phosphor-icons/react/FileText";
import { GitBranch } from "@phosphor-icons/react/GitBranch";
import { Info } from "@phosphor-icons/react/Info";
import { Path } from "@phosphor-icons/react/Path";
import { ShieldCheck } from "@phosphor-icons/react/ShieldCheck";
import { Stack } from "@phosphor-icons/react/Stack";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { eventLabel, formatTime, shortDigest, statusLabel } from "../format";
import { pathTone, pathToneLabel } from "../graph-layout";
import type {
  RuntimeEvidence,
  AgentBinding,
  CheckpointTreeNode,
  JourneyEdge,
  JourneyNode,
  JourneySelection,
  PathAttempt,
  PathOrigin,
  StatusSource,
  WorkflowSnapshot,
} from "../types";
import { AgentBadge } from "./AgentBadge";
import { StatusIcon } from "./StatusIcon";

const originLabels: Record<PathOrigin, string> = {
  runtime: "运行时路径目录",
  demo: "演示案例",
  accepted: "本次验收记录",
  correction: "修正尝试记录",
  carried_forward: "自前次验收结转",
  variant_not_selected: "可行但未采纳的变体",
  candidate_not_selected: "可行但未采纳的候选",
  prior_revision: "已失效的历史验收",
};

/**
 * Say where a status came from.
 *
 * Accepted interface records are edge scoped and contain no per-checkpoint
 * verdict, so a "complete" checkpoint means its task edge was accepted. Stating
 * that is the difference between reporting evidence and implying it.
 */
function StatusProvenance({ source, scope }: { source?: StatusSource; scope: "checkpoint" | "goal" | "edge" }) {
  if (!source) return null;
  if (source === "demo") return <p className="status-provenance" data-source="demo">演示状态：用于展示 UI 交互，不代表真实任务验收。</p>;
  if (source === 'runtime_checkpoint') return <p className="status-provenance" data-source={source}><Info size={12} weight="fill" />状态来自执行内核的检查点账本；验收依据为本地命令与交付回执。</p>;
  if (source === "edge_accepted") {
    return (
      <p className="status-provenance" data-source={source}>
        <Info size={12} weight="fill" />
        {scope === "edge"
          ? "该任务边已有验收记录（accepted interface）。"
          : "状态由所属任务边的验收记录推导，验收记录本身不含逐个节点的独立结论。"}
      </p>
    );
  }
  return (
    <p className="status-provenance" data-source={source}>
      <Info size={12} weight="fill" />
      状态由当前工作流阶段推断，尚无验收记录。
    </p>
  );
}

/** Distinguish an assignment that names this node from one merely enclosing it. */
function OwnershipNote({ worker }: { worker?: AgentBinding | null }) {
  if (!worker) return null;
  const scopeName = worker.scope === "checkpoint" ? "检查点" : worker.scope === "path" ? "路径" : "任务边";
  return (
    <p className="ownership-note" data-inherited={Boolean(worker.inherited)}>
      <Info size={12} weight="fill" />
      {worker.inherited
        ? `该归属继承自${scopeName}级 assignment，未在本节点上直接声明。`
        : `该 assignment 在其规格中直接声明了本${scopeName}。`}
    </p>
  );
}

/** R4/R5 outcome, claiming only what the recorded result supports. */
function ImplementationCard({ snapshot }: { snapshot: WorkflowSnapshot }) {
  const { implementation } = snapshot.journey;
  const latest = implementation.candidateHistory.at(-1);
  const passed = implementation.r5Verdict === "pass";

  return (
    <section className="implementation-card">
      <span>R4 → R5 实施与审计结果</span>
      <h3>
        {latest
          ? `Candidate ${latest.number} · ${passed ? "已通过终审" : "待终审"}`
          : "尚无候选提交"}
      </h3>
      <p>
        {implementation.vectorCount != null && `${implementation.vectorCount} 个确定性展开的文档级测试向量；`}
        {implementation.productDigest
          ? `最终摘要 ${shortDigest(implementation.productDigest)}。`
          : "该实现未记录产物摘要。"}
      </p>
      <small>
        <CheckCircle size={14} weight="fill" /> R5 {implementation.r5Verdict} · {implementation.deploymentStatus}
      </small>
    </section>
  );
}

function EvidenceRecord({ evidence }: { evidence?: RuntimeEvidence | null }) {
  if (!evidence) return null;
  return <details className="evidence-disclosure" data-testid="runtime-evidence"><summary>验收证据与版本</summary><dl className="detail-rows"><div><dt>证据</dt><dd>{evidence.ref}</dd></div><div><dt>摘要</dt><dd>{evidence.sha256}</dd></div>{Object.entries(evidence.record).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{typeof value === "object" ? JSON.stringify(value) : String(value)}</dd></div>)}</dl></details>;
}

function DetailRows({ path }: { path: PathAttempt }) {
  const rows = [
    ["机制", path.mechanism],
    ["证据", path.evidenceLevel],
    ["部署", path.deploymentStatus],
    ["声明边界", path.claimScope],
    ["主要成本", path.keyCost],
    ["记录来源", originLabels[path.origin]],
  ].filter(([, value]) => Boolean(value));
  return <details className="evidence-disclosure"><summary>证据、机制与声明边界</summary><dl className="detail-rows">{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl></details>;
}

function EdgeDetail({
  edge,
  selectedPath,
  onSelect,
}: {
  edge: JourneyEdge;
  selectedPath: PathAttempt | null;
  onSelect: (selection: JourneySelection) => void;
}) {
  return (
    <div className="inspector-section" data-testid="edge-detail">
      <div className="detail-heading">
        <span className="detail-icon"><Path size={17} weight="bold" /></span>
        <div>
          <small>{edge.id}</small>
          <h2>{edge.label}</h2>
        </div>
      </div>
      <p className="detail-lead">这是任务层之间的实现方式集合，不是检查点本身。当前历史记录以耦合包转换为粒度。</p>
      <StatusProvenance scope="edge" source={edge.statusSource} />
      {edge.acceptedRevision != null && (
        <p className="accepted-revision-note">
          <ShieldCheck size={12} weight="fill" /> 当前验收记录固化于 revision {edge.acceptedRevision}。
        </p>
      )}

      {/*
        Superseded accepted records. These were previously read but never shown,
        so an invalidated interface left no trace in the UI.
      */}
      {edge.priorRevisions.length > 0 && (
        <section className="prior-revisions" data-testid="prior-revisions">
          <div className="path-list-heading">
            <strong>已失效的历史验收 ({edge.priorRevisions.length})</strong>
            <span>保留以便追溯</span>
          </div>
          {edge.priorRevisions.map((prior) => (
            <div className="prior-revision-row" key={prior.ref}>
              <span className="prior-rev-tag">rev {prior.revision ?? "?"}</span>
              <div>
                <strong>{prior.status || "已被取代"}</strong>
                {prior.invalidationReason && <p>{prior.invalidationReason}</p>}
                <small>{prior.ref}</small>
              </div>
            </div>
          ))}
        </section>
      )}

      {selectedPath && (
        <article className="selected-path-detail" data-status={selectedPath.status}>
          <button className="back-link" onClick={() => onSelect({ kind: "edge", id: edge.id })} type="button">
            <ArrowLeft size={14} /> 返回全部路径
          </button>
          <div className="selected-path-title">
            <div>
              <span>{selectedPath.id}</span>
              <h3>{selectedPath.label}</h3>
            </div>
            <span className="path-status">{pathToneLabel[pathTone(selectedPath)]}</span>
          </div>
          <AgentBadge worker={selectedPath.worker} />
          <OwnershipNote worker={selectedPath.worker} />
          <p>{selectedPath.summary}</p>
          {selectedPath.reason && selectedPath.reason !== selectedPath.summary && (
            <p className="reason-copy"><strong>判断依据</strong>{selectedPath.reason}</p>
          )}
          <DetailRows path={selectedPath} />
          {selectedPath.selection && <p className="status-provenance">采用决策 · {selectedPath.selection.actor} · REV {selectedPath.selection.revision} · {selectedPath.selection.reason}</p>}
          <EvidenceRecord evidence={selectedPath.evidence} />
          {!!selectedPath.attemptHistory?.length && <details className="evidence-disclosure" data-testid="attempt-history"><summary>{selectedPath.attemptHistory.length} 次执行尝试</summary>{selectedPath.attemptHistory.map(attempt => <div key={attempt.id}><p>{attempt.checkpoint} · {attempt.owner} · {attempt.status}</p><small>{attempt.id} · 租约 {attempt.epoch}</small><EvidenceRecord evidence={attempt.acceptance} /></div>)}</details>}
          {/* The refs the summary above was actually read from. */}
          {selectedPath.memoryRef && (
            <div className="memory-ref"><FileText size={14} /> 路径记录 {selectedPath.memoryRef}</div>
          )}
          {selectedPath.evidenceRef && (
            <div className="memory-ref"><ShieldCheck size={14} /> 证据工件 {selectedPath.evidenceRef}</div>
          )}
        </article>
      )}

      {!selectedPath && (
        <>
          <div className="guarantee-pair">
            <div><span>起点保证</span><p>{edge.startGuarantees.join("；") || "无显式前置要求"}</p></div>
            <div><span>终点保证</span><p>{edge.endGuarantees.join("；") || "无显式终点保证"}</p></div>
          </div>
          <div className="path-list-heading">
            <strong>{edge.paths.length} 条探索实现路径</strong>
            <span>点击查看机制与证据</span>
          </div>
        </>
      )}

      <div className="path-list" data-testid="path-list">
        {edge.paths.map((path) => (
          <button
            className="path-row"
            data-active={selectedPath?.id === path.id}
            data-selected={pathTone(path) === "adopted"}
            data-status={path.status}
            key={path.id}
            onClick={() => onSelect({ kind: "path", id: path.id, edgeId: edge.id })}
            type="button"
          >
            <span className="path-index">{String(path.order).padStart(2, "0")}</span>
            <span className="path-copy">
              <strong>{path.label}</strong>
              <small>{path.id}</small>
            </span>
            <span className="path-row-status">{pathToneLabel[pathTone(path)]}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function TaskDetail({
  node,
  layerIndex,
  orthogonal,
  edge,
  onSelect,
}: {
  node: JourneyNode;
  layerIndex: number;
  orthogonal: boolean;
  edge?: JourneyEdge | null;
  onSelect: (selection: JourneySelection) => void;
}) {
  return (
    <div className="inspector-section" data-testid="task-detail">
      <div className="detail-heading">
        <span className="detail-icon"><Stack size={17} weight="bold" /></span>
        <div>
          <small>{node.goalId} · L{layerIndex}</small>
          <h2>{node.label}</h2>
        </div>
      </div>
      <div className="task-detail-tags">
        <span className="goal-badge">{orthogonal ? "同层并行 · 无写冲突" : "顺序依赖推进"}</span>
        <span className="task-status-tag" data-status={node.status}>
          <StatusIcon size={13} status={node.status} /> {statusLabel(node.status)}
        </span>
      </div>

      <p className="detail-lead">{node.objective}</p>
      <StatusProvenance scope="goal" source={node.statusSource} />

      <AgentBadge worker={node.worker} />
      <OwnershipNote worker={node.worker} />

      <div className="task-checkpoints-section">
        <div className="path-list-heading">
          <strong>任务检查点序列 ({node.checkpoints.length})</strong>
          <span>独立可验收子目标</span>
        </div>
        <div className="task-cp-list">
          {node.checkpoints.map((cp, idx) => (
            <button
              className="task-cp-row"
              key={cp.id}
              onClick={() => onSelect({ kind: "checkpoint", id: cp.id })}
              type="button"
            >
              <span className="cp-step">{String(idx + 1).padStart(2, "0")}</span>
              <div className="cp-copy">
                <strong>{cp.id}</strong>
                <p>{cp.objective}</p>
              </div>
              <StatusIcon size={14} status={cp.status} />
            </button>
          ))}
        </div>
      </div>

      {edge && (
        <div className="task-linked-edge">
          <div className="path-list-heading">
            <strong>关联跨层路径探索</strong>
            <span>{edge.paths.length} 条备选方案</span>
          </div>
          <button
            className="linked-edge-button"
            onClick={() => onSelect({ kind: "edge", id: edge.id })}
            type="button"
          >
            <div>
              <small>{edge.id}</small>
              <strong>{edge.label}</strong>
            </div>
            <span className="edge-result">
              {edge.selectedPaths} 采用 · {edge.paths.filter((p) => p.status === "succeeded" || p.status === "feasible_unselected").length} 可行
            </span>
          </button>
        </div>
      )}
    </div>
  );
}

function GoalDetail({
  goal,
  onSelect,
}: {
  goal: CheckpointTreeNode;
  onSelect: (selection: JourneySelection) => void;
}) {
  const depthName =
    goal.depth === 0 ? "阶段根目标" : goal.depth === 1 ? "L1 正交目标" : goal.depth === 2 ? "L2 子目标" : `L${goal.depth} 细分目标`;

  return (
    <div className="inspector-section" data-testid="goal-detail">
      <div className="detail-heading">
        <span className="detail-icon"><GitBranch size={17} weight="bold" /></span>
        <div>
          <small>{goal.id}</small>
          <h2>{goal.label}</h2>
        </div>
      </div>

      <div className="task-detail-tags">
        <span className="goal-badge">{depthName}</span>
        <span className="task-status-tag" data-status={goal.status}>
          <StatusIcon size={13} status={goal.status} /> {statusLabel(goal.status)}
        </span>
      </div>

      <p className="detail-lead">{goal.objective}</p>
      <StatusProvenance scope={goal.kind === "checkpoint" ? "checkpoint" : "goal"} source={goal.statusSource} />

      {goal.worker && (
        <>
          <AgentBadge worker={goal.worker} />
          <OwnershipNote worker={goal.worker} />
        </>
      )}

      {goal.acceptanceOracle && (
        <section className="oracle-card">
          <span>验收标准 / Oracle</span>
          <p>{goal.acceptanceOracle}</p>
        </section>
      )}

      {goal.invariants && goal.invariants.length > 0 && (
        <div className="bullet-section">
          <strong>必须保持的不变量</strong>
          {goal.invariants.map((item) => (
            <p key={item}>— {item}</p>
          ))}
        </div>
      )}

      {goal.children && goal.children.length > 0 && (
        <div className="task-checkpoints-section">
          <div className="path-list-heading">
            <strong>下属分支 / 检查点 ({goal.children.length})</strong>
            <span>深度 {goal.depth + 1}</span>
          </div>
          <div className="task-cp-list">
            {goal.children.map((child, idx) => (
              <button
                className="task-cp-row"
                key={child.id}
                onClick={() => {
                  if (child.kind === "checkpoint") onSelect({ kind: "checkpoint", id: child.id });
                  else onSelect({ kind: "goal", id: child.id });
                }}
                type="button"
              >
                <span className="cp-step">{String(idx + 1).padStart(2, "0")}</span>
                <div className="cp-copy">
                  <span className="sub-depth-tag">{child.kind === "checkpoint" ? "CP" : `L${child.depth}`}</span>
                  <strong>{child.label}</strong>
                  <p>{child.objective}</p>
                </div>
                <StatusIcon size={14} status={child.status} />
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function JourneyInspectorView({
  snapshot,
  selection,
  onSelect,
  onClose,
}: {
  snapshot: WorkflowSnapshot;
  selection: JourneySelection;
  onSelect: (selection: JourneySelection) => void;
  onClose: () => void;
}) {
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => { closeButton.current?.focus({ preventScroll: true }); }, []);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); onClose(); } };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [onClose]);
  const [tab, setTab] = useState<"detail" | "activity">("detail");
  const allEdges = useMemo(() => snapshot.journey.transitions.flatMap((transition) => transition.edges), [snapshot]);
  const allCheckpoints = useMemo(() => snapshot.journey.layers.flatMap((layer) => layer.nodes.flatMap((node) => node.checkpoints)), [snapshot]);
  const allNodes = useMemo(() => snapshot.journey.layers.flatMap((layer) => layer.nodes), [snapshot]);

  const edge =
    selection.kind === "edge"
      ? allEdges.find((item) => item.id === selection.id)
      : selection.kind === "path"
      ? allEdges.find((item) => item.id === selection.edgeId)
      : null;
  const selectedPath = selection.kind === "path" ? edge?.paths.find((path) => path.id === selection.id) || null : null;
  const checkpoint = selection.kind === "checkpoint" ? allCheckpoints.find((item) => item.id === selection.id) : null;
  const route = selection.kind === "route" ? snapshot.journey.routes.find((item) => item.id === selection.id) : null;

  const taskNode = useMemo(() => {
    if (selection.kind !== "task") return null;
    return allNodes.find((node) => node.id === selection.id || node.goalId === selection.id) || null;
  }, [allNodes, selection]);

  const taskLayer = useMemo(() => {
    if (!taskNode) return null;
    return snapshot.journey.layers.find((layer) => layer.nodes.some((n) => n.id === taskNode.id)) || null;
  }, [snapshot.journey.layers, taskNode]);

  const linkedEdge = useMemo(() => {
    if (!taskNode) return null;
    return allEdges.find((e) => e.id === taskNode.id || e.to === taskNode.id || e.id === taskNode.goalId) || null;
  }, [allEdges, taskNode]);

  const goalNode = useMemo(() => {
    if (selection.kind !== "goal") return null;
    if (selection.id === snapshot.journey.root.id && snapshot.checkpointTree?.root) {
      return { ...snapshot.checkpointTree.root, id: snapshot.journey.root.id, label: snapshot.journey.root.label, objective: snapshot.journey.root.objective, status: snapshot.journey.root.status };
    }
    function search(node: CheckpointTreeNode): CheckpointTreeNode | null {
      if (node.id === selection.id) return node;
      for (const child of node.children) {
        const found = search(child);
        if (found) return found;
      }
      return null;
    }
    return snapshot.checkpointTree?.root ? search(snapshot.checkpointTree.root) : null;
  }, [selection, snapshot.checkpointTree, snapshot.journey.root]);

  function select(next: JourneySelection) {
    setTab("detail");
    onSelect(next);
  }

  return (
    <aside className="inspector inspector-drawer" aria-label="路径与检查点详情" data-testid="detail-drawer">
      <header className="drawer-heading"><span>节点详情</span><button ref={closeButton} className="icon-button" aria-label="关闭详情" onClick={onClose} type="button"><X size={18} /></button></header>
      <div className="inspector-tabs" role="tablist" aria-label="右栏内容">
        <button aria-selected={tab === "detail"} onClick={() => setTab("detail")} role="tab" type="button">
          详情
        </button>
        <button aria-selected={tab === "activity"} onClick={() => setTab("activity")} role="tab" type="button">
          实时动态 <span>{snapshot.events.length}</span>
        </button>
      </div>

      <div className="inspector-body">
        {tab === "activity" ? (
          <div className="activity-list" data-testid="activity-list">
            <header>
              <ClockCounterClockwise size={18} />
              <div>
                <h2>实时事件</h2>
                <p>最新 12 条 canonical event</p>
              </div>
            </header>
            {snapshot.events
              .slice(-12)
              .reverse()
              .map((event) => (
                <article data-tone={event.tone} key={event.eventId}>
                  <i />
                  <div>
                    <strong>{eventLabel(event)}</strong>
                    <span>{event.actor} · revision {event.toRevision}</span>
                  </div>
                  <time dateTime={event.at}>{formatTime(event.at)}</time>
                </article>
              ))}
          </div>
        ) : taskNode ? (
          <TaskDetail
            edge={linkedEdge}
            layerIndex={taskLayer?.index || 1}
            node={taskNode}
            onSelect={select}
            orthogonal={taskLayer?.orthogonal ?? true}
          />
        ) : goalNode ? (
          <GoalDetail goal={goalNode} onSelect={select} />
        ) : edge ? (
          <EdgeDetail edge={edge} onSelect={select} selectedPath={selectedPath} />
        ) : checkpoint ? (
          <div className="inspector-section" data-testid="checkpoint-detail">
            <div className="detail-heading">
              <span className="detail-icon"><ShieldCheck size={17} /></span>
              <div>
                <small>{checkpoint.l1Id}</small>
                <h2>{checkpoint.id}</h2>
              </div>
            </div>
            <span className="goal-badge">检查点 = 可独立验收子目标</span>
            <p className="detail-lead">{checkpoint.objective}</p>
            <StatusProvenance scope="checkpoint" source={checkpoint.statusSource} />
            <AgentBadge worker={checkpoint.worker} />
            <OwnershipNote worker={checkpoint.worker} />
            <EvidenceRecord evidence={checkpoint.acceptance} />
            <section className="oracle-card">
              <span>验收标准 / Oracle</span>
              <p>{checkpoint.acceptanceOracle}</p>
            </section>
            <dl className="detail-rows">
              <div><dt>状态</dt><dd>{statusLabel(checkpoint.status)}</dd></div>
              <div><dt>前置依赖</dt><dd>{checkpoint.dependsOn.length ? checkpoint.dependsOn.join(" · ") : "无前置"}</dd></div>
              <div><dt>提供给下游</dt><dd>{checkpoint.providesTo.length ? checkpoint.providesTo.join(" · ") : "最终收口"}</dd></div>
            </dl>
            <div className="bullet-section">
              <strong>必须保持的不变量</strong>
              {checkpoint.invariants.map((item) => (
                <p key={item}>— {item}</p>
              ))}
            </div>
          </div>
        ) : route ? (
          <div className="inspector-section" data-testid="route-detail">
            <div className="detail-heading">
              <span className="detail-icon"><GitBranch size={17} /></span>
              <div>
                <small>全局候选路线 #{route.rank}</small>
                <h2>{route.title}</h2>
              </div>
            </div>
            <span className="goal-badge">
              {route.selected
                ? route.selectedAtRevision != null
                  ? `用户已决策选择 · revision ${route.selectedAtRevision}`
                  : "用户已决策选择"
                : route.recommended
                  ? "推荐候选路线"
                  : "备选路线方案"}
            </span>
            <div className="route-sequence">
              {route.pathSequence.map((path, index) => (
                <div key={path}>
                  <span>{index + 1}</span>
                  <p>{path}</p>
                </div>
              ))}
            </div>
            {route.selected && <ImplementationCard snapshot={snapshot} />}
          </div>
        ) : (
          <div className="inspector-empty">
            <Info size={22} />
            <h2>选择一个对象</h2>
            <p>点击拓扑图中的总目标、正交任务、检查点、实现路径或全局路线查看详情。</p>
          </div>
        )}
      </div>

      <footer className="inspector-foot">
        <span><i /> {snapshot.runtime.sourceMode === "demo" ? "DEMO" : "LIVE"}</span>
        <span>{formatTime(snapshot.generatedAt)}</span>
      </footer>
    </aside>
  );
}

// The 1s poll re-delivers an identical snapshot most seconds; the hook already
// skips unchanged data, and memoizing keeps the ticking clock from re-rendering here.
export const JourneyInspector = memo(JourneyInspectorView);
