import type { WorkflowEvent, WorkflowStatus } from "./types";

const phaseNames: Record<string, string> = {
  decomposing: "拆解中",
  decomposition_ready: "拆解就绪",
  exploring: "探索中",
  exploration_complete: "探索完成",
  coordinating: "路线协调",
  awaiting_user_decision: "等待用户选择",
  implementing: "实现中",
  verifying: "实现验证",
  rework_required: "需要返工",
  auditing: "独立终审",
  complete: "全部完成",
  completed: "全部完成",
  failed: "执行失败",
  cancelled: "已取消",
  recovery_required: "恢复待核对",
  blocked: "已阻塞",
};

const eventLabels: Array<[RegExp, string]> = [
  [/^lease_expired$/, "执行租约过期，保留中断记录"],
  [/^claimed$/, "检查点已由执行者领取"],
  [/^checkpoint_accepted$/, "检查点验收通过"],
  [/^operation_outcome_unknown$/, "交付结果不明，等待核对"],
  [/^operation_reconciled$/, "交付结果已核对"],
  [/^backup_restored$/, "备份已恢复，执行保持暂停"],
  [/^restore_activated$/, "恢复核对完成，可以继续执行"],
  [/R5_independent_semantic_and_mechanical_pass/, "R5 双路终审通过，工作流完成"],
  [/authorized_delivery_mirror_created/, "交付镜像生成，进入 R5 终审"],
  [/candidate_05_independent_semantic_and_mechanical_acceptance/, "Candidate 05 通过 R4 双审"],
  [/candidate_05_frozen/, "Candidate 05 冻结并提交复审"],
  [/candidate_04_conflicting_semantic_reviews/, "Candidate 04 发现冲突，按失败收口"],
  [/candidate_04_frozen/, "Candidate 04 冻结并提交复审"],
  [/candidate_03_independent_semantic_audit_failed/, "Candidate 03 语义审计失败"],
  [/candidate_03_resubmitted/, "Candidate 03 完成有界修正"],
  [/candidate_02.*failed|candidate_02.*rework/, "Candidate 02 审计失败并返工"],
  [/candidate_01.*failed|candidate_01.*rework/, "Candidate 01 审计失败并返工"],
  [/user.*selected|route.*selected|decision.*selected/i, "用户选择路线 2"],
  [/accepted_after|accepted_by|interface.*accepted/i, "公共接口通过 reducer 验收"],
  [/rejected|failed|violation/i, "检查失败，保留证据并返工"],
  [/exploration.*complete/i, "路径探索完成"],
  [/dispatch|assignment/i, "任务胶囊已分发"],
  [/decomposition|initialized/i, "工作流已初始化"],
];

export function phaseName(phase: string) {
  return phaseNames[phase] || phase.replaceAll("_", " ");
}

export function statusLabel(status: WorkflowStatus) {
  return {
    complete: "已完成",
    active: "运行中",
    pending: "等待中",
    attention: "需处理",
  }[status];
}

export function eventLabel(event: WorkflowEvent) {
  const match = eventLabels.find(([pattern]) => pattern.test(event.type));
  if (match) return match[1];
  return event.type.replaceAll("_", " ");
}

export function formatTime(value: string, includeDate = false) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未知";
  return new Intl.DateTimeFormat("zh-CN", {
    month: includeDate ? "2-digit" : undefined,
    day: includeDate ? "2-digit" : undefined,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

export function shortDigest(value: string | null) {
  if (!value) return "未提供";
  return `${value.slice(0, 8)}...${value.slice(-6)}`;
}
