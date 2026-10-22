# Changelog

本文件记录 **PRD、SDD 与项目文档** 的显著变更（非代码发布说明）。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [Unreleased]

### Added

- 新增话术框架丰富版样例 `frameworks/example-framework.v0.1-rich.json`（`id` 为 `demo-sku-001-rich`，标题含「丰富版」）。与 v0 并存，不改 `frameworks/example-framework.v0.json`。顶层字段不变；`ms-1` / `ms-2` / `ms-3` 语义保留，阶段仍含 `warmup` / `pitch` / `close`，方便现有推流 / 发券提醒继续按这些 id 映射。启动仍只加载 v0；应用不扫描 `frameworks/*.json`，丰富版用现有文件对话框打开。
- 新增 **ADR-018 SenseVoice 旁路探针**（`docs/adr/ADR-018-sensevoice-bypass.md`）与测量清单（`docs/research/sensevoice-probe.md`）。旁路读同一路 PCM 的固定窗（主候选 4 秒窗 / 2 秒 hop），用 SenseVoiceSmall 同时出情绪和音频事件；失败静默；不进抬头屏，不驱动推流 / 发券。字幕 ASR 仍是 FunASR 或讯飞。探针未跑，延迟 / CPU / 丢窗率均为 `[TODO: 探针实测]`。未写 sidecar，未改产品代码。
- 新增**抖音直播流音源**（音源第三种：`stream`）。粘贴 `https://live.douyin.com/<房间号>` 即可直接听直播间声音，不再要求把直播声回环到本机。实现为隐藏直播窗 + preload 内 WebAudio 旁路（AudioWorklet，回退 `ScriptProcessor`），100ms 单声道 PCM 经 `audio:streamChunk` 回主进程，复用现有 `PcmFramer → ASR` 管线。首帧 30s 超时、6s 自动露出画面供登录 / 排查，`rearm` 等价重载。直播页用独立 `persist:ai-dingbo-stream` 分区，导航只放行 `*.douyin.com`，不暴露任何 bridge。同步更新 PRD FR-03、SDD ADR-017 / §7.1.1 / §11.1 / §15。多窗口同时盯两场只做可行性评估，不在本分支实现。
- 新增 `docs/design/visual-system.md` 与 `docs/design/visual-system.html`：视觉重构的设计依据（为什么对标 OBS、借什么不借什么、三条硬规矩、为何必须先 token 化、Control 三 dock 与 Stage 输出窗化的结构理由、R1–R6 落地顺序、视觉验收自检四问）与四张结构参考图。与 PRD 分工：PRD §4 为规格权威，设计文档管「为什么 + 怎么落地」。
- 按 PRD/SDD 写作技能做门禁补强（仍是 v1.0.0 Draft，未打 tag，不复制 `versions/`）：PRD §8.4 为 P0-1–P2 补可观察通过条件（暂无量化基线）；§8.5 写明不适用验收；§10.1–§10.4 补 `[Inferred]` / `[TODO]`、待完善分级（🔴 真环回表未回填、#23 未合、讯飞额度未证实）和 R1–R8 风险快扫。SDD §1.1 补模块边界：动作提醒依赖未合的 #23。
- PRD §9.1：交付顺序与阶段性重点。原版 Brief 六条为底线（流式 ASR、1 分钟/5 分钟可配窗口、语速/节奏/内容；音调标为缺口）；演示顺序 P0-1 → P0-2 → P1 → P2。M6.1 中控提醒依赖 PR #23（草稿，未合 main）。意图升级仍是 §12，后置。
- SDD §1.1：与 PRD 同口径的交付顺序 / 演示依赖（ASR 路径、双端投影、分析窗、M6.1 依赖、Mac/Win）。OBS / webhook / 闭麦仍后置。

### Changed

- README 改为当前产品口径：中控与抬头屏已在用，抖音直播流音源，FunASR 默认、讯飞可选，中控动作提醒，话术框架 v0 与丰富版 v0.1，SenseVoice 仅探针文档。文首补「怎么演示」。隐藏直播画面的按钮状态以 #42 为准；动作提醒出站到 OBS / webhook 仍后置。
- PRD §9.1 / §13 与 SDD §1.1：SenseVoice 由「不进本阶段」改为 **v1.x 旁路补充 / 探针中**。不进 v1.0.0 验收，不宣称已交付。仍是 Draft，不打 tag，不复制 `versions/`。
- 中控推流 / 发券：默认冷却改为 180 秒硬冷却。条件要先消失再成立，或者冷却结束后出现新的说法，才会再提醒；新说法不能提前打断冷却，同一种说法停在分析窗里也不会按冷却补弹。阶段可多选（示例为讲品或促单）。直接口播链接或发券即可提醒，价格只作加成。示例框架补了价格、卖点和促单关键词。不连接 OBS / webhook。保存后的规则仍从下次开始盯播生效。
- PRD §4 与头部补视觉设计文档入口（双向关联）；§4.4 Stage 布局调整：阶段大字与建议上移至画面上部约 1/3、字幕区改为独立底色容器（`--bg-1` 底 + 描边 + 6px 圆角）并水平居中、历史 1–3 行渐隐、字幕区固定高度内部上滚、排练标记从右下角移至顶栏健康点右侧；要素由四个改为五个。§8.1 第 5 条与 FR-15 同步。
- 【本次更新】裁定作废「不画信号控件、只留空位」。v1.0.0 要画中控推流 / 发券提醒（听懂转写，对得上意图，演示可用关键词兜底）。界面与交互属本版；触发逻辑可依赖未合的 PR #23；OBS / webhook 出站仍后置。未合则演示缺这层能力。改了 PRD A5、§3.3、§8.4、§9.1 P0-1、§10.4，SDD §1.1 / §22.2，以及 M5 验收清单里的空位检查。未打 tag，不复制 `versions/`。
- 讯飞 / FunASR 在 PRD §3.1、§9.1 与 SDD §1.1 标明为产品路径选择，不是框架锁定。角色校验的过时句保持已纠正（PR #22 已合）。
- PRD：G4 / FR-17 改为「代码已合 PR #22，本版验收复验」。G1–G3、G5–G9 仍待补齐，不写成已实现。
- SDD 工作稿改为 v1.0.0 Draft，对齐 PRD v1.0.0。改正「Stage 共用完整 preload、Main 未按角色校验」的过时句。不打 tag，不复制 `versions/`。
- `docs/prd/README.md`、`docs/sdd/README.md` 的「当前」改为 v1.0.0 Draft。

### PRD v1.0.0 方向稿（2026-10-20）
- `docs/prd/latest.md` 升版 v1.0.0 Draft：以 OBS 类工具设计逻辑重构视觉方案——设计 token 体系（全站唯一颜色/圆角/字号来源，废除硬编码色值与浅色纸卡岛）、Control 三 dock 中控台 + 顶栏工作区（盯播/回看/设置）+ 底部常驻状态栏、Stage 输出窗化（排练角标、加载失败短句）、toast / 模态确认替代一次性 banner、空态 CTA 化。
- 盘点 v0.3.0 全部需求完成度并写入 §3；计划闭合 G1–G3、G5–G9（品备注输入、断屏提示接线、排练标记、pin/dismiss 语义修正、显示器选择持久化、全屏去边框、Stage 加载失败提示、视觉层）。G4 的纠偏见上方 Changed。
- M6/M7 仍不实现，仅保留右 dock 信号区空位；引擎、规则、ASR、JSONL 格式不动。未打 tag，`versions/` 不变。
- 补记后续规划（§12）：意图识别升级 coverage，优先服务发券等动作信号；关键词继续当兜底 / 证据；M4 问题卡先不动。本版不排期、不实现，不阻塞视觉重构与 G1–G9。不升版号、不打 tag、不改 `versions/`。

### 文档同步（2026-10-20，v0.3.0 时期）
- README、PRD / SDD 工作稿与 M5 验收清单统一为：M1–M3 与 M4 代码项已落地，M5 双窗核心已实现，完整退出条件与实机验收未完成；M6/M7 未实现。
- 回写代码差异：Stage 共用完整 preload / Main IPC 无角色校验；显示器不持久化、全屏仍有边框；pin 仅作用于未读问题，dismiss 不解除 pin、无取消 pin 控件；异步加载错误提示、品备注输入、断屏提示订阅、排练标记和信号区占位待补。
- 更新项目描述与 M5 验证步骤；不改功能代码、不升版本、不修改 `versions/` 冻结快照、不打 tag。

> 下方条目是按开发阶段累计的变更历史，其中「未实现」「单窗」「不支持历史管理」描述的是当时状态；当前状态以本节、README 和 PRD / SDD 工作稿正文为准。

### Added
- 回看历次证据与本机场次目录：问题卡仍按指纹聚合；回看展开可见每次证据窗（时间范围、摘录、次数），主时间改为首次到末次出现，末次证据窗留在副行。盯播中的卡片同步改主时间。场次目录由主进程扫描 `sessions/*/session.jsonl`，界面只传 sessionId。「再盯一场」不删除已落盘文件。不做导出和云同步。不改 JSONL 写盘格式，不改规则内核。文档仍是未打 tag 的 v0.3.0 Draft，不升版本，不改 `versions/`
- M5 双端核心（同机 Control + Stage）已落地，尚未完成全部退出条件与验收：
  - `controlBrowserWindow` 由现有单窗演进，`stageBrowserWindow` 新开；同一渲染包用 `?surface=control|stage` 区分
  - 主进程 `SessionProjection` 派生 `StageView`：阶段、未读角标、至多一条建议、健康点；Stage 只读，不跑第二套规则
  - 阶段 / pin / dismiss 写权只在 Control，盯播中可点阶段；Stage 无输入框、无阶段按钮、无 pin / dismiss。品备注有 `stage:set` 与投影字段，Control 输入框仍未接线
  - 显式选屏后才打开 Stage；支持「窗口」与「全屏」；单屏为可拖动窗口，不全屏抢 Control 所在屏。窗口上的「排练 · 同一块屏」标记仍未实现
  - 断屏时 Stage 关闭、会话继续、不自动挪到主屏全屏。主进程会发送「抬头屏断开，盯播还在」，Control 渲染层尚未订阅
  - 按角色关窗：关 Stage 或 Esc 不停会话；Control 停止盯播或确认关闭后拆 Stage；不留孤儿 Stage
  - 空错态短句：未开播 / 转写不稳定 / 会话错误 / 抬头屏打开失败，均无堆栈和密钥。断屏短句尚未显示在 Control
  - Control 固定显示「内容盯播，不是 GMV 总控。」M6 信号空位尚未画出，不造假信号
  - 新增 IPC：`stage:open` / `stage:close` / `stage:push` / `stage:get-state` / `stage:display-list` / `stage:set`
  - 新增测试：`tests/unit/projection.test.ts`、`tests/unit/ipcStage.test.ts`；新增人工验收清单 `docs/acceptance/m5-manual-acceptance.md`
- 展示层密讲软切：无句末标点、相邻 final 间隔也不足 800ms 时，累计约 48 个 Unicode 码点，或一句 `endMs - startMs` 达到约 6000ms，就另起一行。已经接近字数上限且以 `，` / `、` 结尾时提前收束。只改 `presentCaptions` 的字幕分行（Monitor 与 JSONL 回看），不改 ASR 协议、JSONL、规则引擎或已落盘 final。不升版本，不改 `versions/` 冻结快照
- 展示层周期性标点：FunASR 流式 final 常无句号。主进程默认每 4 秒或每 6 条新 final，把尚未送出的原文送给 sidecar 实时标点（同一份 cache，块首标点不删）。标点只刷新 Monitor / 刚结束这场的 JSONL 回看字幕，经 `presentPunctuatedCaptions` 再交给现有 `presentCaptions`（含约 48 字 / 6 秒软切）。没有句末标点时仍按原始 final 切开，软切继续生效。不改 JSONL、`AsrResult` 和规则窗口。模型不可用或对不齐时字幕退回原文。停播时若本机已有离线 `ct-punc` 权重，再跑一遍全文美化当次回看；没有权重不下载。可用 `DINGBO_PUNC_INTERVAL_MS`、`DINGBO_PUNC_EVERY_N_FINALS` 调整。不升版本，不打 tag
- `docs/research/dual-surface.md`：M5 双端的开源界面参考（方向输入，未集成）。可借鉴：
  - [pdfpc](https://github.com/pdfpc/pdfpc)（讲者台信息密、观众面干净，键盘留在控制端）
  - [Pympress](https://github.com/Cimbali/pympress)（0/1/2 块屏都能用，热插拔后重选）
  - [OBS Projector](https://obsproject.com/kb/power-of-projectors)（输出窗无菜单）
  - [PDF Presenter](https://github.com/JasonTheKnight/pdf-presenter)（双 `BrowserWindow`，关输出窗不停会话）
  - [PDF Presenter Lite](https://github.com/allansargeant/pdf-presenter-lite)（`?mode=`，挂载后再拉状态）
  - [HtmlPPT Player](https://github.com/chenggang928/htmlppt-player)（单屏窗口排练，Esc 只关投影）
  - [Stage Teleprompter Pro](https://github.com/matecodedev/stage-teleprompter-pro)（操作员与人才分窗；不抄滚稿）
  - [Eyevinn teleprompter](https://github.com/Eyevinn/teleprompter)（一份真相源；盯播不用第二路 WebSocket）
  - [KeyCast Lower Thirds](https://github.com/kzorluoglu/keycastlowerthirds)（控制端选屏，IPC 推画面）
  - [Electron `screen`](https://www.electronjs.org/docs/latest/api/screen)（用 DIP `bounds` 摆第二窗）
- PRD v0.3.0 工作稿就地展开 §6：Control / Stage 的可见内容、阶段与 pin / dismiss 权限、选屏与单屏排练、断屏、关 Stage 不停会话、空错态、非目标，以及 §6.8 退出清单。Control 预留 M6 信号空位。**未实现**，不升 0.4.0，不改 `versions/` 冻结快照
- SDD ADR-014 / §22.1 就地展开：`controlBrowserWindow` / `stageBrowserWindow`、同一包 `?surface=control|stage`、主进程 `SessionProjection`、建议通道 `stage:open` / `close` / `push` / `get-state` / `display-list`。拒绝第二套分析、第二路 WebSocket、幻灯片页模型。**未实现**
- PRD §5.2 第 7 条：实时字幕按句子呈现，而不是按秒碎片行。断句优先标点（。！？；… 等；单个英文句点不断句），辅以约 800ms 静音 / 停顿。已随 PR #15 落地（`src/shared/transcript/sentences.ts`，Monitor 字幕区）。说话人分离不进本条，只在 §5.4 标为更远且未实现
- SDD §7.3：字幕展示断句口径——展示层合并相邻 final 原文；句末标点或相邻片段间隔 ≥ 800ms 收束。代码在 `sentences.ts` / Monitor captions
- M4 P1 健康预检：准备区展示检查状态；FunASR 实际拉起 sidecar 并等待模型就绪，讯飞完成云端握手；Renderer 与 Main 双层开始门禁
- M4 P1 最近一场 JSONL 只读回看：停止后由 Main 定位并安全重读文件，展示问题与 final 字幕摘要，不支持任意路径、历史管理或导出
- M4 人工验收清单：`docs/acceptance/m4-manual-acceptance.md`，覆盖真环回 30 分钟与 10 窗抽检，实机结果待回填

### Changed
- PRD/SDD v0.3.0 工作稿以 #20 之后的 `latest` 为底，补记 M5 代码已落地，并标明仍未实现项（M6/M7、品备注输入、断屏提示接线、排练标记、M6 信号空位、人工验收）。版本仍是未打 tag 的 v0.3.0 Draft，不另开 0.4.0，不改 `versions/` 冻结快照
- PRD/SDD v0.3.0 工作稿回写 M4 P1：健康预检与最近一场 JSONL 回看标为已落地，人工清单路径写入验收节。保留 M5 §6 / ADR-014，双端仍是方向、未实现。版本仍是未打 tag 的 v0.3.0 Draft，不另开 0.4.0，不改 `versions/` 冻结快照
- PRD §9：写明「近窗静音占比」只服务语速 / 节奏规则，不是字幕展示断句。成句展示已随 PR #15 落地。版本仍是未打 tag 的 v0.3.0 Draft，就地改 `latest.md`，不另开 0.4.0，不改 `versions/v0.3.0.md` 冻结快照
- 恢复 `versions/` 整份快照约定：冻结某版时，除更新 CHANGELOG、打 tag `prd-vX.Y.Z` / `sdd-vX.Y.Z` 外，必须把当时 `latest.md` 完整复制为 `docs/prd/versions/vX.Y.Z.md` 与 `docs/sdd/versions/vX.Y.Z.md`。`latest.md` 仍是现行唯一编辑入口
- 补齐快照：`versions/v0.2.0.md` 取自 tag `prd-v0.2.0` / `sdd-v0.2.0` 当时的 `latest.md`；`versions/v0.3.0.md` 取自 #11 合入时的 `latest.md`（表头 v0.3.0）。tag `prd-v0.3.0` / `sdd-v0.3.0` 尚未打，由人工或后续操作

## [SDD 0.3.0] - 2026-10-18

### Added
- ADR-014：同机双表面（抬头大屏 / 中控盯播台），同一规则引擎投影，禁止第二套分析。未实现，归 M5
- ADR-015：出站 `ActionSignal`（推流信号、发券信号）与采音入站分离。默认只在中控台；人确认后才连本机 OBS 或 webhook。未实现，归 M6
- ADR-016：可选闭麦默认关，框架 JSON 不能打开；打开后仍要人工确认。未实现，归 M7
- §22 方向架构：表面投影、信号契约、闭麦开关、出站安全。明确不请求抖音直播间 URL、不接未授权私有接口

### Changed
- 文头升至 v0.3.0，对齐 PRD v0.3.0。M1–M3 与 M4 P0 仍按已落地回写；M4 P1 与 M5–M7 分开
- 非目标写明：推流信号不是 URL 拉流，也不是开播监测
- §21：通用云密钥填写入口已隐藏，不再写成与讯飞凭据并排

## [0.3.0] - 2026-10-18

### Added
- PRD 升至 v0.3.0 Draft（不打 tag）：只做抖音直播；韩束抖音直播间（房间号示意 295178185857）作为用户故事场景，不编造其未公开 GMV / SKU / 话术
- 双端展示写入 M5：主播/助播抬头大屏（阶段 / 角标 / 一句建议），中控详细盯播台（问题时间轴、转写片段、框架命中；品备注并排但不是 GMV 总控），播后复盘复用详细台
- M6：推流信号与发券信号。与开播监测、URL 拉流区分开。优先信号给中控 / 本机 OBS / 可配置 webhook；直接调平台 API 列为开放问题
- M7：舆情词库沿用 `avoid` 的应用内提醒；立刻闭麦为可选、默认关，需人工确认。写明误杀风险
- 里程碑 M5–M7 的可执行退出标准，以及 8 条新开放问题（§16.2）

### Changed
- 保留 v0.2.0 已结案内容与 M1–M3。M4 继续体验硬化：P0 凭据门禁与设置页密钥收敛已落地，P1（健康预检、JSONL 回看、人工清单）未做
- v0.2.0「播出侧 mute 明确不做」演进为：Must 仍是应用内提醒；闭麦不提前做成默认行为
- 回写此前已落地、尚未升版的 M4 P0：未配置讯飞 APPID/APIKey 时开始按钮不可用，主进程在进入 preparing 前拒绝 `session:start`；设置页隐藏通用云 ASR 密钥填写入口，旧通用密钥不再读取或写入

## [SDD 0.2.0] - 2026-10-18

### Added
- 讯飞 RTASR 适配器与独立 `safeStorage` 凭据文件；开始前凭据 / health 门禁（M4，代码尚未落地）
- 采集桥 IPC：`audio:chunk`、`audio:beginCapture`、`audio:captureFailed`、`audio:level`，以及讯飞凭据通道
- FunASR 协议桥纳入基线引用（`docs/sdd/funasr-protocol-bridge.md`）
- LiveNotes：渲染进程本地记事，实验，不进规则与复盘
- M4 交付切片：凭据 UX、健康预检、JSONL 回看、真环回 / 抽检清单
- 与 README 对齐的有意差别：无 WASAPI 原生、无安装包、质量门槛更严、`must_say` 冷却 3 分钟

### Changed
- 版本保管改为 latest + CHANGELOG + git tag（`sdd-vX.Y.Z`）；不再把 latest 完整复制到 `versions/`。`versions/v0.1.0.md` 仅作考古
- 文头升至 v0.2.0，对齐 PRD v0.2.0
- ADR-010 密钥方案由 keytar 更正为 Electron `safeStorage`；通用云 ASR 密钥标为废弃（代码入口仍在，收敛归 M4）
- 明确默认 ASR 为 FunASR sidecar，云端第二实现为讯飞 RTASR 标准版
- M1–M3 标为代码侧完成；漏讲双窗与「1～2 分钟可见」、30 分钟真环回的验收口径写清

## [0.2.0] - 2026-10-18

### Added
- PRD：回写 M1–M3 与讯飞 RTASR 已交付状态；结案 §12 开放问题；新增 M4 体验硬化
- PRD：云 ASR（讯飞）凭据就绪门禁、停止后本场 JSONL 最简回看列为 Should；开始前 ASR 健康预检为可选 Should
- LiveNotes 侧栏记事标为实验，不进入正式 Should

### Changed
- 版本保管改为 latest + CHANGELOG + git tag（`prd-vX.Y.Z`）；不再把 latest 完整复制到 `versions/`。`versions/v0.1.0.md` 仅作考古
- 文头升至 v0.2.0（2026-10-18）；状态为 Draft，实现已对齐 M3 + 讯飞
- 默认 ASR 写明为 FunASR sidecar，第二实现为讯飞 RTASR；密钥方案写明 Electron `safeStorage`
- 通用「云 ASR 密钥」标为废弃，有效云凭据路径仅讯飞凭据（本版不改代码，设置页入口留到 M4）
- 澄清漏讲双窗可能导致首条漏讲超过 2 分钟；30 分钟真环回仍为人工验收

## [SDD 0.1.0] - 2026-10-17

### Added
- 首版 SDD：对齐 PRD v0.1.0，明确 Electron + React + TypeScript、本地 FunASR sidecar、系统环回音频管线和主进程/渲染进程信任边界
- 定义音频、ASR、转写窗口、话术框架、问题证据与覆盖数据契约，以及会话状态机和 IPC 接口
- 补齐内容、语速、节奏规则的计算口径、初始阈值、数据质量门槛、去重冷却和建议动作
- 明确本地 JSONL 复盘、OS 安全存储、日志脱敏、错误恢复、性能目标和测试策略
- 建立 `docs/sdd/latest.md + versions/ + docs/CHANGELOG.md` 的 SDD 版本保管约定，并冻结 `docs/sdd/versions/v0.1.0.md`

## [0.1.0] - 2026-10-17

### Added
- 首版 PRD：定位、Must/Should/Could、MVP 范围、技术路径、验收标准、不做清单
- 目录与版本管理约定（`latest` + `versions` + CHANGELOG）
- 话术框架 JSON 样例 v0（`frameworks/example-framework.v0.json`）
- 竞品与核心需求摘要（`docs/research/`）
