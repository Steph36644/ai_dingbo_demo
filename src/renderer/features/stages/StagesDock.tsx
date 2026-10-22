import type { FrameworkStage } from "@shared/contracts/framework";

export function StagesDock({
  stages,
  currentStageId,
  running,
  onSetStage,
}: {
  stages: FrameworkStage[];
  currentStageId: string | null;
  running: boolean;
  onSetStage: (stageId: string) => void;
}) {
  if (stages.length === 0) {
    return <p className="guidance">当前框架没有 stages，大屏显示「直播中」。</p>;
  }
  return (
    <ol className="stage-list">
      {stages.map((stage, index) => {
        const current = stage.id === currentStageId;
        return (
          <li key={stage.id} className={current ? "stage-row current" : "stage-row"}>
            <span className="stage-index">{index + 1}</span>
            <div className="stage-row-main">
              <strong>{stage.name}</strong>
              <small>{current ? "当前阶段" : running ? "切换到大屏" : "未开始也可预选"}</small>
            </div>
            <button type="button" className="ghost" disabled={current} onClick={() => onSetStage(stage.id)}>
              {current ? "已在大屏" : "切换"}
            </button>
          </li>
        );
      })}
    </ol>
  );
}
