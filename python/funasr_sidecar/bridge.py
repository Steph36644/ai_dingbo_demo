"""盯播 WebSocket 方言与官方 FunASR 之间的纯翻译。

这里没有模型、没有网络、没有 FunASR 依赖。`server.py` 对主进程仍只说盯播方言。
非 stub 的 sidecar 加载 `paraformer-zh-streaming` 时调用本模块翻译字段。

字段含义见 `docs/sdd/funasr-protocol-bridge.md`。
官方说明：https://github.com/modelscope/FunASR/blob/main/runtime/docs/websocket_protocol_zh.md
"""

from __future__ import annotations

import json
import struct
from typing import Any

# 官方 runtime WebSocket 示例。每个数是 60ms；[5, 10, 5] 表示当前 600ms，回看 300ms，前看 300ms。
WS_CHUNK_SIZE = (5, 10, 5)
# AutoModel `paraformer-zh-streaming` 示例。与 runtime WS 的 chunk_size 不是同一组默认值。
AUTOMODEL_CHUNK_SIZE = (0, 10, 5)
AUTOMODEL_ENCODER_CHUNK_LOOK_BACK = 4
AUTOMODEL_DECODER_CHUNK_LOOK_BACK = 1
DEFAULT_HOTWORD_WEIGHT = 20

ONLINE_MODES = frozenset({"online", "2pass-online"})
OFFLINE_MODES = frozenset({"offline", "2pass-offline"})


def hotwords_to_weighted_json(hotwords: object = None, weight: int = DEFAULT_HOTWORD_WEIGHT) -> str:
    """把盯播 `string[]` 译成官方 `hotwords` 字段的值。

    返回值是 JSON 对象的紧凑字符串，例如 `'{"阿里巴巴":20}'`。
    官方客户端把这个字符串放进文本帧，字段类型是 string，不是 object。
    空列表和缺省都得到 `"{}"`。重复词保留第一次出现的顺序。权重对列表里每个词相同，
    因为盯播上游只有字符串，没有逐词权重。
    """
    if hotwords is None:
        words: list[object] = []
    elif isinstance(hotwords, list):
        words = hotwords
    else:
        raise TypeError("热词必须是字符串数组")
    resolved = _positive_int(weight, "热词权重")
    weighted: dict[str, int] = {}
    for item in words:
        if not isinstance(item, str):
            raise TypeError("热词必须是字符串")
        word = item.strip()
        if not word or word in weighted:
            continue
        weighted[word] = resolved
    return json.dumps(weighted, ensure_ascii=False, separators=(",", ":"))


def strip_pcm_header(payload: bytes | bytearray | memoryview) -> tuple[dict[str, Any], bytes]:
    """剥掉盯播二进制帧的长度头，留下官方 FunASR 要的 raw PCM。

    布局与 `encodeAudioMessage` / `server.py` 一致：4 字节大端 header 长度 + UTF-8 JSON + PCM S16LE。
    不检查 `durationMs`，时长仍由 sidecar 按盯播头或 PCM 字节数计算。
    """
    if not isinstance(payload, (bytes, bytearray, memoryview)):
        raise TypeError("音频帧必须是 bytes")
    raw = bytes(payload)
    if len(raw) < 4:
        raise ValueError("音频帧过短")
    header_len = struct.unpack("!I", raw[:4])[0]
    if header_len <= 0 or 4 + header_len > len(raw):
        raise ValueError("音频帧头长度非法")
    header = json.loads(raw[4 : 4 + header_len].decode("utf-8"))
    if not isinstance(header, dict):
        raise ValueError("音频帧头不是对象")
    return header, raw[4 + header_len :]


def is_final_from_mode(mode: str) -> bool:
    """由官方 `mode` 得到盯播 `isFinal`。

    `online` / `2pass-online` 是实时片段，`isFinal` 为 false。
    `offline` / `2pass-offline` 是一句的确定文本，`isFinal` 为 true。
    不读取官方结果里的 `is_final`。那个字段表示识别是否结束，和盯播的分段提交不是同一件事。
    """
    if not isinstance(mode, str):
        raise TypeError("mode 必须是字符串")
    if mode in ONLINE_MODES:
        return False
    if mode in OFFLINE_MODES:
        return True
    raise ValueError(f"无法识别的 FunASR mode: {mode}")


def to_dingbo_result(
    payload: object,
    *,
    session_id: str,
    start_ms: int,
    end_ms: int,
    provider_result_id: str,
    automodel_is_final: bool | None = None,
    confidence: float | None = None,
) -> dict[str, Any]:
    """把官方 WS 结果或 AutoModel `generate` 输出译成盯播 `result`。

    有 `mode` 时按 online/offline 决定 `isFinal`。没有 `mode` 时，用调用
    `generate(..., is_final=)` 的那个布尔值，不能改用结果对象里的 `is_final`。
    `startMs` / `endMs` 由调用方按盯播音频时钟传入。官方 `timestamp` 不写入结果。
    """
    if not isinstance(session_id, str) or session_id == "":
        raise ValueError("sessionId 不能为空")
    if not isinstance(provider_result_id, str) or provider_result_id == "":
        raise ValueError("providerResultId 不能为空")
    start = _non_negative_int(start_ms, "startMs")
    end = _non_negative_int(end_ms, "endMs")
    if end < start:
        raise ValueError("endMs 不能小于 startMs")

    mode, text = _mode_and_text(payload)
    if mode is not None:
        if automodel_is_final is not None:
            raise ValueError("官方 mode 与 AutoModel is_final 不能同时给出")
        is_final = is_final_from_mode(mode)
    else:
        if not isinstance(automodel_is_final, bool):
            raise ValueError("没有 mode 时必须给出 AutoModel is_final")
        is_final = automodel_is_final

    result: dict[str, Any] = {
        "type": "result",
        "sessionId": session_id,
        "providerResultId": provider_result_id,
        "startMs": start,
        "endMs": end,
        "text": text,
        "isFinal": is_final,
    }
    if confidence is not None:
        if isinstance(confidence, bool) or not isinstance(confidence, (int, float)):
            raise TypeError("confidence 必须是数字")
        result["confidence"] = confidence
    return result


def ws_start_message(
    session_id: str,
    hotwords: object = None,
    *,
    sample_rate: int = 16000,
    itn: bool = True,
    weight: int = DEFAULT_HOTWORD_WEIGHT,
) -> dict[str, Any]:
    """盯播 `start` 译成官方 runtime WebSocket 的首包。F0 不发送这包。"""
    if not isinstance(session_id, str) or session_id == "":
        raise ValueError("wav_name 不能为空")
    if isinstance(sample_rate, bool) or sample_rate not in (8000, 16000):
        raise ValueError("audio_fs 只接受 8000 或 16000")
    if not isinstance(itn, bool):
        raise TypeError("itn 必须是布尔值")
    return {
        "mode": "2pass",
        "wav_name": session_id,
        "is_speaking": True,
        "wav_format": "pcm",
        "chunk_size": list(WS_CHUNK_SIZE),
        "audio_fs": sample_rate,
        "hotwords": hotwords_to_weighted_json(hotwords, weight),
        "itn": itn,
    }


def ws_end_message() -> dict[str, bool]:
    """盯播 `flush` / 句尾对应的官方结束标志。F0 不发送这包。"""
    return {"is_speaking": False}


def automodel_generate_kwargs(*, is_final: bool) -> dict[str, Any]:
    """F1 调用 `paraformer-zh-streaming` 时每次 `generate` 要带的流式参数。

    不包含音频，也不创建模型。`cache` 由调用方按会话持有，不放进这个字典，避免被误当成全局缓存。
    """
    if not isinstance(is_final, bool):
        raise TypeError("is_final 必须是布尔值")
    return {
        "is_final": is_final,
        "chunk_size": list(AUTOMODEL_CHUNK_SIZE),
        "encoder_chunk_look_back": AUTOMODEL_ENCODER_CHUNK_LOOK_BACK,
        "decoder_chunk_look_back": AUTOMODEL_DECODER_CHUNK_LOOK_BACK,
    }


def _mode_and_text(payload: object) -> tuple[str | None, str]:
    if isinstance(payload, list):
        parts = [_text_of(item) for item in payload]
        return None, "".join(parts)
    if isinstance(payload, dict):
        mode = payload.get("mode")
        if mode is not None and not isinstance(mode, str):
            raise TypeError("mode 必须是字符串")
        return mode, _text_of(payload)
    raise TypeError("识别结果必须是对象或对象数组")


def _text_of(payload: object) -> str:
    if not isinstance(payload, dict):
        raise TypeError("识别结果项必须是对象")
    text = payload.get("text", "")
    if not isinstance(text, str):
        raise TypeError("text 必须是字符串")
    return text


def _positive_int(value: object, label: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise ValueError(f"{label}必须是正整数")
    return value


def _non_negative_int(value: object, label: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValueError(f"{label}必须是非负整数")
    return value
