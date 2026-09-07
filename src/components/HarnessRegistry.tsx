import { ArrowClockwise } from "@phosphor-icons/react/ArrowClockwise";
import { ArrowRight } from "@phosphor-icons/react/ArrowRight";
import { Broadcast } from "@phosphor-icons/react/Broadcast";
import { CheckCircle } from "@phosphor-icons/react/CheckCircle";
import { GitBranch } from "@phosphor-icons/react/GitBranch";
import { Moon } from "@phosphor-icons/react/Moon";
import { Stack } from "@phosphor-icons/react/Stack";
import { Sun } from "@phosphor-icons/react/Sun";
import { UserCircle } from "@phosphor-icons/react/UserCircle";
import { UsersThree } from "@phosphor-icons/react/UsersThree";
import { WarningCircle } from "@phosphor-icons/react/WarningCircle";
import { useState } from "react";
import { formatTime, phaseName } from "../format";
import type { ConnectionStatus, HarnessPresence, HarnessRegistrySnapshot } from "../types";

type Theme = "light" | "dark";
type FilterStatus = "all" | "working" | "active" | "complete" | "closed" | "unavailable" | "attention";

const presenceLabels: Record<HarnessPresence, string> = {
  failed: "任务失败",
  cancelled: "任务已取消",
  lost: "运行时失联",
  working: "代理工作中",
  active: "Session 在线",
  idle: "等待更新",
  complete: "任务完成",
  closed: "Session 已关闭",
  unavailable: "数据源不可用",
};

export function HarnessRegistry({
  registry,
  connection,
  error,
  lastReceivedAt,
  theme,
  onRefresh,
  onSelect,
  onToggleTheme,
}: {
  registry: HarnessRegistrySnapshot;
  connection: ConnectionStatus;
  error: string | null;
  lastReceivedAt: string | null;
  theme: Theme;
  onRefresh: () => void;
  onSelect: (registrationId: string) => void;
  onToggleTheme: () => void;
}) {
  const [filter, setFilter] = useState<FilterStatus>("all");

  const connectionLabel =
    connection === "polling" ? "轮询同步中" : connection === "live"
      ? "注册中心实时在线"
      : connection === "reconnecting"
      ? "正在重连"
      : connection === "offline"
      ? "离线"
      : "连接中";

  const counts = {
    attention: registry.registrations.filter(item => ["failed", "lost", "cancelled"].includes(item.presence)).length,
    all: registry.registrations.length,
    working: registry.registrations.filter((item) => item.presence === "working").length,
    active: registry.registrations.filter((item) => item.presence === "active" || item.presence === "idle").length,
    complete: registry.registrations.filter((item) => item.presence === "complete").length,
    closed: registry.registrations.filter((item) => item.presence === "closed").length,
    unavailable: registry.registrations.filter((item) => !item.available || item.presence === "unavailable").length,
  };

  const filteredRegistrations = registry.registrations.filter((item) => {
    if (filter === "attention") return ["failed", "lost", "cancelled"].includes(item.presence);
    if (filter === "all") return true;
    if (filter === "working") return item.presence === "working";
    if (filter === "active") return item.presence === "active" || item.presence === "idle";
    if (filter === "complete") return item.presence === "complete";
    if (filter === "closed") return item.presence === "closed";
    if (filter === "unavailable") return !item.available || item.presence === "unavailable";
    return true;
  });

  return (
    <div className="registry-shell" data-testid="harness-registry">
      <header className="topbar registry-topbar">
        <div className="brand-block">
          <span className="brand-mark"><Stack size={19} weight="bold" /></span>
          <div>
            <strong>OCW Harness 注册中心</strong>
            <span>多任务 · 多 Session · 只读控制台</span>
          </div>
        </div>
        <div className="binding-state" data-state={connection} data-testid="registry-connection">
          <Broadcast size={15} weight="fill" />
          <div>
            <strong>{connectionLabel}</strong>
            <span>{registry.runtime.bindingId} · {registry.runtime.connectedClients} clients</span>
          </div>
        </div>
        <div className="header-actions">
          <span className="header-time">每秒只读刷新 · {formatTime(lastReceivedAt || registry.generatedAt)}</span>
          <button aria-label="刷新注册中心" className="icon-button" onClick={onRefresh} type="button">
            <ArrowClockwise size={17} weight="bold" />
          </button>
          <button aria-label={theme === "dark" ? "切换浅色主题" : "切换深色主题"} className="icon-button" onClick={onToggleTheme} type="button">
            {theme === "dark" ? <Sun size={17} weight="bold" /> : <Moon size={17} weight="bold" />}
          </button>
        </div>
      </header>

      {(error || !["live", "polling"].includes(connection)) && (
        <div className="connection-banner" role="status">
          <WarningCircle size={15} weight="fill" /> {error || "注册中心实时通道暂时不可用，正在自动重连。"}
        </div>
      )}

      <section className="registry-summary" aria-label="Harness 总览统计">
        <div>
          <span>已注册总项</span>
          <strong>{registry.counts.registrations}</strong>
          <small>{registry.counts.tasks} 个独立任务 · {registry.counts.sessions} 个会话</small>
        </div>
        <div>
          <span>活动 Session</span>
          <strong>{registry.counts.active}</strong>
          <small>在线执行或具备活跃心跳</small>
        </div>
        <div data-working={registry.counts.workingAgents > 0}>
          <span>工作中的子代理</span>
          <strong>{registry.counts.workingAgents}</strong>
          <small>{registry.counts.workingAgents > 0 ? "正在并发推进检查点或路径" : "当前无已确认在线的执行代理"}</small>
        </div>
        <div>
          <span>只读刷新频率</span>
          <strong>1s</strong>
          <small>SSE 实时推送 + 1 秒轮询对账</small>
        </div>
      </section>

      <main className="registry-main">
        <header className="registry-heading">
          <div>
            <span className="eyebrow">HARNESS DIRECTORY</span>
            <h1>选择要观察的任务或 Session</h1>
            <p>每个 Harness 独立绑定一个 canonical 工作流数据源，支持同名 Session 隔离。点击卡片进入任务拓扑与路径控制台。</p>
          </div>
          <div className="registry-cadence">
            <span />
            <strong>READ ONLY</strong>
            <small>1 秒轮询同步</small>
          </div>
        </header>

        <nav className="registry-filters" aria-label="状态筛选">
          <button
            className="filter-pill"
            data-active={filter === "all"}
            onClick={() => setFilter("all")}
            type="button"
          >
            全部 <span>{counts.all}</span>
          </button>
          <button
            className="filter-pill"
            data-active={filter === "working"}
            onClick={() => setFilter("working")}
            type="button"
          >
            工作中 <span>{counts.working}</span>
          </button>
          <button
            className="filter-pill"
            data-active={filter === "active"}
            onClick={() => setFilter("active")}
            type="button"
          >
            在线 <span>{counts.active}</span>
          </button>
          <button
            className="filter-pill"
            data-active={filter === "complete"}
            onClick={() => setFilter("complete")}
            type="button"
          >
            已完成 <span>{counts.complete}</span>
          </button>
          {counts.attention > 0 && <button className="filter-pill error" data-active={filter === "attention"} onClick={() => setFilter("attention")} type="button">需关注 <span>{counts.attention}</span></button>}
          {counts.closed > 0 && (
            <button
              className="filter-pill"
              data-active={filter === "closed"}
              onClick={() => setFilter("closed")}
              type="button"
            >
              已关闭 <span>{counts.closed}</span>
            </button>
          )}
          {counts.unavailable > 0 && (
            <button
              className="filter-pill error"
              data-active={filter === "unavailable"}
              onClick={() => setFilter("unavailable")}
              type="button"
            >
              数据源异常 <span>{counts.unavailable}</span>
            </button>
          )}
        </nav>

        {registry.registrations.length === 0 ? (
          <section className="registry-empty" data-testid="registry-empty">
            <GitBranch size={32} />
            <h2>尚无已注册的 Harness 任务</h2>
            <p>
              新任务在初始化或运行中注册后，会自动出现在本控制台。<br />
              控制台遵循最小侵入契约：只通过显式注册发现任务，不会在整台机器扫描或写入 canonical 工作流文件。
            </p>
          </section>
        ) : filteredRegistrations.length === 0 ? (
          <section className="registry-empty" data-testid="registry-filter-empty">
            <Stack size={32} />
            <h2>当前筛选下无匹配的 Harness</h2>
            <p>没有处于该状态的任务或 Session。您可以切换其他筛选标签，或重置为查看全部。</p>
            <button className="retry-button" onClick={() => setFilter("all")} type="button">
              查看全部 ({counts.all})
            </button>
          </section>
        ) : (
          <section className="harness-grid" aria-label="已注册 Harness">
            {filteredRegistrations.map((item) => (
              <button
                className="harness-card"
                data-presence={item.presence}
                data-testid="harness-card"
                key={item.registrationId}
                onClick={() => onSelect(item.registrationId)}
                type="button"
              >
                <span className="harness-card-accent" />
                <div className="harness-card-top">
                  <span className="presence-badge">
                    <i />
                    {presenceLabels[item.presence]}
                  </span>
                  <div className="harness-top-right">
                    <span className="harness-progress">{item.progress}%</span>
                  </div>
                </div>

                <div className="harness-title">
                  <div>
                    <div className="harness-id-row">
                      <span className="harness-task-tag">{item.taskId}</span>
                      <span className="harness-session-tag"><UsersThree size={11} /> {item.sessionId}</span>
                    </div>
                    <h2>{item.label}</h2>
                  </div>
                  <ArrowRight className="harness-arrow" size={20} weight="bold" />
                </div>

                <p className="harness-objective">{item.objective}</p>

                {item.workingAssignments.length > 0 ? (
                  <div className="harness-workers" aria-label={`${item.taskId} 正在工作的代理`}>
                    <div className="workers-heading">
                      <UserCircle size={13} weight="fill" />
                      <span>正在执行的子代理 ({item.workingAssignments.length})</span>
                    </div>
                    <div className="workers-list">
                      {item.workingAssignments.map((assignment) => {
                        const targetType = assignment.pathIds[0]
                          ? "路径"
                          : assignment.checkpointIds[0]
                          ? "检查点"
                          : "任务边";
                        const targetId =
                          assignment.pathIds[0] || assignment.checkpointIds[0] || assignment.edgeId;
                        return (
                          <span className="worker-item" key={assignment.assignmentId}>
                            <i />
                            <strong>{assignment.displayName}</strong>
                            <small>{targetType} · {targetId}</small>
                          </span>
                        );
                      })}
                    </div>
                  </div>
                ) : (
                  <div className="harness-no-workers">
                    <CheckCircle size={13} weight="fill" />
                    <span>无活跃子代理 · 全流程待命或已验收完成</span>
                  </div>
                )}

                <div className="mini-stage-strip" aria-label={`${item.taskId} R1 至 R5 阶段进度`}>
                  {item.phases.map((phase) => (
                    <span
                      data-status={phase.status}
                      key={phase.id}
                      title={`${phase.title} (${phase.progress}%)`}
                    >
                      <strong>{phase.id}</strong>
                      <i style={{ width: `${phase.progress}%` }} />
                      <small>{phase.progress}%</small>
                    </span>
                  ))}
                </div>

                <small className="runtime-observation">{item.ownership === "task_shared" ? "代理为任务共享归属" : "代理按 Session 归属"} · {item.unverifiedAssignments > 0 ? `${item.unverifiedAssignments} 项执行记录待确认存活` : "执行记录已核对"}</small>
                {item.backupStatus && <small className="runtime-observation">备份：{({ running: '进行中', complete: '已完成并校验', failed: '未完成，需要处理', restored: '已恢复' } as Record<string, string>)[item.backupStatus] || item.backupStatus}</small>}
                {item.error && (
                  <div className="harness-error">
                    <WarningCircle size={14} weight="fill" /> {item.error}
                  </div>
                )}

                <dl className="harness-meta">
                  <div>
                    <dt>阶段 / 版本</dt>
                    <dd>{phaseName(item.phase)} · REV {item.revision}</dd>
                  </div>
                  <div>
                    <dt>检查点推进</dt>
                    <dd>{item.checkpointsComplete} / {item.checkpointsTotal} 完成</dd>
                  </div>
                  <div>
                    <dt>工作代理</dt>
                    <dd>{item.workingAgents > 0 ? `${item.workingAgents} 位工作中` : "0 人待命中"}</dd>
                  </div>
                  <div>
                    <dt>最近心跳</dt>
                    <dd>{item.lastActivityAt ? formatTime(item.lastActivityAt, true) : "未知"}</dd>
                  </div>
                </dl>

                <div className="harness-card-foot">
                  <span title={item.sourceRoot}>{item.sourceRoot}</span>
                  <time dateTime={item.lastActivityAt || ""}>
                    {item.lastActivityAt ? formatTime(item.lastActivityAt) : ""}
                  </time>
                </div>
              </button>
            ))}
          </section>
        )}
      </main>
    </div>
  );
}
