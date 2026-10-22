# ADR-018 SenseVoice 旁路探针

| 字段 | 值 |
|------|-----|
| 编号 | ADR-018 |
| 状态 | **Accepted as Probe**。探针这项决策已接受。sidecar、进程间协议、界面与规则挂钩仍是 Proposed，未开工，未交付 |
| 日期 | 2026-10-21（Asia/Shanghai） |
| 决策 | 2026-10-21 产品拍板：第一版旁路同时做情绪 + 音频事件；下一步只做探针。本文不代表功能已上线 |
| 对齐 | PRD v1.0.0 Draft §13；SDD v1.0.0 Draft ADR-005 / §1.1 |
| 测量 | [`docs/research/sensevoice-probe.md`](../research/sensevoice-probe.md)。表内数字全部是 `[TODO: 探针实测]`，本文不引用任何本机成绩 |

> 工作稿。不打 tag，不复制 `versions/`。不改 `src/`，不新增 sidecar。

## 1. 问题

盯播主链已经能出字幕和规则：同一路 16 kHz 单声道 PCM 进 FunASR（`paraformer-zh-streaming`）或讯飞 RTASR，再进字幕、话术规则和动作提醒。这条链不看「笑了、在放歌、语气冲了」。

直播里这些声音事件对中控有用，但它们不该改写字幕。SenseVoiceSmall 是非自回归整段模型，官方能力同时包含语音识别、情绪标签和音频事件标签（[FunAudioLLM/SenseVoice README](https://github.com/FunAudioLLM/SenseVoice/blob/main/README.md)）。若把它接成第二路字幕 ASR，会和 ADR-005 的流式主链抢 CPU，也会做出两套字幕。

本 ADR 只回答：在不碰主链的前提下，要不要先花一次离线探针，量清楚固定窗旁路能不能在本机上留下可用的情绪和音频事件。

## 2. 决策

接受「旁路探针」，不接受「旁路已实现」。

1. **字幕 ASR 保持现状。** 直播字幕、规则窗口、动作提醒只消费 FunASR 或讯飞 RTASR。直播中不热切换。见 ADR-005。
2. **SenseVoice 是旁路。** 读同一份 PCM，按固定窗切段，送 SenseVoiceSmall（或探针记录下来的同等检查点），产出 `EmotionEvent` 与 `AudioEvent`。第一版探针把情绪和音频事件放在同一次测量里，不先做纯情绪。
3. **探针先于 sidecar。** 窗口、标签枚举、延迟、CPU、丢窗率以 [`sensevoice-probe.md`](../research/sensevoice-probe.md) 的空表为准。表未填、门槛未过，不开 sidecar 实现，不改产品代码。
4. **失败静默。** 旁路缺权重、超时、崩溃、写盘失败，主链会话继续。不进开始前健康门禁，不把主链打成 `error`。
5. **提示只预留给 Control。** 探针通过之后，轻提示（灯条 / 徽章）放在中控。抬头屏保持干净。探针阶段连这层 UI 也不做。
6. **v1 旁路不驱动推流 / 发券。** 不进规则引擎，不写 `ActionSignal`。将来若要挂钩，另开 ADR。

提猫（Electron + SenseVoice）只作工程参考，见 [`docs/research/competitors.md`](../research/competitors.md)。不复制它的产品范围。盯播不用 SenseVoice 出直播字幕。

上游 README 有自己的速度对比（相对 Whisper 的倍数）。那些数字不是本机盯播的延迟或 CPU。本仓不把它们写成验收，一律 `[TODO: 探针实测]`。

## 3. 非目标

探针阶段明确不做：

- 用 SenseVoice 替换或并联 FunASR / 讯飞，作为直播字幕。
- 把 SenseVoice 文本写进字幕区、规则窗口或动作提醒。旁路若带回文本，只许留在探针日志里对照，不上屏。
- 抬头屏徽章、灯条、字幕装饰。
- 推流 / 发券提醒改由笑声、音乐或情绪触发。
- 说话人分离。上游说明分离是 FSMN-VAD + CAM++ 的组合管线，不是 SenseVoiceSmall 检查点自身的输出。
- 用 SenseVoice 替换现有标点 sidecar。
- 修改已有 `session.jsonl` 的行类型。探针日志另文件。
- 把模型权重提交进 git。与 FunASR 权重同样留在本机。
- 在本 ADR 里锁定 WebSocket 方言、端口、token 或与 `funasr-protocol-bridge.md` 对等的成品协议。协议等到门槛通过、决定做 sidecar 时再写。

## 4. 架构草图

主链与旁路共用已有 PCM（ADR-004：单声道、16 kHz、S16LE）。旁路不第二路采音，不第二路 `getDisplayMedia`。

```text
PCM 缓冲（16 kHz mono S16LE，与主链同一份）
    │
    ├─ 主链（本 ADR 不改）
    │     FunASR sidecar 或 讯飞 RTASR
    │     → 字幕 / 话术规则 / 动作提醒
    │     → Control 与 Stage
    │
    └─ 旁路（探针；失败则整段消失）
          固定窗（建议 4s，hop 2s；见 §5）
          → 等待槽最多 1 个；槽满则丢更旧的等待窗（drop-old）
          → 进程外的 SenseVoiceSmall（不得放进 FunASR 进程）
          → EmotionEvent + AudioEvent
          → 探针 JSONL
          → （门槛通过之后才允许）Control 灯条 / 徽章
```

边界：

| | 主链 | 旁路 |
|--|------|------|
| 模型 | `paraformer-zh-streaming` 或讯飞 RTASR | SenseVoiceSmall 或探针选定的同等检查点 |
| 输入 | 20 ms 帧，流式 | 数秒整段，非流式 |
| 输出 | 字幕文本、`isFinal` | 情绪 1 个 + 音频事件 0..n。文本丢弃，不上字幕 |
| 失败 | 现有降级与重连（SDD §19 附近） | 静默。不改会话状态 |
| 表面 | Control + Stage | 将来只预留 Control。探针阶段无 UI |
| 进程 | 现有 FunASR sidecar / 讯飞连接 | 独立进程或仓外脚本。禁止塞进 FunASR 进程或它的 WebSocket |

探针阶段允许的最远形态：仓外脚本读一段已经录好的 PCM（或与一场正在跑的 FunASR 同时占用 CPU，但脚本不挂进 Electron）。这不是 sidecar，也没有 IPC。

## 5. 建议窗口

直播提示要在数秒内出现，所以上游「长音频转写」示例里的 30 秒窗 + 2 秒重叠只作对照行，不作为候选。那个示例服务整段转写，不服务盯播灯条。

| 候选 | 窗长 | hop | 重叠 | 角色 |
|------|------|-----|------|------|
| A（主候选） | 4 s | 2 s | 50% | 探针默认要跑完的一档 |
| B | 3 s | 1.5 s | 50% | 更早出提示，更容易把笑声切碎 |
| C | 5 s | 2.5 s | 50% | 更完整的事件，提示更晚 |
| D | 4 s | 4 s | 0 | 用来看重叠是否值得多花一倍推理 |
| 对照 | 30 s | 28 s | 2 s | 只记上游长音频切法的一行成本，不作为通过门槛 |

窗长时间戳用主链同一单调钟（ADR-007）。窗的 `startMs` / `endMs` 对齐这段 PCM 在会话里的位置，便于以后和字幕并排看，探针阶段不要求 UI。

切窗在旁路内完成。主链的 20 ms 帧和 `PcmFramer` 不改。运行时若要 float32，转换留在旁路进程里。

三档 3–5 秒都要留下 p50 / p95 / CPU / 丢窗率。通过哪一档，由填完的表决定，不在本文提前指定赢家。

## 6. 事件枚举草案

枚举对齐上游 README 的训练标签（`train_emo.txt` / `train_event.txt`），不是本机实测分布。检查点实际吐出的特殊 token 以探针清单的「标签盘点」为准；对不上就改枚举，不改实测。

情绪：一窗一个。取该窗里出现次数最多的情绪标签；平票记 `unknown`，并把原始标签留在 `rawTags`。

| 产品值 `EmotionEvent` | 上游标签 |
|------------------------|----------|
| `happy` | `<\|HAPPY\|>` |
| `sad` | `<\|SAD\|>` |
| `angry` | `<\|ANGRY\|>` |
| `neutral` | `<\|NEUTRAL\|>` |
| `fearful` | `<\|FEARFUL\|>` |
| `disgusted` | `<\|DISGUSTED\|>` |
| `surprised` | `<\|SURPRISED\|>` |
| `unknown` | `<\|EMO_UNKNOWN\|>`，或该窗没有情绪标签 |

音频事件：一窗零个或多个。上游训练列表是单标签，演示代码里同一段可能叠多个标签。探针按模型原文记录，不把「多个」提前收成一个。

| 产品值 `AudioEvent` | 上游标签 |
|---------------------|----------|
| `bgm` | `<\|BGM\|>` |
| `speech` | `<\|Speech\|>` |
| `applause` | `<\|Applause\|>` |
| `laughter` | `<\|Laughter\|>` |
| `cry` | `<\|Cry\|>` |
| `sneeze` | `<\|Sneeze\|>` |
| `breath` | `<\|Breath\|>` |
| `cough` | `<\|Cough\|>` |

上游演示用的格式化词典里还出现过 `<|Sing|>`、`<|Speech_Noise|>`、`<|GBG|>`、`<|Event_UNK|>`。它们不在上面的训练列表里。探针照实记入 `rawTags`，不进产品枚举，除非标签盘点证明这个检查点稳定输出它们。

将来 Control 灯条若做，只建议露出：`laughter`、`bgm`、`applause`，以及情绪 `happy` / `angry` / `sad`。`neutral`、`speech`、`breath` 默认不占灯条。其余标签只进 JSONL。这是产品过滤建议，不是探针的通过条件。探针通过条件看 §7，两路标签都要量。

置信度：上游标签本身不是校准过的概率。运行时若没有分值字段，就不新增 `confidence`。有分值再记，并在清单里写明字段名。不编造阈值。

探针日志草案（另文件，例如 `sessions/<sessionId>/sensevoice-probe.jsonl`；探针脚本也可以写到仓库外）。这不是 IPC，也不是 `session.jsonl` 的新行类型：

```json
{
  "type": "sensevoice_window",
  "sessionId": "",
  "windowStartMs": 0,
  "windowEndMs": 4000,
  "hopMs": 2000,
  "emotion": "neutral",
  "audioEvents": ["speech"],
  "rawTags": ["<|NEUTRAL|>", "<|Speech|>"],
  "latencyMs": null,
  "dropped": false
}
```

`latencyMs` 在填表前保持 null。不要用估计值代替实测。

## 7. 性能门槛

下列门槛是**建议通过线**，用来决定能不能开始写 sidecar。它们不是已经测到的成绩。每一格的实测见探针清单，未测写 `[TODO: 探针实测]`。

队列政策（drop-old）：

- 同时最多 1 个正在推理的窗，外加 1 个等待窗。
- 新窗到来且等待槽已满：丢掉等待槽里更旧的那一窗，保留最新窗，`dropped` 计数加一。
- 不中断已经开始的推理。
- 这条队列不在 PCM 采集线程上，也不在 FunASR / 讯飞的发送线程上。主链不等待旁路。

丢窗率 = 被丢掉的窗数 / 应切出的窗数。

| 项 | 怎么记 | 通过（可以开 sidecar 设计） | 不通过（停在探针） |
|----|--------|------------------------------|--------------------|
| 延迟 | 窗关闭 → 标签返回。记 p50 / p95 / max。条件写明是单独跑，还是旁边有一场 FunASR | 所选 hop 上 **p95 ≤ hop**。主候选 hop = 2000 ms 时，即 p95 ≤ 2000 ms | p95 > 2 × hop |
| CPU | 旁路进程平均与峰值，按单逻辑核 100% 计；同时记整机 CPU。采样 ≥ 10 分钟连续语音 | 旁路平均 ≤ 100（约一个逻辑核），且整机没有连续 30 秒 ≥ 90% 的同时主链字幕仍在走 | 旁路平均 > 150，或主链字幕 / ASR 队列因为旁路卡住 |
| 丢窗 | 按上面的 drop-old 计数 | ≤ 5% | > 20%。5%–20% 只在改用更长 hop 后重新通过时有条件通过 |
| 静默失败 | 缺权重、推理抛错、杀掉旁路进程 | 主链字幕与会话继续。旁路没有 UI、没有 `session:error` | 任何一种失败让字幕停、会话进 `error`，或开始按钮开始依赖 SenseVoice |
| 事件可用性 | 人工耳标小样本，见探针清单 | 音频事件抽检达到清单门槛 | 达不到。不改用「模型自己的文本」充当标签 |
| 情绪可用性 | 同上，与事件同一次探针 | 情绪抽检达到清单门槛 | 达不到。此时不自动改成「只做事件」或「只做情绪」，把「一起做」交回产品重开 |

中间地带（延迟介于 hop 与 2 × hop，或丢窗率 5%–20%）：换 B/C/D 中的一档再测。仍落在中间地带，就停在探针，不写 sidecar。

通过的含义只有一条：允许另开实现 PR，设计独立 sidecar。通过不等于功能已进 v1.0.0，也不等于可以上抬头屏或驱动动作提醒。

## 8. 失败方式

| 情况 | 旁路 | 主链 |
|------|------|------|
| 本机没有权重或加载失败 | 本场保持关闭 | 照常开始。不进 FunASR / 讯飞健康预检 |
| 单窗超时或推理异常 | 该窗无事件，错误计数加一 | 不重试这条 PCM，不回放给 ASR |
| 连续失败达到 3 次 | 本场剩余时间关闭旁路 | 会话状态不变 |
| 旁路进程崩溃 | 不拉起 FunASR，不复用它的端口 | 字幕继续。最多允许旁路自己再起一次；第二次仍失败则本场关闭 |
| 探针 JSONL 写失败 | 放弃本条，不阻塞 | `session.jsonl` 照常写 |
| 标签无法映射 | 记 `rawTags`，产品枚举位置写 `unknown` 或空数组 | 不上屏 |
| CPU 顶满 | 靠 drop-old 丢窗；丢窗率按 §7 判 | 采集与 ASR 发送不让出线程给旁路 |

探针阶段没有用户可见文案。不在 Stage 写「情绪不可用」，也不在 Control 用 toast 报旁路错误。

## 9. 探针结果要回答的问题

填完 [`sensevoice-probe.md`](../research/sensevoice-probe.md) 之前，下面这些保持开放：

1. 实际加载的是 `iic/SenseVoiceSmall`、`FunAudioLLM/SenseVoiceSmall`，还是别的检查点？修订号、磁盘体积、加载秒数是多少？
2. 运行时是 FunASR PyTorch、`funasr-onnx`，还是别的？本文不锁定。
3. 该检查点的特殊 token 是否等于 §6？多出来的标签有哪些？
4. A/B/C/D 哪一档同时过延迟、CPU、丢窗率？重叠（D 相对 A）是否值得？
5. 直播间背景音乐会不会让 `bgm` 长期为真，使灯条失去意义？
6. 带货口播上的情绪标签是否稳，还是只在表演式语料上稳？不稳则 §7 情绪行不通过。
7. 与一场真实 FunASR 流式会话同时跑时，主链字幕有没有变慢？变慢多少（`[TODO: 探针实测]`）？
8. 所选运行时有没有分值字段？没有就保持无 `confidence`。
9. macOS 若跑了，数字与 Windows 差多少？没跑不否决 Windows 结论，只记平台风险。
10. 权重许可是否允许随应用分发？探针阶段不分发，这个问题只记录，不在本文作决定。

## 10. 后果

- PRD §9.1 的流式 ASR 行改为：SenseVoice 是 v1.x 旁路补充，探针中，不进本版验收。
- SDD ADR 摘要增加 ADR-018 一行，指向本文。默认 ASR 仍是 ADR-005。
- 现有 `docs/sdd/funasr-protocol-bridge.md` 继续只描述 FunASR 字幕桥。SenseVoice 不往那份协议里加 `svs_lang` 或情绪字段。
- 门槛通过之后的下一份设计才允许写：独立进程怎么启动、结果怎么进主进程、Control 灯条的具体位置。那份设计仍然不能改主链 ASR。
