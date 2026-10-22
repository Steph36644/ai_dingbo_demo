# FunASR sidecar

主进程和 sidecar 之间继续说盯播方言。F1 默认在 CPU 上加载 `paraformer-zh-streaming`。`--stub` 不下载、不加载模型，只回骨架文本。

```bash
python3 python/funasr_sidecar/server.py --host 127.0.0.1 --port 8765 --token dev-token --stub
python3 python/funasr_sidecar/test_bridge.py
python3 python/funasr_sidecar/test_engine.py
python3 python/funasr_sidecar/test_punc.py
```

真实模型还要本机安装 CPU 版 PyTorch 和 `funasr`。权重默认进 `~/.cache/modelscope`，也可以用 `FUNASR_CACHE_DIR` 或 `--cache-dir` 指到仓库外面的目录。仓库内的缓存路径会被拒绝。不要把权重量进 git。

## 桥的边界

`health` / `start` / `flush` / `stop` / `punctuate`、长度前缀 PCM、`isFinal`、一次性 `token`，并且只绑定 `127.0.0.1`。`FunAsrAdapter` 的 AsrAdapter 方法签名不变。`punctuate` 只服务展示层标点。

`bridge.py` 做字段翻译，`engine.py` 按 600ms 步长调用它：

- `string[]` 热词 → runtime `hotwords` 加权 JSON 字符串（先记在连接上，流式模型不直接吃这份字符串）
- 剥掉盯播 PCM 头，留下 raw PCM，再转成 float32
- 流式模型每个块的新文本直接落成盯播 `result.isFinal = true`（缓冲只留一条 partial）
- `flush` 时 `generate(is_final=true)` 冲刷句尾，有字也是 final

加载成功后，`health` 和 `ready` 的 `model` 是 `paraformer-zh-streaming`。加载失败时 `ok` 为 false，不会拿骨架句子冒充转写。`--stub` 时 `model` 仍是 `stub`，文本标明「未加载模型」。

流式参数是 `chunk_size [0, 10, 5]`，和 runtime WebSocket 示例里的 `[5, 10, 5]` 不是同一组默认值。字段说明见 `docs/sdd/funasr-protocol-bridge.md`。

## 盯播侧约束

- 只绑定 `127.0.0.1`。传入其他 host 会直接退出。
- `health` / `start` 必须带相同的一次性 `token`。主进程通过环境变量 `FUNASR_SIDECAR_TOKEN` 传入，不放进命令行。令牌不写日志、不进渲染进程。
- 文本控制帧是 JSON：`health`、`start`、`flush`、`stop`、`punctuate`。
- `punctuate` 在 `start` 之后发送原文，回 `punctuated`。实时路径复用同一份 cache。`--stub` 不加载标点模型，回失败和原文。停播的离线全文只在本机已有 `ct-punc` 权重时运行。
- 音频是二进制帧：4 字节大端 header 长度 + JSON header（`type/sessionId/seq/startMs/durationMs`）+ PCM S16LE。
- 服务端回 `ready`、`result`（partial/final）、`error`。`--stub` 时 `result.text` 会标明「未加载模型」。真实模型加载成功后，`result.text` 来自 `paraformer-zh-streaming`。
