# AI盯播

桌面端 AI 直播盯播。同一台机器上有两块界面：**中控（Control）** 采音、转写、用滑动窗口对照话术框架，并标出语速 / 节奏 / 内容问题；**抬头屏（Stage）** 只显示阶段、至多一条建议和健康点。音源可以是本机环回，也可以直接贴抖音直播间链接，从直播流抽音。产品默认识别是本机 **FunASR**（CPU 上的 `paraformer-zh-streaming`）；配好凭据后可选 **讯飞 RTASR**。中控可开推流 / 发券动作提醒，确认只记「已处理」。启动加载 `frameworks/example-framework.v0.json`；丰富版 `frameworks/example-framework.v0.1-rich.json` 在同目录，用「更换框架」打开。SenseVoice 只有旁路探针文档（[ADR-018](docs/adr/ADR-018-sensevoice-bypass.md)），没有进产品。

## 怎么演示

先按下一节把应用跑起来。窗口初次停在模拟音频和 Fake ASR，演示时改成：

1. 音频来源选 **抖音直播流**，粘贴 `https://live.douyin.com/<房间号>`；识别选 **FunASR 本地**，等准备区预检通过。
2. 点 **开始盯播**。字幕区开始滚直播转写。
3. 点 **显示直播画面**，用于扫码登录或确认在播。看完点 **隐藏直播画面**，按钮回到「显示直播画面」（#42）。画面开关不影响采音。
4. 在 **抬头屏** 面板选择显示器和「窗口 / 全屏」，点 **打开抬头屏**。
5. 停播后点 **更换框架**（盯播进行中不能换），选择 `frameworks/example-framework.v0.1-rich.json`。

## 本地运行

需要 Node.js 22+。仓库使用 pnpm。

```bash
pnpm install
pnpm dev
```

其他命令：

```bash
pnpm test
pnpm typecheck
pnpm build
pnpm package
```

`pnpm package` 会先做 `electron-vite build`，再确认 `out/main`、`out/preload`、`out/renderer` 都在。它**不会**打出 Windows / macOS 安装包。

不接直播间时，开发窗口可以先走下面这条模拟链路（产品演示见上一节）：

1. 音频来源选 **模拟音频**，识别选 **Fake ASR**。
2. 左侧应显示示例框架名和 revision。框架 JSON 校验失败时，开始按钮不可用，点了也会停在出错。
3. 点 **开始盯播**。几秒内字幕区会滚出固定口播稿，例如「大家好，欢迎来到今天的直播间。」
4. 这只说明字幕链路通了。界面会写明这不是系统环回成功。
5. 选 **FunASR 本地** 再开始时，主进程会拉起 `python3 python/funasr_sidecar/server.py`，并在 CPU 上加载 `paraformer-zh-streaming`。对外仍是盯播自己的 WebSocket（见 `docs/sdd/funasr-protocol-bridge.md`）。本机没有 Python 3、`funasr` 或模型下载失败时，会话进入出错，不会拿骨架句子冒充识别成功。权重在 `~/.cache/modelscope`，不进仓库。单测使用 `--stub`，不下载模型。盯播过程中主进程还会按间隔把最近的原文送给 sidecar 做展示层标点（默认 4 秒或 6 条 final）；标点失败时字幕仍按原文成句。这项不改复盘 JSONL 里的原文。

## 配置讯飞 RTASR

1. 在讯飞开放平台为应用开通[实时语音转写标准版](https://www.xfyun.cn/doc/asr/rtasr/API.html)，确认有时长和可用路数。若控制台启用了 IP 白名单，填入本机当前公网 IP，不要使用局域网 IP。
2. 打开应用 **设置 → 讯飞 RTASR 凭据**，同时输入 APPID 和 APIKey 并保存。两个输入框提交后立即清空，界面只显示配置来源，不回显明文。
3. 凭据由主进程通过 Electron `safeStorage` 加密，独立保存到应用数据目录的 `secrets/xfyun-rtasr-credentials.bin`，不会进入 `settings.json`、日志或复盘。没有系统安全存储时拒绝保存。
4. 未打包开发进程也可以临时使用 `DINGBO_XFYUN_APP_ID` 和 `DINGBO_XFYUN_API_KEY`，两项必须同时配置；打包后不会读取这些环境变量。不要把真实值写进 `.env` 后提交仓库。
5. 回到 **盯播**，选择 **讯飞 RTASR（云端）**。还没配好 APPID 和 APIKey 时，「开始盯播」不可用，准备区会写「未配置讯飞 APPID/APIKey，请到设置页填写」。配好之后，其它开始条件满足就可以开始。开始盯播即表示允许把实时音频发送到 `rtasr.xfyun.cn`；Fake 和 FunASR 不受这条凭据门禁影响。
6. 手动验收时选择系统环回，播放中文口播，确认字幕能从 partial 进入 final、停止后能收到末尾结果。鉴权失败（10105）检查 APPID/APIKey、系统时间和 IP 白名单；未授权或路数不足（10110）检查服务开通与额度。

RTASR 标准版不支持会话级热词，因此话术框架关键词只用于本地规则分析，不会传给讯飞。首版未启用翻译、角色分离和方言扩展。

模拟脚本大约 14 秒一轮，会循环，方便看字幕持续滚动。

## 中控动作提醒

准备区可启用推流 / 发券规则。阶段可多选，示例默认是讲品或促单，不必锁死一个阶段；讲点可选；冷却默认 180 秒，且在结束前不会因为换了一种说法提前再响。不勾讲点时，直接说上链接、几号链接、小黄车、直接拍会提醒推流，直接说发券或倒计时、就这一次会提醒发券。只说卖点不够，除非同一分析窗里还有链接或价格。价格讲点只作加成，不再单独卡住全部提醒。运行中合格完整分析窗满足条件才提醒，发券还要求当前窗无禁讲命中。保存后的修改从下次开始盯播生效。中控确认只记录「已处理」，不执行外部动作；抬头屏不显示这些信号。

停止后可查看触发依据及人工处理记录。配置与信号分别写入独立本地文件。默认关闭。连本机 OBS 或 webhook 仍后置。操作核对见 [动作提醒验收](docs/acceptance/m6-1-manual-acceptance.md)。

## 抬头屏

中控保留采音、转写、问题、讲点、设置、动作提醒和停播回看。抬头屏是同机第二块窗口，显示阶段、未读数、至多一条建议和健康点，共用主进程的会话与规则结果，不另外采音。

1. 在中控的「抬头屏」面板选择显示器与「窗口 / 全屏」模式，再点「打开抬头屏」。界面启动时预选显示器列表第一项，不会自动打开抬头屏；全屏不能放到中控所在屏。
2. 开始后，在中控切换阶段、点击问题的「钉上大屏」或「跳过这条」。抬头屏跟随主进程投影，不另外采音或计算规则。
3. 关抬头屏或按 Esc，盯播继续；中控点击停止会结束会话并关闭抬头屏。盯播中关中控会先弹确认；系统退出路径则直接停止。
4. 停止后在中控回看本场 JSONL，也可从本机场次目录打开历史场。人工清单见 [抬头屏验收](docs/acceptance/m5-manual-acceptance.md)。

## 怎么验证 M3

M2 的分析路径仍然可用，见下一节。M3 额外可以这样看：

| 路径 | 怎么看 |
|------|--------|
| 问题卡片 | 每条卡片直接写「建议：…」，文案来自规则模板，不调 LLM。点开抽屉还能看到同一句 |
| 本场累计 | 右侧标题是「本场累计」。没加载框架、框架没有 must_say、还没开场，三种空态写法不同。近窗漏讲仍在问题列表里，要连续两个完整窗口 |
| 设置落盘 | 改窗口和间隔后保存。文件在应用数据目录的 `settings.json`，只有 `schemaVersion`、`windowMs`、`intervalMs`。盯播进行中这两项和密钥都不能改。越界仍会被拒绝 |
| 通用云 ASR 密钥 | 已废弃。设置页没有填写框，也不读取旧密文或 `DINGBO_CLOUD_ASR_KEY`。若本机还留着 `secrets/cloud-asr-key.bin`，可以用「清除本机旧密钥」删掉，清除时不显示明文 |
| 讯飞 RTASR | 唯一有效的云凭据路径。独立保存 APPID + APIKey，盯播中不能改。未配置时不能开始。选择后由主进程通过 WSS 发送 16 kHz 单声道 PCM，40 ms 一个二进制分片。鉴权和授权错误直接显示，不自动重连；网络断连进入既有降级重连 |
| ASR 健康预检 | 选择识别服务后自动检查，也可在准备区重试。FunASR 会拉起独立 sidecar 并等待真实模型加载，检查结束回收进程；讯飞要云端握手收到 `started`。失败、检查中或结果过期都不能开始，主进程开始前还会复检 |
| 停止复盘 | 点停止后写入 `sessions/<sessionId>/session.jsonl`，首行 `session_started`，末行 `session_stopped`。不存原始音频。写盘成功后自动从该文件重新载入最近一场的只读问题与字幕摘要，不传任意文件路径；写失败时状态变为出错，只保留内存浏览并明确说没写成 |
| 降级重连 | 环回连续 3 秒没有帧，或识别报错，会进入「已降级」，并按 1/2/4/8 秒重连，最多 5 次。次数用完进入出错。采音缺口不当成超长停顿 |

`pnpm test` 在 M2 的用例之外，覆盖建议模板、设置 JSON、密钥不出现在状态和日志里、ASR 预检协调与门禁、JSONL 往返与安全重读、写盘失败、重连预算，以及用 Fake ASR 注入音频时钟跑满 30 分钟。这 30 分钟是音频时钟，不是墙上时钟，也不是真环回。真环回与 10 窗抽检使用 [M4 人工验收清单](docs/acceptance/m4-manual-acceptance.md)。

## 怎么验证 M2

默认是每 **60 秒**分析最近 **300 秒**，而且要等音频时钟走满一个完整窗口才第一次分析。想快点看到问题，先到 **设置** 把窗口改成 **60 秒**、间隔改成 **15 秒**，再开始。盯播进行中这两项不能改。

| 路径 | 怎么看 |
|------|--------|
| 模拟音频 + Fake ASR + **正常口播** | 字幕照旧滚动。第一个完整窗口后，三个必讲点都会勾上。这套稿语速通常高于示例框架上限，会出现「语速偏快」。不会出现触雷或漏讲 |
| 模拟音频 + Fake ASR + **问题样例** | 约 60 秒（若窗口是 60 秒）出现「触雷：绝对化疗效承诺」和「超长停顿」。再过一个分析间隔，出现「近窗有 2 个必讲点未覆盖」。卖点勾上，价格和促单保持未讲 |
| 问题卡片 | 角标等于未读条数。点开能看到时间窗、原文、框架条目和指标；打开详情或「标为已读」后角标下降。冷却期内再次命中不新增卡片 |
| 坏框架 | 换一份缺字段或 `pace.min > pace.max` 的 JSON，界面写出字段路径，并且不能开始 |
| 设置越界 | 窗口小于 60 秒或大于 900 秒、间隔小于 15 秒或大于 300 秒，保存会被拒绝 |
| 模拟音频 + FunASR 本地 | 本机已装好 `funasr` 且模型缓存可用时，字幕来自 `paraformer-zh-streaming`。没装好就停在出错，不会冒充转写 |
| 系统环回 | 只有收到第一帧 PCM 才进入「盯播中」。打不开、没有音轨或超时，会停在出错 |

`pnpm test` 覆盖分帧、文本规范化、TranscriptBuffer、Fake ASR、状态机、sidecar 协议，以及框架校验、调度重入、漏讲双窗、触雷、语速抑制、节奏缺口和问题样例注入。`pnpm typecheck` 同时检查主进程和渲染进程。

## M1 里仍能验证什么

| 路径 | 怎么看 |
|------|--------|
| 模拟音频 + Fake ASR | 字幕按固定脚本出现 partial，再到 final。默认文稿不改 |
| 模拟音频 + FunASR 本地 | 加载成功后 health 的模型 id 是 `paraformer-zh-streaming`。`--stub` 仍回骨架文本 |
| 系统环回 | 只有收到第一帧 PCM 才进入「盯播中」 |

## 架构和有意差别

主路径仍按 SDD §3 / §4：渲染进程只拿 UI 和系统采集桥，主进程做分帧、ASR、缓冲和会话。preload 按窗口角色暴露白名单：中控是完整控制面；抬头屏只有 `getStageState`、`getStageTranscript`、`onStagePush`、`onStageTranscript`；直播流窗不暴露 bridge。不开 `nodeIntegration`，打开 `contextIsolation` 和 sandbox。

和 SDD 原文相比，有这些收窄或口径差异：

- Windows 原生 WASAPI 桥接没有打包。能枚举到屏幕源时，用 Electron `desktopCapturer` + `audio: 'loopback'` 作为回退；枚举失败就明确不可用。
- 渲染进程通过 `getDisplayMedia` 取系统音频，再把浮点 PCM 经 `audio:chunk` 交给主进程。这是架构图里的采集桥，SDD §11 的命令表还没列这个通道。
- 演示时默认可以选 Fake ASR。选 FunASR 时 sidecar 在 CPU 上加载 `paraformer-zh-streaming`；`--stub` 只验证协议。
- `degraded` 会在环回丢帧或 ASR 报错时进入，并按 1/2/4/8 秒自动重连，最多 5 次；第 5 次仍用 8 秒。次数用完进入 `error`（状态机新增 `GIVE_UP`）。降级期间不把缺音频判成静音，也不做常规分析。识别重连不回放旧音频。
- 从「已结束 / 出错」再点开始，会先回到 idle 再进入 preparing。若上一场复盘还没写成，会再试一次写盘。
- 窗口和间隔按 SDD 边界校验，并写入应用数据目录的 `settings.json`。盯播进行中不能改，也不能换框架或密钥。
- 讯飞凭据走 Electron `safeStorage`（系统钥匙串 / DPAPI / libsecret 这一类），不使用 keytar。密文文件在应用数据目录的 `xfyun-rtasr-credentials.bin`。渲染进程只拿到是否已配置，明文不进渲染进程状态、不进 IPC 返回值、不进日志和复盘。开发回退只在未打包进程成对读取 `DINGBO_XFYUN_APP_ID` / `DINGBO_XFYUN_API_KEY`。设置页的密码框只在提交那一刻把字符串交给白名单 IPC，不放进 React state。通用云 ASR 密钥已废弃，不再读取或写入。只有选择讯飞并开始或健康检查时才会建立公网连接；未配凭据时开始按钮不可用，主进程也不会进入 preparing。
- 停止顺序是：停调度器 → 停采音 → `ASR.flush()` → 最多等 5 秒最终字幕 → `finalFlush` 分析 → 写 `session.jsonl` → 停 sidecar。事件按发生顺序追加，首行一定是 `session_started`，末行一定是 `session_stopped`，中间不是按类型分组。写失败进入 `error`，内存会话保留。没有导出 UI，也没有云同步。
- 单轮分析仍是同步函数。超过 10 秒只记 `analysis_timeout`，不会中途杀掉；并行堆积由调度器的 overrun 跳过保证。
- `frameworkRevision` 是校验后规范化 JSON 的 SHA-256（对象键排序、字符串 trim），不是文件原始字节。
- 第一次常规分析要等音频时钟走满窗口，之后按间隔触发。停止时会补跑一次；没满窗的补跑不计入漏讲的连续窗口。
- `must_say` 的再次未读冷却用 3 分钟，和触雷一致。SDD 写了触雷 3 分钟、语速和节奏 5 分钟，没写漏讲的分钟数。
- 音频覆盖不足 80%、有效语音不足 15 秒，或 final 文本覆盖不足 60% 时，不推进漏讲计数。触雷仍然会报。这比 §9.1 的字面要求更严，避免把没听清当成没讲。
- 单字关键词只按非字母数字边界匹配。同一窗口的节奏问题只留优先级最高的一条：超长停顿、静音占比、连珠炮。
- 打开证据抽屉会把该条标为已读。漏讲后来补上了，历史问题不会自动删。勾选区是本场累计，和近窗漏讲不是同一件事。
- 问题时间和冷却用会话音频时钟。系统通知、语义跑题和 `keyword_similarity` 实验接口都没做。
- 「问题样例」只在模拟音频 + Fake ASR 时替换注入文稿，用来演示触雷、漏讲和长停顿。默认口播脚本不变。

## 已知限制

- **隐藏直播画面**：关系统窗口和点「隐藏直播画面」走同一条可见性回传，中控按钮回到「显示直播画面」（#42）。隐藏不会把抽音打成全零。
- **动作出站**：推流 / 发券只在中控提醒，确认表示已处理。连 OBS 或 webhook 仍后置。
- **macOS**：系统环回依赖 14.2+ 的系统音频录制权限。权限不够时音轨会直接结束，应用会报错，不会显示盯播中。不同系统版本不一致，首验平台是 Windows。
- **Linux / 当前云端环境**：没有可用的系统环回。请用模拟音频看字幕。不要把这个结果当成环回验收。
- **Windows**：还没有 WASAPI 原生插件。桌面环回要等用户授权，并且进程必须真的收到音频回调。
- FunASR 只绑定 `127.0.0.1`，用一次性令牌，不把音频发到公网。F1 在 CPU 上加载 `paraformer-zh-streaming`，缓存默认在用户目录的 `~/.cache/modelscope`。仓库里的 `.cache/`、`modelscope_cache/` 仍然忽略。`--stub` 不下载模型。
- 讯飞 RTASR 是公网云服务，音频会离开本机；需要有效授权和可用网络。自动测试使用本地模拟 WebSocket，不会消耗云端额度；真实环回、长时间延迟和识别准确率仍需用本人凭据单独验收。
- `pnpm package` 只验证 electron-vite 产物。没有 electron-builder，CI 不产出可分发安装包。
- 30 分钟不断采、不断字由 Fake ASR 注入音频时钟覆盖，不是墙上 30 分钟，也不是真环回 soak。人工抽检 10 个问题窗仍要人来做。
- 若系统没有可用的安全存储，密钥不能保存。不要把密钥写进 `settings.json` 或提交进仓库。
- 默认 300 秒窗口时，要等约 5 分钟音频时钟才出第一轮问题。漏讲还要再等一个间隔。
- 间隔大于窗口时，两窗之间的口播不会进入这一轮分析。
- 语速和节奏用的是帧能量 VAD，不是独立声学模型。模拟音频的「语音」只是脚本有字的那几秒。

## 目录约定

| 路径 | 用途 |
|------|------|
| `docs/prd/latest.md` | **当前工作稿**，一起改这一份 |
| `docs/prd/versions/` | 各版 PRD 完整快照（`vX.Y.Z.md`）；冻结时从当时的 `latest.md` 复制，之后只读 |
| `docs/prd/README.md` | PRD 版本规则 |
| `docs/sdd/latest.md` | **当前软件设计 / 技术方案工作稿**，一起改这一份 |
| `docs/sdd/versions/` | 各版 SDD 完整快照（`vX.Y.Z.md`）；冻结时从当时的 `latest.md` 复制，之后只读 |
| `docs/sdd/README.md` | SDD 版本规则 |
| `docs/CHANGELOG.md` | PRD、SDD 与项目文档变更记录（Keep a Changelog） |
| `docs/adr/ADR-018-sensevoice-bypass.md` | SenseVoice 旁路探针。决策已接受，产品未实现 |
| `docs/research/sensevoice-probe.md` | 探针测量清单；延迟、CPU、丢窗率仍待实测 |
| `docs/research/` | 竞品与核心需求备忘 |
| `notes/` | 会议纪要 / 拍板记录 |
| `frameworks/` | 话术框架 JSON 样例。启动默认加载 `example-framework.v0.json`（`demo-sku-001`）；丰富版 `example-framework.v0.1-rich.json`（`demo-sku-001-rich`）放在同目录，用「选择话术框架 JSON」打开 |
| `src/main/` | Electron 主进程：会话、采音、ASR、缓冲、框架、规则、设置、复盘、双窗投影与显示器管理 |
| `src/preload/` | contextBridge 白名单 |
| `src/renderer/` | React 盯播界面 |
| `src/shared/` | 主进程和渲染进程共用的契约与默认值 |
| `python/funasr_sidecar/` | 本地 ASR sidecar。对主进程说盯播方言；`bridge.py` 翻译字段，`engine.py` 在 CPU 上加载 `paraformer-zh-streaming` |
| `docs/sdd/funasr-protocol-bridge.md` | 盯播 WebSocket 与官方 FunASR / AutoModel 的字段和时序 |
| `tests/` | 单元测试和 sidecar 契约测试 |
| `resources/models/` | 模型目录，权重不进仓库 |

## 怎么一起改 PRD

1. 日常只改 `docs/prd/latest.md`
2. 达成共识要「定一版」时：在 `docs/CHANGELOG.md` 记一笔，给该 commit 打 tag `prd-vX.Y.Z`，并把当时的 `latest.md` 完整复制为 `docs/prd/versions/vX.Y.Z.md`
3. 小改（措辞澄清）升 **patch**；加能力升 **minor**；推翻范围/架构升 **major**

当前 PRD 版本：**v1.0.0 Draft**（见 `docs/prd/latest.md` 文头；未打 tag）

## 怎么一起改 SDD

1. 日常只改 `docs/sdd/latest.md`
2. 技术方案评审通过要「定一版」时：在 `docs/CHANGELOG.md` 记一笔，给该 commit 打 tag `sdd-vX.Y.Z`，并把当时的 `latest.md` 完整复制为 `docs/sdd/versions/vX.Y.Z.md`
3. 小改（设计澄清）升 **patch**；新增子系统、外部依赖或重要接口升 **minor**；整体架构或核心数据流推翻升 **major**
4. SDD 文头必须记录对齐的 PRD 版本；PRD 变化后先评估影响，再同步 SDD

当前 SDD 版本：**v1.0.0 Draft**，对齐 **PRD v1.0.0**（见 `docs/sdd/latest.md` 文头；未打 tag）
