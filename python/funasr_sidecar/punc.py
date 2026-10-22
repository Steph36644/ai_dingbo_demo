"""FunASR 标点。导入本模块不会下载模型，也不会 import funasr。

实时模型必须复用同一份 cache。标点可能出现在下一块开头，调用方不要 strip。
停播时若本机已经有离线 ct-punc 权重，可以再跑全文；没有权重就不下载。
`--stub` 不加载模型，标点请求返回失败，字幕退回原文。
"""

from __future__ import annotations

import threading
from pathlib import Path
from typing import Any, Callable

REALTIME_PUNC_ID = "iic/punc_ct-transformer_zh-cn-common-vad_realtime-vocab272727"
OFFLINE_PUNC_ID = "ct-punc"
OFFLINE_DIR_MARK = "punc_ct-transformer_zh-cn-common-vocab272727"

RealtimeGenerate = Callable[[str, dict[str, Any]], object]
OfflineGenerate = Callable[[str], object]


def text_of(payload: object) -> str:
    """取出标点文本。不 strip，保留块首标点。"""
    if isinstance(payload, str):
        return payload
    if isinstance(payload, list):
        return "".join(text_of(item) for item in payload)
    if isinstance(payload, dict):
        text = payload.get("text", "")
        if not isinstance(text, str):
            raise TypeError("text 必须是字符串")
        return text
    raise TypeError("标点结果必须是字符串或对象")


class StreamingPunctuator:
    """一份模型入口，一份 cache。实时调用复用 cache；离线调用不碰它。"""

    def __init__(
        self,
        realtime: RealtimeGenerate,
        offline: OfflineGenerate | None = None,
        cache: dict[str, Any] | None = None,
    ) -> None:
        self._realtime = realtime
        self._offline = offline
        self.cache: dict[str, Any] = cache if isinstance(cache, dict) else {}

    def punctuate(
        self,
        text: str,
        mode: str = "realtime",
        reset: bool = False,
        cache: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        if not isinstance(text, str):
            raise TypeError("text 必须是字符串")
        if mode not in {"realtime", "offline"}:
            raise ValueError("mode 只能是 realtime 或 offline")
        if reset:
            self.cache = {}
        if isinstance(cache, dict):
            self.cache = cache
        if text == "":
            return {"ok": True, "text": "", "mode": mode, "detail": ""}
        try:
            if mode == "offline":
                if self._offline is None:
                    return {"ok": False, "text": text, "mode": mode, "detail": "离线标点不可用"}
                rendered = text_of(self._offline(text))
            else:
                rendered = text_of(self._realtime(text, self.cache))
        except Exception as exc:
            return {"ok": False, "text": text, "mode": mode, "detail": f"标点失败：{exc}"}
        return {"ok": True, "text": rendered, "mode": mode, "detail": ""}


class PunctuationSession:
    def __init__(self, host: "PunctuationHost") -> None:
        self.host = host
        self.punctuator: StreamingPunctuator | None = None

    def punctuate(
        self,
        text: str,
        mode: str = "realtime",
        reset: bool = False,
        cache: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        if not isinstance(text, str):
            text = ""
        if self.host.stub:
            return {"ok": False, "text": text, "mode": mode if mode in {"realtime", "offline"} else "realtime", "detail": "未加载标点模型"}
        if self.punctuator is None:
            models = self.host.models
            if models is None:
                if not self.host.error:
                    self.host.kickoff()
                detail = self.host.error or "标点模型加载中"
                return {"ok": False, "text": text, "mode": mode if mode in {"realtime", "offline"} else "realtime", "detail": detail}
            self.punctuator = StreamingPunctuator(models.realtime, models.offline)
        return self.punctuator.punctuate(text, mode, reset, cache)


class PuncModels:
    def __init__(self, realtime: RealtimeGenerate, offline: OfflineGenerate | None) -> None:
        self.realtime = realtime
        self.offline = offline


class PunctuationHost:
    """进程内一份模型。每个盯播会话再持有自己的 cache。"""

    def __init__(self, *, stub: bool) -> None:
        self.stub = stub
        self.models: PuncModels | None = None
        self.error: str | None = None
        self._loading = False
        self._lock = threading.Lock()

    def session(self) -> PunctuationSession:
        return PunctuationSession(self)

    def kickoff(self) -> None:
        if self.stub or self.models is not None or self.error or self._loading:
            return
        with self._lock:
            if self.stub or self.models is not None or self.error or self._loading:
                return
            self._loading = True
            threading.Thread(target=self._load, name="funasr-punc", daemon=True).start()

    def _load(self) -> None:
        try:
            self.models = load_punc_models()
        except Exception as exc:
            self.error = f"加载标点模型失败：{exc}"
        finally:
            self._loading = False


def offline_weights_present(cache_dir: str | None = None) -> bool:
    """离线 ct-punc 的目录名不含 realtime。没有权重就不要在停播时下载。"""
    from engine import resolve_cache_dir

    root = resolve_cache_dir(cache_dir)
    if not root.exists():
        return False
    return _has_offline_dir(root, 6)


def load_punc_models(cache_dir: str | None = None) -> PuncModels:
    """加载实时标点。离线模型仅在权重已经在本机时加载。只在调用时 import funasr。"""
    from engine import configure_cache_dir

    configure_cache_dir(cache_dir)
    from funasr import AutoModel

    realtime_model = AutoModel(model=REALTIME_PUNC_ID, device="cpu", disable_update=True)

    def realtime(text: str, cache: dict[str, Any]) -> object:
        return realtime_model.generate(input=text, cache=cache)

    offline_fn: OfflineGenerate | None = None
    if offline_weights_present(cache_dir):
        try:
            offline_model = AutoModel(model=OFFLINE_PUNC_ID, device="cpu", disable_update=True)

            def offline(text: str) -> object:
                return offline_model.generate(input=text)

            offline_fn = offline
        except Exception:
            offline_fn = None
    return PuncModels(realtime, offline_fn)


def _has_offline_dir(root: Path, depth: int) -> bool:
    if depth < 0 or not root.is_dir():
        return False
    name = root.name
    if "realtime" not in name and OFFLINE_DIR_MARK in name:
        return True
    try:
        children = list(root.iterdir())
    except OSError:
        return False
    return any(child.is_dir() and _has_offline_dir(child, depth - 1) for child in children)
