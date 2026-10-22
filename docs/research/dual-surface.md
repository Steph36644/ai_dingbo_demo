# 双端展示调研笔记（2026-10-19）

供 M5 方向设计引用（PRD §6、SDD ADR-014 / §22.1）。下面这些仓库**不是依赖**，本产品未集成、未改运行时代码。盯播仍是连续事件流，不是翻页讲稿。

## 结论

可借鉴的是「观众面干净、操作面信息密、同一份状态」：输出窗不带菜单和设置，焦点与键盘留在控制端，热插拔后不要静默改道。

不借鉴的是幻灯片页模型、提词滚稿、多画面宫格，以及在两个窗口之间再架一条 WebSocket。AI盯播的真相源在主进程，Stage 只收投影。

## 可借鉴

| 项目 | 地址 | 模式 | 落到 M5 的哪一条 |
|------|------|------|------------------|
| pdfpc | <https://github.com/pdfpc/pdfpc> | Presenter Console | 抬头屏少字，中控信息密。键盘留在 Control，不把焦点交给 Stage |
| Pympress | <https://github.com/Cimbali/pympress> | 双屏 PDF | 0 / 1 / 2 块屏都能用。显示器拔掉后重选，不假装第二块屏还在 |
| OBS Projector | <https://obsproject.com/kb/power-of-projectors> | 主窗 + 干净投影 | 输出窗无菜单。控制台控件不进人才屏 |
| PDF Presenter | <https://github.com/JasonTheKnight/pdf-presenter> | Electron 双 `BrowserWindow` | 显式选第二块屏。关掉输出窗只关那一扇，不结束会话 |
| PDF Presenter Lite | <https://github.com/allansargeant/pdf-presenter-lite> | `?mode=` + get-state | 同一套页面用查询参数分表面。输出窗挂载完成后再拉一次全量状态 |
| HtmlPPT Player | <https://github.com/chenggang928/htmlppt-player> | Play / Presenter | 单屏可以窗口排练。Esc 退出投影，不杀掉正在进行的会话 |
| Stage Teleprompter Pro | <https://github.com/matecodedev/stage-teleprompter-pro> | Dashboard / Stage | 操作员调参，人才只看结果。本产品不抄它的滚稿 |
| Eyevinn teleprompter | <https://github.com/Eyevinn/teleprompter> | Controller / Display | 一份真相源。盯播用主进程，不在两个窗口之间再开 WebSocket |
| KeyCast Lower Thirds | <https://github.com/kzorluoglu/keycastlowerthirds> | 控制台 + 输出窗 | 由控制端选屏，用 IPC 推当前画面。输出窗走 kiosk 式干净画面，但本产品启动时不抢屏 |
| Electron `screen` | <https://www.electronjs.org/docs/latest/api/screen> | `getAllDisplays` / bounds | 用 DIP 的 `bounds` 摆窗口。不假设第二块屏的尺寸和缩放 |

## 明确不照搬

- 页码、下一页、演讲者备注。盯播是阶段标签加连续问题流，不是幻灯片。
- 激光笔、观众批注。
- 提词器滚稿和镜像。
- OBS Multiview 那种多画面宫格。
- 为双窗单独起一个 WebSocket 服务。
- 应用一启动就全屏占领第二块屏。

## 和文档的关系

产品口径在 `docs/prd/latest.md` §6，技术口径在 `docs/sdd/latest.md` ADR-014 与 §22.1。状态都是**方向，未实现**。本笔记不改变 M1–M4 已交付行为。
