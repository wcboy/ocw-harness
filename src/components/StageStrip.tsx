import { CaretDown } from "@phosphor-icons/react/CaretDown";
import { Lightning } from "@phosphor-icons/react/Lightning";
import { useState } from "react";
import { statusLabel } from "../format";
import type { AgentBinding, WorkflowPhase } from "../types";
import { StatusIcon } from "./StatusIcon";

export function StageStrip({ phases, checkpoints, paths, workingCount, workingAssignments = [], executionProgress }: {
  phases: WorkflowPhase[]; checkpoints: number; paths: number; workingCount: number; workingAssignments?: AgentBinding[]; lastRefresh: string; executionProgress?: number;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const overall = executionProgress ?? Math.round(phases.reduce((sum, phase) => sum + phase.progress, 0) / Math.max(1, phases.length));
  const detail = phases.find(phase => phase.id === expanded);
  return <section className="progress-board compact-progress" aria-label="整体进度" data-testid="progress-board">
    <div className="progress-line"><div className="progress-total"><strong>{overall}%</strong><span>整体进度<small>{checkpoints} 个检查点 · {paths} 条路径</small></span></div>
      <nav className="compact-stages" aria-label="R1 到 R5 阶段">{phases.map(phase => <button key={phase.id} data-status={phase.status} data-active={expanded === phase.id} aria-expanded={expanded === phase.id} onClick={() => setExpanded(expanded === phase.id ? null : phase.id)} type="button"><StatusIcon size={14} status={phase.status} /><span>{phase.id}</span><strong>{phase.title}</strong>{phase.gateStatus === "not_applicable" && <small>未启用</small>}<CaretDown size={11} /></button>)}</nav>
      <div className="working-summary compact-workers" data-working={workingCount > 0} data-testid="working-summary"><Lightning size={15} weight="fill" /><strong>{workingCount}</strong><span>代理工作中</span>{workingAssignments.length > 0 && <small title={workingAssignments.map(worker => worker.displayName).join("、")}>{workingAssignments[0].displayName}{workingAssignments.length > 1 ? ` +${workingAssignments.length - 1}` : ""}</small>}</div>
    </div>
    {detail && <div className="phase-disclosure" role="region" aria-label={`${detail.id} 阶段详情`}><strong>{detail.title} · {detail.gateStatus === "not_applicable" ? "未启用" : statusLabel(detail.status)}</strong><p>{detail.description}</p><span>{detail.owner} · {detail.gate} · {detail.progress}%</span></div>}
  </section>;
}
