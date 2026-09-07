import { useEffect, useMemo, useRef, useState } from "react";
import { createDemoSnapshot, demoSteps } from "../demo";
import type { JourneySelection } from "../types";
import { OrthogonalJourney } from "./OrthogonalJourney";
import { JourneyInspector } from "./JourneyInspector";
import { StageStrip } from "./StageStrip";

export function HarnessDemo() {
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [selection, setSelection] = useState<JourneySelection | null>(null);
  const [dark, setDark] = useState(() => localStorage.getItem("ocw-theme") === "dark");
  const opener = useRef<HTMLElement | null>(null);
  const snapshot = useMemo(() => createDemoSnapshot(step), [step]);
  useEffect(() => { document.title = "OCW · 路径与检查点演示"; }, []);
  useEffect(() => { document.documentElement.dataset.theme = dark ? "dark" : "light"; }, [dark]);
  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => setStep(value => (value + 1) % demoSteps.length), 5000);
    return () => window.clearInterval(timer);
  }, [playing]);
  const select = (next: JourneySelection) => {
    if (!(document.activeElement as HTMLElement)?.closest(".inspector")) opener.current = document.activeElement as HTMLElement;
    setSelection(next);
  };
  const returnUrl = new URL(window.location.href);
  returnUrl.searchParams.delete("demo");
  returnUrl.searchParams.delete("select");
  return <div className="app-shell graph-app demo-app" data-testid="workflow-console" data-playing={playing}>
    <header className="topbar demo-topbar"><div className="brand-block"><span className="demo-badge">DEMO</span><div><strong>并行任务 · 路径探索</strong><span>独立模拟案例，不代表真实任务进度</span></div></div><div className="header-actions"><button className="graph-expand-all" onClick={() => setDark(value => !value)} type="button">{dark ? "浅色" : "深色"}</button><a className="demo-return" href={returnUrl.pathname + returnUrl.search}>返回真实任务 →</a></div></header>
    <div className="demo-player" aria-label="演示播放器"><div className="demo-step" role="status"><span className="demo-play-state" data-playing={playing}>{playing ? "模拟播放中" : "已暂停"}</span><strong data-testid="demo-step">{String(step + 1).padStart(2, "0")} / {demoSteps.length}</strong><span>{demoSteps[step].title}</span></div><div className="demo-controls"><button onClick={() => setPlaying(value => !value)} type="button">{playing ? "暂停演示" : "继续播放"}</button><button onClick={() => { setPlaying(false); setStep(value => (value + 1) % demoSteps.length); }} type="button">单步</button><button onClick={() => { setStep(0); setPlaying(true); }} type="button">重播</button></div></div>
    <StageStrip executionProgress={Math.round(snapshot.metrics.checkpointsComplete / 9 * 100)} phases={snapshot.phases} checkpoints={9} paths={9} workingCount={snapshot.agentActivity.workingCount} workingAssignments={snapshot.agentActivity.assignments} lastRefresh={snapshot.generatedAt} />
    <main className="workspace"><OrthogonalJourney defaultPathsExpanded journey={snapshot.journey} agentActivity={snapshot.agentActivity} selection={selection} onSelect={select} />{selection && <JourneyInspector snapshot={snapshot} selection={selection} onSelect={select} onClose={() => { setSelection(null); opener.current?.focus({ preventScroll: true }); }} />}</main>
    <p className="demo-note">每 5 秒演示一个进展，循环播放。点连线看方案，点检查点看条件与状态；∧ 表示前置条件必须全部满足。绿色流动表示方案已采用。</p>
  </div>;
}
