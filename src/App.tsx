import { ArrowClockwise } from "@phosphor-icons/react/ArrowClockwise";
import { Broadcast } from "@phosphor-icons/react/Broadcast";
import { GitBranch } from "@phosphor-icons/react/GitBranch";
import { Moon } from "@phosphor-icons/react/Moon";
import { Sun } from "@phosphor-icons/react/Sun";
import { WarningCircle } from "@phosphor-icons/react/WarningCircle";
import { useEffect, useRef, useState } from "react";
import { HarnessRegistry } from "./components/HarnessRegistry";
import { JourneyInspector } from "./components/JourneyInspector";
import { OrthogonalJourney } from "./components/OrthogonalJourney";
import { StageStrip } from "./components/StageStrip";
import { HarnessDemo } from "./components/HarnessDemo";
import { useCurrentUi } from "./ui-release";
import { formatTime } from "./format";
import type { CheckpointTreeNode, JourneySelection, WorkflowSnapshot } from "./types";
import { useHarnessRegistry } from "./useHarnessRegistry";
import { useWorkflowStream } from "./useWorkflowStream";

type Theme = "light" | "dark";

function initialTheme(): Theme {
  const stored = localStorage.getItem("ocw-theme");
  if (stored === "light" || stored === "dark") return stored;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function LoadingShell() {
  return <main className="state-page" aria-busy="true"><span className="state-mark"><GitBranch size={24} weight="bold" /></span><div><span className="eyebrow">OCW HARNESS</span><h1>正在加载工作流</h1><p>正在读取任务进度…</p></div></main>;
}

function ErrorShell({ message, onRetry }: { message: string; onRetry: () => void }) {
  return <main className="state-page" role="alert"><span className="state-mark error"><WarningCircle size={24} weight="fill" /></span><div><span className="eyebrow">SOURCE UNAVAILABLE</span><h1>无法打开工作流窗口</h1><p>{message}</p><button className="retry-button" onClick={onRetry} type="button"><ArrowClockwise size={16} /> 重试连接</button></div></main>;
}

function resolveSelection(snapshot: WorkflowSnapshot, requested: string | null): JourneySelection {
  if (requested === snapshot.journey.root.id) return { kind: "goal", id: requested };
  const edges = snapshot.journey.transitions.flatMap((transition) => transition.edges);
  const paths = edges.flatMap((edge) => edge.paths.map((item) => ({ ...item, edgeId: edge.id })));
  const path = paths.find((item) => item.id === requested);
  if (path) return { kind: "path", id: path.id, edgeId: path.edgeId };
  if (edges.some((edge) => edge.id === requested)) return { kind: "edge", id: requested! };
  const checkpoints = snapshot.journey.layers.flatMap((layer) => layer.nodes.flatMap((node) => node.checkpoints));
  if (checkpoints.some((checkpoint) => checkpoint.id === requested)) return { kind: "checkpoint", id: requested! };
  const task = snapshot.journey.layers.flatMap((layer) => layer.nodes).find((node) => node.id === requested || node.goalId === requested);
  if (task) return { kind: "task", id: task.id };
  if (snapshot.journey.routes.some((route) => route.id === requested)) return { kind: "route", id: requested! };

  function findInTree(treeNode: CheckpointTreeNode, target: string): CheckpointTreeNode | null {
    if (treeNode.id === target) return treeNode;
    for (const child of treeNode.children) {
      const found = findInTree(child, target);
      if (found) return found;
    }
    return null;
  }
  if (requested && snapshot.checkpointTree?.root) {
    const foundNode = findInTree(snapshot.checkpointTree.root, requested);
    if (foundNode) {
      if (foundNode.kind === "checkpoint") return { kind: "checkpoint", id: foundNode.id };
      return { kind: "goal", id: foundNode.id };
    }
  }

  const workingPath = paths.find((item) => item.worker?.working);
  if (workingPath) return { kind: "path", id: workingPath.id, edgeId: workingPath.edgeId };
  const workingCheckpoint = checkpoints.find((item) => item.worker?.working);
  if (workingCheckpoint) return { kind: "checkpoint", id: workingCheckpoint.id };
  const workingEdge = edges.find((item) => item.worker?.working);
  if (workingEdge) return { kind: "edge", id: workingEdge.id };
  if (snapshot.journey.selectedRoute) return { kind: "route", id: snapshot.journey.selectedRoute.id };
  if (edges[0]) return { kind: "edge", id: edges[0].id };
  if (snapshot.journey.routes[0]) return { kind: "route", id: snapshot.journey.routes[0].id };
  throw new Error("工作流中没有可展示的路径、检查点或路线");
}

export function App() {
  useCurrentUi();
  return new URLSearchParams(window.location.search).get("demo") === "paths" ? <HarnessDemo /> : <LiveHarness />;
}

function LiveHarness() {
  const registryState = useHarnessRegistry();
  const [selectedHarnessId, setSelectedHarnessId] = useState<string | null>(() => new URLSearchParams(window.location.search).get("harness"));
  const [forceOverview, setForceOverview] = useState(false);
  const { snapshot, connection, error, lastReceivedAt, refresh } = useWorkflowStream(selectedHarnessId);
  const [theme, setTheme] = useState<Theme>(initialTheme);
  // Null until a snapshot arrives; seeding a concrete id here would bake one
  // task's edge into a console that serves any harness.
  const [selection, setSelection] = useState<JourneySelection | null>(null);
  const initializedSelection = useRef(false);
  const drawerOpener = useRef<HTMLElement | null>(null);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("ocw-theme", theme);
  }, [theme]);

  useEffect(() => {
    if (snapshot) document.title = `OCW · ${snapshot.task.id} · ${snapshot.runtime.sessionId} · R${snapshot.task.revision}`;
    else if (registryState.registry) document.title = `OCW Harness Registry · ${registryState.registry.counts.registrations} sessions`;
  }, [registryState.registry, snapshot]);

  useEffect(() => {
    const registry = registryState.registry;
    if (!registry) return;
    if (selectedHarnessId && registry.registrations.some((item) => item.registrationId === selectedHarnessId)) return;
    const requested = new URLSearchParams(window.location.search).get("harness");
    if (requested && registry.registrations.some((item) => item.registrationId === requested)) {
      setSelectedHarnessId(requested);
      return;
    }
    const open = registry.registrations.filter((item) => item.lifecycle !== "closed" && item.available);
    setSelectedHarnessId(!forceOverview && open.length === 1 ? open[0].registrationId : null);
  }, [forceOverview, registryState.registry, selectedHarnessId]);

  useEffect(() => {
    initializedSelection.current = false;
    // Drop the previous harness's selection so no id leaks across a task switch.
    setSelection(null);
  }, [selectedHarnessId]);

  useEffect(() => {
    if (!snapshot || initializedSelection.current) return;
    initializedSelection.current = true;
    const requested = new URLSearchParams(window.location.search).get("select");
    setSelection(requested ? resolveSelection(snapshot, requested) : null);
  }, [snapshot]);

  function chooseHarness(registrationId: string) {
    setForceOverview(false);
    setSelectedHarnessId(registrationId);
    const url = new URL(window.location.href);
    url.searchParams.set("harness", registrationId);
    url.searchParams.delete("select");
    url.searchParams.delete("view");
    window.history.replaceState({}, "", url);
  }

  function showRegistry() {
    setForceOverview(true);
    setSelectedHarnessId(null);
    const url = new URL(window.location.href);
    url.searchParams.delete("harness");
    url.searchParams.delete("select");
    url.searchParams.delete("view");
    window.history.replaceState({}, "", url);
  }

  if (!registryState.registry && registryState.error) return <ErrorShell message={registryState.error} onRetry={() => void registryState.refresh()} />;
  if (!registryState.registry) return <LoadingShell />;
  if (!selectedHarnessId) {
    return <HarnessRegistry registry={registryState.registry} connection={registryState.connection} error={registryState.error} lastReceivedAt={registryState.lastReceivedAt} theme={theme} onRefresh={() => void registryState.refresh()} onSelect={chooseHarness} onToggleTheme={() => setTheme((value) => value === "dark" ? "light" : "dark")} />;
  }
  if (!snapshot && error) return <ErrorShell message={error} onRetry={() => void refresh()} />;
  if (!snapshot) return <LoadingShell />;

  const connectionLabel = connection === "polling" ? "轮询同步中" : connection === "live" ? "实时已绑定" : connection === "reconnecting" ? "正在重连" : connection === "offline" ? "离线" : "连接中";
  // Keep the overview free of a selection until a click or explicit deep link.
  const activeSelection = selection;

  function select(next: JourneySelection) {
    if (!(document.activeElement as HTMLElement)?.closest(".inspector")) drawerOpener.current = document.activeElement as HTMLElement;
    setSelection(next);
    const url = new URL(window.location.href);
    url.searchParams.delete("view");
    url.searchParams.set("select", next.id);
    window.history.replaceState({}, "", url);
  }

  function closeInspector() {
    setSelection(null);
    const url = new URL(window.location.href);
    url.searchParams.delete("select");
    window.history.replaceState({}, "", url);
    drawerOpener.current?.focus({ preventScroll: true });
  }

  return (
    <div className="app-shell graph-app" data-testid="workflow-console">
      <header className="topbar">
        <button aria-label="返回 Harness 注册中心" className="brand-block brand-button" onClick={showRegistry} type="button"><span className="brand-mark"><GitBranch size={19} weight="bold" /></span><div><strong>OCW Harness</strong><span>{snapshot.task.id} · {snapshot.runtime.sessionId}</span></div></button>
        <div className="binding-state" data-state={connection} data-testid="connection-status"><Broadcast size={15} weight="fill" /><strong>{connectionLabel}</strong></div>
        <div className="header-actions"><a className="demo-return" href={`?demo=paths&harness=${encodeURIComponent(selectedHarnessId)}`}>演示</a><select aria-label="切换 Harness" className="harness-select" onChange={(event) => chooseHarness(event.target.value)} value={selectedHarnessId}>{registryState.registry.registrations.map((item) => <option key={item.registrationId} value={item.registrationId}>{item.label} · {item.sessionId}</option>)}</select><button aria-label="刷新快照" className="icon-button" onClick={() => void refresh()} type="button"><ArrowClockwise size={17} /></button><button aria-label={theme === "dark" ? "切换浅色主题" : "切换深色主题"} className="icon-button" onClick={() => setTheme((value) => value === "dark" ? "light" : "dark")} type="button">{theme === "dark" ? <Sun size={17} /> : <Moon size={17} />}</button></div>
      </header>
      {(error || !["live", "polling"].includes(connection)) && <div className="connection-banner" role="status"><WarningCircle size={15} weight="fill" /> {error || "实时通道暂时不可用，正在自动重连。"}</div>}
      {snapshot.sourceStatus !== "ready" && <div className="connection-banner" role="status">保留上次已验证状态 · {snapshot.sourceError}</div>}
      {snapshot.persistenceError && <div className="connection-banner" role="status">快照备份暂不可写 · {snapshot.persistenceError}</div>}
      {snapshot.execution?.restoreHold && <div className="connection-banner" role="status">备份已恢复，执行保持暂停，等待核对交付和运行路径。</div>}
      {snapshot.execution?.backup?.status === "failed" && <div className="connection-banner" role="status">备份未完成，需要处理。请展开运行信息查看。</div>}
      <details className="runtime-details"><summary>运行信息<span>{formatTime(lastReceivedAt || snapshot.generatedAt)} 更新 · REV {snapshot.task.revision}</span></summary><div className="runtime-details-content">
        {snapshot.execution?.backup && <div className="runtime-observation" role="status" data-testid="backup-status">备份：{({ running: '进行中', complete: '已完成并校验', failed: '未完成，需要处理', restored: '已从校验过的归档恢复' } as Record<string, string>)[snapshot.execution.backup.status] || snapshot.execution.backup.status}{snapshot.execution.backup.error && <span title={snapshot.execution.backup.error}> · 请检查备份目的地和运行日志</span>}</div>}
      {snapshot.execution && <div className="runtime-observation" role="status" data-testid="executor-recovery">执行检查点：{snapshot.execution.accepted}/{snapshot.execution.total} · 中断记录：{snapshot.execution.interruptedAttempts} · 待对账操作：{snapshot.execution.unknownOperations} · 恢复代次：{snapshot.execution.dataEpoch}</div>}
      <div className="runtime-observation" role="status">运行时：{({ live: "在线", lost: "失联", suspect: "心跳延迟", unknown: "存活未确认", closed: "Session 已关闭" } as Record<string, string>)[snapshot.runtime.liveness]} · 数据验证：{formatTime(snapshot.verifiedAt)} · 业务进展：{formatTime(snapshot.task.updatedAt)}{snapshot.agentActivity.unverifiedAssignmentCount > 0 ? ` · ${snapshot.agentActivity.unverifiedAssignmentCount} 项执行记录待确认存活` : ""}</div>
        <div className="runtime-observation">数据源：{snapshot.sourceRoot} · 连接：{snapshot.runtime.bindingId}</div>
      </div></details>
      <StageStrip
        executionProgress={snapshot.execution ? Math.round(snapshot.execution.accepted * 100 / Math.max(1, snapshot.execution.total)) : undefined}
        checkpoints={snapshot.journey.layers.flatMap((layer) => layer.nodes.flatMap((node) => node.checkpoints)).length}
        lastRefresh={lastReceivedAt || snapshot.generatedAt}
        paths={snapshot.journey.transitions.flatMap((transition) => transition.edges.flatMap((edge) => edge.paths)).length}
        phases={snapshot.phases}
        workingAssignments={snapshot.agentActivity.assignments.filter((a) => a.working)}
        workingCount={snapshot.agentActivity.workingCount}
      />
      <main className="workspace">
        <OrthogonalJourney
          key={selectedHarnessId}
          agentActivity={snapshot.agentActivity}
          journey={snapshot.journey}
          onSelect={select}
          selection={activeSelection}
        />
        {activeSelection && <JourneyInspector key={`${selectedHarnessId}:${activeSelection.kind}:${activeSelection.id}`} onClose={closeInspector} onSelect={select} selection={activeSelection} snapshot={snapshot} />}
      </main>
    </div>
  );
}
