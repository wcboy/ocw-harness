import { ArrowsIn } from "@phosphor-icons/react/ArrowsIn";
import { CaretDown } from "@phosphor-icons/react/CaretDown";
import { GitBranch } from "@phosphor-icons/react/GitBranch";
import { Lightning } from "@phosphor-icons/react/Lightning";
import { Minus } from "@phosphor-icons/react/Minus";
import { Plus } from "@phosphor-icons/react/Plus";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { statusLabel } from "../format";
import type { AgentBinding, CheckpointTreeNode, JourneyEdge, JourneyModel, JourneyNode, JourneySelection } from "../types";
import { StatusIcon } from "./StatusIcon";

type Filter = "all" | "working_only" | "selected_route";
import { buildConnections, pathTone, pathToneLabel, shortPathLabel, type GraphWire, type GraphJoin, type GraphPort } from "../graph-layout";

function contains(node: CheckpointTreeNode, id?: string): boolean {
  return node.id === id || node.children.some(child => contains(child, id));
}
function LiveWorker({ worker }: { worker?: AgentBinding | null }) {
  return worker?.working ? <span className="graph-worker" title={worker.inherited ? "继承自任务边的执行归属" : worker.role}><Lightning size={12} weight="fill" />{worker.displayName}</span> : null;
}
function BranchNode({ node, selection, onSelect, expandAll }: { node: CheckpointTreeNode; selection: JourneySelection | null; onSelect: (next: JourneySelection) => void; expandAll: boolean }) {
  const [open, setOpen] = useState(expandAll);
  useEffect(() => setOpen(expandAll), [expandAll]);
  useEffect(() => { if (node.children.some(child => contains(child, selection?.id))) setOpen(true); }, [selection?.id]);
  return <li className="branch-item" data-depth={node.depth} data-kind={node.kind}>
    <div className="branch-row">
      <button className="branch-node" data-active={selection?.id === node.id} data-status={node.status} data-working={Boolean(node.worker?.working)} data-checkpoint={node.id} onClick={() => onSelect({ kind: node.kind === "checkpoint" ? "checkpoint" : "goal", id: node.id })} type="button">
        <StatusIcon status={node.status} size={16} /><span className="branch-copy"><strong>{node.objective || node.label}</strong><small>{node.id} · {statusLabel(node.status)}</small><LiveWorker worker={node.worker} /></span>
      </button>
      {node.children.length > 0 && <button className="branch-toggle" aria-expanded={open} aria-label={`${open ? "折叠" : "展开"} ${node.id} 的 ${node.children.length} 个下级节点`} onClick={() => setOpen(!open)} type="button"><CaretDown size={14} /><span>{node.children.length}</span></button>}
    </div>
    {open && node.children.length > 0 && <ul className="branch-children">{node.children.map(child => <BranchNode key={child.id} node={child} selection={selection} onSelect={onSelect} expandAll={expandAll} />)}</ul>}
  </li>;
}

function TaskNode({ node, edges, selection, onSelect, expandAll, pathsOpen, togglePaths }: { node: JourneyNode; edges: JourneyEdge[]; selection: JourneySelection | null; onSelect: (next: JourneySelection) => void; expandAll: boolean; pathsOpen: boolean; togglePaths: () => void }) {
  const [open, setOpen] = useState(false);
  const workingAgents = [...new Map([node.worker, ...node.checkpoints.map(cp => cp.worker), ...edges.flatMap(edge => [edge.worker, ...edge.paths.map(path => path.worker)])].filter((worker): worker is AgentBinding => Boolean(worker?.working)).map(worker => [worker.agentRef || worker.assignmentId, worker])).values()];
  const worker = workingAgents[0];
  useEffect(() => setOpen(expandAll), [expandAll]);
  useEffect(() => {
    if (selection?.kind === "goal" && node.treeNode && contains(node.treeNode, selection.id)) setOpen(true);
  }, [selection?.id]);
  const paths = edges.flatMap(edge => edge.paths);
  const accepted = node.checkpoints.filter(cp => cp.status === "complete").length;
  const branches = node.treeNode?.children;
  return <article className="graph-task mindmap-task-card checkpoint-region" data-graph-node={node.id} data-paths-open={pathsOpen} style={{ minHeight: pathsOpen ? Math.max(260, edges.reduce((count, edge) => Math.max(count, edge.paths.length), 0) * 42 + 70) : undefined }} data-active={selection?.id === node.id || selection?.id === node.goalId} data-status={node.status} data-working={Boolean(worker?.working)} data-selected-route={paths.some(path => pathTone(path) === "adopted")}>
    {edges.length > 0 && <button className="graph-path-toggle" data-testid={`paths-${node.id}`} data-open={pathsOpen} data-working={edges.some(edge => edge.worker?.working || edge.paths.some(path => path.worker?.working))} aria-expanded={pathsOpen} aria-label={`${pathsOpen ? "收起" : "展开"} ${node.label} 的 ${paths.length} 条路径`} onClick={togglePaths} type="button"><GitBranch size={13} /><span>{paths.length} 条路径</span><CaretDown size={12} /></button>}
    <button className="graph-task-title task-title-interactive" onClick={() => onSelect({ kind: "task", id: node.id })} type="button"><span className="graph-task-top"><span className="graph-status" data-status={node.status}><StatusIcon status={node.status} size={16} />{statusLabel(node.status)}</span></span><h2 title={node.goalId}>{node.label}</h2><LiveWorker worker={worker} />{workingAgents.length > 1 && <span className="graph-worker-count" title={workingAgents.map(agent => agent.displayName).join("、")}>另有 {workingAgents.length - 1} 个代理工作中</span>}</button>
    <div className="checkpoint-policy"><span>∧ 全部满足</span><small>{accepted}/{node.checkpoints.length} 完成</small></div>
    <div className="checkpoint-points" role="group" aria-label={`${node.label} 的全部必要检查点`}>{node.checkpoints.map(cp => <button key={cp.id} className="checkpoint-point" data-status={cp.status} data-checkpoint={cp.id} data-active={selection?.id === cp.id} onClick={() => onSelect({ kind: "checkpoint", id: cp.id })} title={`${cp.id} · ${cp.objective} · ${statusLabel(cp.status)}`} type="button"><StatusIcon status={cp.status} size={20} /><span>{cp.objective || cp.id}</span><small>{statusLabel(cp.status)}</small><LiveWorker worker={cp.worker} /></button>)}</div>
    <button className="graph-checkpoint-toggle" data-testid={`expand-${node.goalId}`} aria-expanded={open} onClick={() => setOpen(!open)} type="button"><span>查看分解层次</span><span>{open ? "收起" : "展开"}<CaretDown size={14} /></span></button>
    {open && <div className="graph-checkpoints" aria-label={`${node.label} 分解与检查点`}><ul className="branch-tree" data-testid={`branch-tree-${node.goalId}`}>
      {branches?.length ? branches.map(child => <BranchNode key={child.id} node={child} selection={selection} onSelect={onSelect} expandAll={expandAll} />) : node.checkpoints.map(cp => <BranchNode key={cp.id} node={{ ...cp, label: cp.id, depth: 2, kind: "checkpoint", edgeId: node.edgeId, checkpointId: cp.id, children: [] }} selection={selection} onSelect={onSelect} expandAll={expandAll} />)}
    </ul>{!node.checkpoints.length && !branches?.length && <p className="branch-empty">尚未定义检查点</p>}</div>}
  </article>;
}

function OrthogonalJourneyView({ journey, agentActivity, selection, onSelect, defaultPathsExpanded = false }: { journey: JourneyModel; agentActivity?: { workingCount: number; assignments: AgentBinding[] } | null; selection: JourneySelection | null; onSelect: (next: JourneySelection) => void; defaultPathsExpanded?: boolean }) {
  const [filter, setFilter] = useState<Filter>("all");
  const [expandAll, setExpandAll] = useState(false);
  const [routesOpen, setRoutesOpen] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => new Set(defaultPathsExpanded ? journey.layers.flatMap(layer => layer.nodes.map(node => node.id)) : []));
  const [joins, setJoins] = useState<GraphJoin[]>([]);
  const [wires, setWires] = useState<GraphWire[]>([]);
  const canvas = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const initiallyFitted = useRef(false);
  const edges = useMemo(() => journey.transitions.flatMap(item => item.edges), [journey.transitions]);
  const nodes = useMemo(() => journey.layers.flatMap(layer => layer.nodes), [journey.layers]);
  const selectedPaths = edges.reduce((sum, edge) => sum + edge.paths.filter(path => pathTone(path) === "adopted").length, 0);
  const working = agentActivity?.workingCount || 0;
  const empty = filter === "working_only" && !working || filter === "selected_route" && !selectedPaths;
  const activeFilter = empty ? "all" : filter;
  const withRoutes = journey.routes.length > 0;
  const routeWorker = agentActivity?.assignments.find(worker => worker.working && journey.routes.some(route => route.id === worker.routeId));
  useEffect(() => {
    if (selection?.kind !== "path") return;
    const edge = edges.find(edge => edge.id === selection.edgeId);
    if (edge) setExpandedPaths(old => new Set([...old, edge.to]));
  }, [selection?.id]);
  const gaps = useMemo(() => new Map(journey.layers.flatMap(layer => {
    const gap = layer.nodes.some(node => expandedPaths.has(node.id)) ? 260 : 100;
    return layer.nodes.map(node => [node.id, gap] as const);
  })), [journey.layers, expandedPaths]);
  const maxRows = Math.max(1, ...journey.layers.map(layer => layer.nodes.length));

  // Measure real DOM ports after disclosure/resizing. Dependencies are joined by
  // canonical ids, never by a task-specific table or a hardcoded vertical slot.
  useLayoutEffect(() => {
    const element = canvas.current;
    if (!element) return;
    let frame = 0;
    const measure = () => {
      const origin = element.getBoundingClientRect();
      const scale = origin.width / element.offsetWidth || 1;
      const ports = new Map<string, GraphPort>();
      const all = element.querySelectorAll<HTMLElement>("[data-graph-node]");
      all.forEach(port => {
        const r = port.getBoundingClientRect();
        const id = port.dataset.graphNode!;
        const column = id === journey.root.id ? 0 : journey.layers.findIndex(layer => layer.nodes.some(node => node.id === id)) + 1;
        const point = { x: (r.left - origin.left) / scale, y: (r.top + r.height / 2 - origin.top) / scale, width: r.width / scale, column };
        ports.set(id, point);
        const node = nodes.find(item => item.id === id);
        if (node) { ports.set(node.goalId, point); node.checkpoints.forEach(cp => ports.set(cp.id, point)); }
      });
      const { wires: next, joins: nextJoins } = buildConnections(edges, ports, expandedPaths, gaps);
      setJoins(old => JSON.stringify(old) === JSON.stringify(nextJoins) ? old : nextJoins);
      if (withRoutes) {
        const output = element.querySelector<HTMLElement>("[data-graph-output]")?.getBoundingClientRect();
        if (output) {
          const end = (output.left - origin.left) / scale, endY = (output.top + output.height / 2 - origin.top) / scale;
          const outgoing = new Set(edges.flatMap(edge => edge.from));
          nodes.filter(node => !outgoing.has(node.id) && !outgoing.has(node.goalId) && !node.checkpoints.some(cp => outgoing.has(cp.id))).forEach(node => {
            const from = ports.get(node.id); if (!from) return;
            const x = from.x + from.width, mid = (x + end) / 2;
            next.push({ id: `summary:${node.id}`, edge: "", d: `M${x},${from.y} C${mid},${from.y} ${mid},${endY} ${end},${endY}`, kind: "summary", working: false, sourceX: x, sourceY: from.y, targetX: end, targetY: endY });
          });
        }
      }
      const width = element.offsetWidth, height = element.offsetHeight;
      setSize(old => old.width === width && old.height === height ? old : { width, height });
      setWires(old => JSON.stringify(old) === JSON.stringify(next) ? old : next);
    };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(measure); };
    const observer = new ResizeObserver(schedule);
    observer.observe(element);
    element.querySelectorAll(".graph-task, .graph-root, .graph-routes").forEach(node => observer.observe(node));
    measure();
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, [journey, edges, nodes, withRoutes, expandedPaths, gaps]);

  function fit() {
    if (!scroller.current || !size.width) return;
    setZoom(Math.min(1, Math.max(.6, Math.min((scroller.current.clientWidth - 32) / size.width, (scroller.current.clientHeight - 24) / size.height))));
    scroller.current.scrollTo({ left: 0, top: 0, behavior: "instant" });
  }
  useEffect(() => {
    if (defaultPathsExpanded && size.width && !initiallyFitted.current) { fit(); initiallyFitted.current = true; }
  }, [size.width, size.height, defaultPathsExpanded]);
  const highlightedEdge = selection?.kind === "edge" ? selection.id : selection?.kind === "path" ? selection.edgeId : nodes.find(node => node.id === selection?.id || node.checkpoints.some(cp => cp.id === selection?.id))?.edgeId;

  return <section className="journey-panel graph-panel" aria-labelledby="journey-title">
    <header className="graph-toolbar"><div><h1 id="journey-title">路径与检查点</h1><p>组内全部满足 · 组间探索路径</p></div><div className="graph-actions">
      <div className="graph-filters" role="group" aria-label="高亮筛选">{([ ["all", "全部"], ["working_only", `只看工作中 (${working})`], ["selected_route", `只看采纳路线 (${selectedPaths})`]] as const).map(([id, label]) => <button className="highlight-pill" key={id} data-active={filter === id} onClick={() => setFilter(id)} type="button">{label}</button>)}</div>
      <button className="graph-expand-all" aria-pressed={expandedPaths.size > 0} onClick={() => setExpandedPaths(expandedPaths.size ? new Set() : new Set(nodes.map(node => node.id)))} type="button">{expandedPaths.size ? "收起路径" : "展开路径"}</button>
      <button className="graph-expand-all" aria-pressed={expandAll} onClick={() => setExpandAll(!expandAll)} type="button">{expandAll ? <ArrowsIn size={15} /> : <GitBranch size={15} />}{expandAll ? "收起检查点" : "展开检查点"}</button>
    </div></header>
    {empty && <p className="filter-empty-note" data-testid="filter-empty-note" role="status">{filter === "working_only" ? "当前没有代理在执行，已保持全部节点可见。" : "当前还没有任何路径被采纳，已保持全部节点可见。"}</p>}
    <div className="journey-scroller graph-scroller" data-testid="journey-scroller" ref={scroller} tabIndex={0} aria-label="路径图画布，可横向滚动或拖动空白处" onPointerDown={event => { if ((event.target as HTMLElement).closest("button, a, input") || event.pointerType !== "mouse") return; drag.current = { x: event.clientX, y: event.clientY, left: event.currentTarget.scrollLeft, top: event.currentTarget.scrollTop }; event.currentTarget.setPointerCapture(event.pointerId); }} onPointerMove={event => { if (!drag.current) return; event.currentTarget.scrollLeft = drag.current.left - event.clientX + drag.current.x; event.currentTarget.scrollTop = drag.current.top - event.clientY + drag.current.y; }} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}>
      <div className="graph-size" style={{ width: size.width ? size.width * zoom : undefined, height: size.height ? size.height * zoom : undefined }}><div className="journey-track graph-track" ref={canvas} data-filter={activeFilter} data-testid="journey-track" style={{ transform: `scale(${zoom})`, paddingTop: Math.max(48, edges.length * 10 + 20, ...edges.filter(edge => expandedPaths.has(edge.to)).map(edge => edge.paths.length * 21 - 50)) }}>
        <svg className="graph-wires" aria-hidden="true" width={size.width} height={size.height}>{wires.map(wire => <g key={wire.id} data-wire={wire.id} data-tone={wire.tone} data-kind={wire.kind} data-working={wire.working} data-active={wire.edge === highlightedEdge}>
          <path className="connection-line" d={wire.d} data-edge={wire.edge} />
          {wire.tone === "adopted" && <path className="connection-flow" d={wire.d} />}
        </g>)}</svg>
        <div className="graph-path-labels">{wires.filter(wire => wire.attempt).map(wire => <button key={wire.id} className="path-line-label mini-path-pill" style={{ left: wire.labelX, top: wire.labelY }} data-selected={wire.tone === "adopted"} data-status={wire.attempt!.status} data-tone={wire.tone} data-working={wire.working} data-active={selection?.id === wire.attempt!.id} aria-label={`${wire.attempt!.label} · ${pathToneLabel[wire.tone!]}`} title={`${wire.attempt!.label} · ${pathToneLabel[wire.tone!]}`} onClick={() => onSelect({ kind: "path", id: wire.attempt!.id, edgeId: wire.edge })} type="button"><span className="path-state-symbol">{wire.tone === "refuted" ? "×" : wire.tone === "adopted" ? "✓" : wire.tone === "pending" ? "?" : "↗"}</span><strong>{shortPathLabel(wire.attempt!)}</strong>{wire.working && <i className="path-worker-dot" title={`${wire.attempt!.worker?.displayName} 工作中${wire.attempt!.worker?.inherited ? "（继承分组归属）" : ""}`} aria-label={`${wire.attempt!.worker?.displayName} 工作中`} />}</button>)}</div>
        {joins.map(join => <button className="dependency-join" style={{ left: join.x, top: join.y }} key={join.id} title={`${join.count} 个前置分组需要全部满足`} onClick={() => onSelect({ kind: "edge", id: join.id })} type="button" aria-label={`${join.count} 个前置分组需要全部满足`}>∧</button>)}
        <div className="graph-column graph-root-column" style={{ paddingTop: Math.max(0, (maxRows - 1) * 83 - 50) }}><span className="graph-column-label">起点</span><button className="graph-root" data-graph-node={journey.root.id} data-status={journey.root.status} data-active={selection?.id === journey.root.id} onClick={() => onSelect({ kind: "goal", id: journey.root.id })} type="button"><span className="graph-root-icon"><GitBranch size={21} /></span><strong>{journey.root.label}</strong><p>{journey.root.objective}</p><span className="graph-status" data-status={journey.root.status}><StatusIcon status={journey.root.status} size={14} />全阶段状态：{statusLabel(journey.root.status)}</span></button></div>
        {journey.layers.map(layer => <section className="graph-column" style={{ paddingTop: (maxRows - layer.nodes.length) * 110, marginLeft: gaps.get(layer.nodes[0]?.id) || 100 }} data-testid={`journey-layer-${layer.index}`} key={layer.index}><header className="graph-column-label"><strong>{String(layer.index).padStart(2, "0")}</strong><span>{layer.orthogonal ? `${layer.nodes.length} 项并行` : "依赖前序"}</span></header><div className="graph-task-stack">{layer.nodes.map(node => <TaskNode key={node.id} pathsOpen={expandedPaths.has(node.id)} togglePaths={() => setExpandedPaths(old => { const next = new Set(old); if (next.has(node.id)) next.delete(node.id); else next.add(node.id); return next; })} node={node} edges={edges.filter(edge => edge.to === node.id || edge.id === node.edgeId)} selection={selection} onSelect={onSelect} expandAll={expandAll} />)}</div></section>)}
        {withRoutes && <section className="graph-column graph-output-column" style={{ paddingTop: Math.max(0, (maxRows - 1) * 83 - 25) }} data-testid="global-route"><span className="graph-column-label">汇聚 · 交付</span><div className="graph-routes" data-working={Boolean(routeWorker)} data-graph-output><LiveWorker worker={routeWorker} /><span className="graph-section-label">{journey.selectedRoute ? "已采纳路线" : "等待路线决策"}</span><button className="graph-route-main" onClick={() => onSelect({ kind: "route", id: (journey.selectedRoute || journey.routes[0]).id })} type="button"><strong>{journey.selectedRoute?.title || `${journey.routes.length} 条候选路线`}</strong><span>{journey.implementation.r5Verdict === "pass" ? "✓ 终审通过" : "查看路线与交付 →"}</span></button><button className="graph-checkpoint-toggle" aria-expanded={routesOpen} onClick={() => setRoutesOpen(!routesOpen)} type="button">比较 {journey.routes.length} 条路线<CaretDown size={14} /></button>{routesOpen && <div className="graph-route-list">{journey.routes.map(route => <button className="route-option" data-selected={route.selected} data-active={selection?.id === route.id} key={route.id} onClick={() => onSelect({ kind: "route", id: route.id })} type="button"><strong>{route.title}</strong><small>{route.selected ? "已采纳" : "备选"}</small></button>)}</div>}</div></section>}
      </div></div>
    </div>
    <footer className="graph-footer"><span className="graph-hint"><span className="path-legend"><span data-tone="adopted">━ 已采纳</span><span data-tone="refuted">━ × 已证伪</span><span data-tone="pending">┄ 待定</span><span data-tone="feasible">━ 可行未选</span></span></span><div className="graph-zoom"><button aria-label="缩小路径图" onClick={() => setZoom(value => Math.max(.6, value - .1))} type="button"><Minus size={14} /></button><span>{Math.round(zoom * 100)}%</span><button aria-label="放大路径图" onClick={() => setZoom(value => Math.min(1.4, value + .1))} type="button"><Plus size={14} /></button><button onClick={fit} type="button">适应画布</button></div></footer>
  </section>;
}
export const OrthogonalJourney = memo(OrthogonalJourneyView);
