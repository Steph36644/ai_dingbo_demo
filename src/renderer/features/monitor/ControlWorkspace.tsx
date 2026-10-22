import type { AsrHealth, AsrId } from "@shared/contracts/asr";
import type { AudioSourceId, DeviceListResult } from "@shared/contracts/audio";
import type { DisplayInfo } from "@shared/contracts/display";
import type { FrameworkLoadResult } from "@shared/contracts/framework";
import type { AnalysisDigest, CoverageItem, Issue } from "@shared/contracts/issue";
import type { DemoScriptId, SessionSnapshot } from "@shared/contracts/session";
import type { PunctuationOverlay, TranscriptSegment } from "@shared/contracts/transcript";
import { Dock } from "../../app/shell/Dock";
import { LiveActions } from "../actions/LiveActions";
import { CoveragePanel } from "../coverage/CoveragePanel";
import { IssuesPanel } from "../issues/IssuesPanel";
import { LiveNotesPanel } from "../notes/LiveNotesPanel";
import { ProductNote } from "../productNote/ProductNote";
import {
  AsrSection,
  AudioSourceSection,
  FrameworkSection,
  WatchControlSection,
} from "../sources/SourcesDock";
import { StageOutputDock } from "../stage/StageOutputDock";
import { StagesDock } from "../stages/StagesDock";
import { CaptionMonitor } from "../monitor/CaptionMonitor";

type ControlWorkspaceProps = {
  devices: DeviceListResult | null;
  session: SessionSnapshot | null;
  framework: FrameworkLoadResult | null;
  finals: TranscriptSegment[];
  partial: TranscriptSegment | null;
  presentation: PunctuationOverlay | null;
  rms: number;
  clockMs: number;
  source: AudioSourceId;
  asrId: AsrId;
  demoScript: DemoScriptId;
  streamUrl: string;
  streamUrlError: string | null;
  streamWindowVisible: boolean;
  streamWindowReady: boolean;
  busy: boolean;
  localError: string | null;
  issues: Issue[];
  unreadCount: number;
  coverage: CoverageItem[];
  qualityWarning: string | null;
  lastAnalysis: AnalysisDigest | null;
  asrHealth: AsrHealth | null;
  healthChecking: boolean;
  startBlockReason: string | null;
  startDisabled: boolean;
  productNote: string;
  noteDisabled: boolean;
  pinnedIssueId: string | null;
  issueRuleProfileName: string | null;
  stageDisplays: DisplayInfo[];
  selectedDisplayId: number | null;
  stageMode: "window" | "fullscreen";
  stageMessage: string | null;
  currentStageId: string | null;
  onSource: (source: AudioSourceId) => void;
  onStreamUrl: (value: string) => void;
  onToggleStreamWindow: () => void;
  onAsr: (id: AsrId) => void;
  onDemoScript: (id: DemoScriptId) => void;
  onSelectFramework: () => void;
  onCheckHealth: () => void;
  onStart: () => void;
  onStop: () => void;
  onMarkRead: (id: string) => void;
  onMarkAllRead: () => void;
  onPinIssue: (issueId: string) => void;
  onUnpinIssue: () => void;
  onDismissIssue: (issueId: string) => void;
  onOpenIssueRules: () => void;
  onSetStage: (stageId: string) => void;
  onProductNote: (value: string) => void;
  onSelectDisplay: (id: number) => void;
  onSelectStageMode: (mode: "window" | "fullscreen") => void;
  onOpenStage: () => void;
  onCloseStage: () => void;
  onRefreshDisplays: () => void;
};

export function ControlWorkspace(props: ControlWorkspaceProps) {
  const state = props.session?.state ?? "idle";
  const locked = state === "preparing" || state === "running" || state === "degraded" || state === "stopping";
  const stages = props.framework?.ok ? props.framework.document.stages : undefined;
  const currentStageId = props.currentStageId;

  return (
    <div className="control-grid">
      <div className="dock-column">
        <Dock id="sources-framework" title="话术框架" workspace="monitor">
          <FrameworkSection framework={props.framework} locked={locked} onSelectFramework={props.onSelectFramework} />
        </Dock>
        <Dock id="sources-audio" title="音频来源" workspace="monitor">
          <AudioSourceSection
            devices={props.devices}
            source={props.source}
            locked={locked}
            streamUrl={props.streamUrl}
            streamUrlError={props.streamUrlError}
            streamWindowVisible={props.streamWindowVisible}
            streamWindowReady={props.streamWindowReady}
            onSource={props.onSource}
            onStreamUrl={props.onStreamUrl}
            onToggleStreamWindow={props.onToggleStreamWindow}
          />
        </Dock>
        <Dock id="sources-asr" title="识别与预检" workspace="monitor">
          <AsrSection
            asrId={props.asrId}
            demoScript={props.demoScript}
            source={props.source}
            locked={locked}
            asrHealth={props.asrHealth}
            healthChecking={props.healthChecking}
            onAsr={props.onAsr}
            onDemoScript={props.onDemoScript}
            onCheckHealth={props.onCheckHealth}
          />
        </Dock>
        <Dock id="sources-control" title="盯播控制" workspace="monitor">
          <WatchControlSection
            session={props.session}
            rms={props.rms}
            busy={props.busy}
            startBlockReason={props.startBlockReason}
            startDisabled={props.startDisabled}
            onStart={props.onStart}
            onStop={props.onStop}
          />
        </Dock>
        <Dock id="stages" title="阶段" workspace="monitor">
          <StagesDock
            stages={stages ?? []}
            currentStageId={currentStageId}
            running={state === "running"}
            onSetStage={props.onSetStage}
          />
        </Dock>

        <Dock id="issues" title="问题时间轴" workspace="monitor" actions={<span className="dock-count">{props.unreadCount}</span>}>
          <IssuesPanel
            issues={props.issues}
            unreadCount={props.unreadCount}
            qualityWarning={props.qualityWarning}
            lastAnalysis={props.lastAnalysis}
            pinnedIssueId={props.pinnedIssueId}
            onMarkRead={props.onMarkRead}
            onMarkAllRead={props.onMarkAllRead}
            onPinIssue={props.onPinIssue}
            onUnpinIssue={props.onUnpinIssue}
            onDismissIssue={props.onDismissIssue}
            issueRuleProfileName={props.issueRuleProfileName}
            onOpenRules={props.onOpenIssueRules}
          />
        </Dock>
      </div>

      <div className="monitor-column">
        <CaptionMonitor
          session={props.session}
          finals={props.finals}
          partial={props.partial}
          presentation={props.presentation}
          clockMs={props.clockMs}
          localError={props.localError}
          framework={props.framework}
          startBlockReason={props.startBlockReason}
        />
        <Dock id="coverage" title="讲点覆盖" workspace="monitor">
          <CoveragePanel items={props.coverage} framework={props.framework} />
        </Dock>
      </div>

      <div className="dock-column right">
        <Dock id="stage-output" title="抬头屏" workspace="monitor">
          <StageOutputDock
            displays={props.stageDisplays}
            selectedDisplayId={props.selectedDisplayId}
            mode={props.stageMode}
            message={props.stageMessage}
            running={locked}
            onSelectDisplay={props.onSelectDisplay}
            onSelectMode={props.onSelectStageMode}
            onOpen={props.onOpenStage}
            onClose={props.onCloseStage}
            onRefresh={props.onRefreshDisplays}
          />
        </Dock>

        <Dock id="product-note" title="本场备注" workspace="monitor">
          <ProductNote value={props.productNote} disabled={props.noteDisabled} onChange={props.onProductNote} />
        </Dock>

        <Dock id="actions" title="动作提醒" workspace="monitor">
          <LiveActions session={props.session} />
        </Dock>

        <Dock id="notes" title="现场笔记" workspace="monitor">
          <LiveNotesPanel clockMs={props.clockMs} latestSegment={latestNoteSegment(props.finals, props.partial)} />
        </Dock>
      </div>
    </div>
  );
}

function latestNoteSegment(finals: TranscriptSegment[], partial: TranscriptSegment | null): TranscriptSegment | null {
  return partial ?? finals[finals.length - 1] ?? null;
}
