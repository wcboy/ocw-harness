import { UserCircle } from "@phosphor-icons/react/UserCircle";
import type { AgentBinding } from "../types";

function stateLabel(worker: AgentBinding | null) {
  if (!worker) return "未分配代理";
  if (worker.workState === "unknown") return "上次执行中 · 存活未确认";
  if (worker.working) return "正在执行任务";
  if (worker.workState === "complete") return "当前无人工作 (已验收)";
  if (worker.workState === "attention") return "需人工接手";
  return "待命中";
}

export function AgentBadge({ worker }: { worker: AgentBinding | null | undefined }) {
  const resolved = worker || null;
  return (
    <section className="agent-assignment" data-state={resolved?.workState || "queued"} data-testid="agent-assignment">
      <span className="agent-avatar"><UserCircle size={20} weight="duotone" /><i /></span>
      <div>
        <span>{stateLabel(resolved)}</span>
        <strong>{resolved?.displayName || "未分配子代理"}</strong>
        <small>{resolved ? `${resolved.role} · ${resolved.assignmentId}` : "尚无 assignment"}</small>
      </div>
    </section>
  );
}
