import { useState } from "react";
import type { DisplayInfo, StageOpenMode } from "@shared/contracts/display";
import { ConfirmDialog } from "../../app/shell/ConfirmDialog";

export function StageOutputDock({
  displays,
  selectedDisplayId,
  mode,
  message,
  running,
  onSelectDisplay,
  onSelectMode,
  onOpen,
  onClose,
  onRefresh,
}: {
  displays: DisplayInfo[];
  selectedDisplayId: number | null;
  mode: StageOpenMode;
  message: string | null;
  running: boolean;
  onSelectDisplay: (id: number) => void;
  onSelectMode: (mode: StageOpenMode) => void;
  onOpen: () => void;
  onClose: () => void;
  onRefresh: () => void;
}) {
  const [confirm, setConfirm] = useState(false);
  const [open, setOpen] = useState(false);

  function requestOpen() {
    if (running) {
      setConfirm(true);
      return;
    }
    onOpen();
  }

  return (
    <div className="stage-output">
      <label className="field">
        显示器
        <select value={selectedDisplayId ?? ""} onChange={(event) => onSelectDisplay(Number(event.target.value))}>
          {displays.length === 0 ? <option value="">没有可用显示器</option> : null}
          {displays.map((display) => (
            <option key={display.id} value={display.id}>
              {display.internal ? "主屏" : "副屏"} · {display.bounds.width}×{display.bounds.height}
              {display.scaleFactor !== 1 ? ` · ${Math.round(display.scaleFactor * 100)}%` : ""}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        模式
        <select value={mode} onChange={(event) => onSelectMode(event.target.value as StageOpenMode)}>
          <option value="window">窗口（带排练角标）</option>
          <option value="fullscreen">全屏（无边框）</option>
        </select>
      </label>
      <div className="inline-actions">
        <button type="button" className="primary" onClick={requestOpen} disabled={selectedDisplayId == null}>
          打开抬头屏
        </button>
        <button type="button" className="ghost" onClick={onClose}>
          关闭
        </button>
        <button type="button" className="ghost" onClick={onRefresh} title="重新读取显示器">
          刷新
        </button>
      </div>
      <p className="guidance">大屏只显示：阶段 · 建议 · 字幕 · 状态灯。</p>
      {message ? <p className="guidance bad-text">{message}</p> : null}
      <ConfirmDialog
        open={confirm}
        title="盯播中打开全屏抬头屏？"
        body={<p>抬头屏会覆盖所选显示器，鼠标焦点会短暂离开中控。盯播不会中断。</p>}
        confirmLabel="打开"
        onConfirm={() => {
          setConfirm(false);
          onOpen();
        }}
        onCancel={() => setConfirm(false)}
      />
      <button type="button" className="link-button disclosure" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className={open ? "chevron" : "chevron chevron-right"} aria-hidden="true" />
        {open ? "收起说明" : "显示 / 窗口说明"}
      </button>
      {open ? (
        <ul className="hint-list">
          <li>窗口模式带「排练」角标，适合彩排与试音。</li>
          <li>全屏模式无系统边框，按 Esc 关闭，盯播继续。</li>
          <li>拔掉副屏会关闭抬头屏并提示，中控不受影响。</li>
        </ul>
      ) : null}
    </div>
  );
}
