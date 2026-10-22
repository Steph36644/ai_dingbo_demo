"""CPU 上的 paraformer-zh-streaming。

导入本模块不会下载模型，也不会 import funasr。真正的加载在 `load_cpu_model`。
权重目录默认是用户主目录下的 `~/.cache/modelscope`，拒绝落在仓库里面。
"""

from __future__ import annotations

import asyncio
import os
import re
import struct
import traceback
from pathlib import Path
from typing import Any, Callable

from bridge import automodel_generate_kwargs, to_dingbo_result

MODEL_ID = "paraformer-zh-streaming"
_CORE_MODULES = {
    "torch",
    "torchaudio",
    "numpy",
    "typing_extensions",
    "modelscope",
    "omegaconf",
    "yaml",
    "scipy",
    "librosa",
    "soundfile",
}
SAMPLE_RATE = 16_000
BYTES_PER_SAMPLE = 2
BYTES_PER_MS = SAMPLE_RATE * BYTES_PER_SAMPLE // 1000
CHUNK_MS = 600
CHUNK_BYTES = CHUNK_MS * BYTES_PER_MS

Generate = Callable[[list[float], dict[str, Any], dict[str, Any]], object]


def repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def resolve_cache_dir(cache_dir: str | None = None) -> Path:
    raw = cache_dir or os.environ.get("FUNASR_CACHE_DIR") or os.environ.get("MODELSCOPE_CACHE")
    path = Path(raw).expanduser().resolve() if raw else Path.home() / ".cache" / "modelscope"
    path = path.resolve()
    root = repo_root()
    if path == root or root in path.parents:
        raise RuntimeError(f"模型缓存必须放在仓库外，当前是 {path}")
    return path


def configure_cache_dir(cache_dir: str | None = None) -> str:
    path = resolve_cache_dir(cache_dir)
    path.mkdir(parents=True, exist_ok=True)
    os.environ["MODELSCOPE_CACHE"] = str(path)
    os.environ["FUNASR_CACHE_DIR"] = str(path)
    hf_home = Path(os.environ.get("HF_HOME", Path.home() / ".cache" / "huggingface")).expanduser().resolve()
    root = repo_root()
    if hf_home == root or root in hf_home.parents:
        hf_home = Path.home() / ".cache" / "huggingface"
    os.environ["HF_HOME"] = str(hf_home)
    return str(path)


def pcm_s16le_to_float32(pcm: bytes) -> list[float]:
    even = pcm[: len(pcm) - (len(pcm) % BYTES_PER_SAMPLE)]
    if not even:
        return []
    count = len(even) // BYTES_PER_SAMPLE
    samples = struct.unpack("<" + "h" * count, even)
    return [sample / 32768.0 for sample in samples]


class ModelService:
    """持有一次加载后的 generate。流式参数一律走 bridge.automodel_generate_kwargs。"""

    def __init__(self, model_id: str, generate: Generate) -> None:
        self.model_id = model_id
        self._generate = generate

    def generate(self, waveform: list[float], cache: dict[str, Any], *, is_final: bool) -> object:
        kwargs = automodel_generate_kwargs(is_final=is_final)
        return self._generate(waveform, cache, kwargs)


class StreamingSession:
    """把盯播 PCM 按 600ms 步长送给 AutoModel，再译成盯播 result。"""

    def __init__(self, service: ModelService, session_id: str) -> None:
        self.service = service
        self.session_id = session_id
        self.cache: dict[str, Any] = {}
        self.pending = bytearray()
        self.pending_ms = 0
        self.emitted_ms = 0
        self.index = 0
        self.saw_audio = False
        self.finalized = False

    def accept_pcm(self, pcm: bytes, duration_ms: int) -> list[dict[str, Any]]:
        if duration_ms < 0:
            raise ValueError("durationMs 不能为负")
        self.pending.extend(pcm)
        self.pending_ms += duration_ms
        if pcm or duration_ms:
            self.saw_audio = True
            self.finalized = False
        results: list[dict[str, Any]] = []
        while len(self.pending) >= CHUNK_BYTES and self.pending_ms >= CHUNK_MS:
            chunk = bytes(self.pending[:CHUNK_BYTES])
            del self.pending[:CHUNK_BYTES]
            self.pending_ms -= CHUNK_MS
            results.extend(self._infer(chunk, is_final=False, step_ms=CHUNK_MS))
        return results

    def flush(self) -> list[dict[str, Any]]:
        if not self.saw_audio or self.finalized:
            return []
        self.finalized = True
        chunk = bytes(self.pending)
        step_ms = self.pending_ms
        self.pending.clear()
        self.pending_ms = 0
        results = self._infer(chunk, is_final=True, step_ms=step_ms)
        self.cache = {}
        return results

    def _infer(self, pcm: bytes, *, is_final: bool, step_ms: int) -> list[dict[str, Any]]:
        start = self.emitted_ms
        end = start + max(0, step_ms)
        self.emitted_ms = end
        self.index += 1
        payload = self.service.generate(pcm_s16le_to_float32(pcm), self.cache, is_final=is_final)
        # 这个流式模型每个块的 text 是新的一段，不会回头改前一块。
        # 盯播缓冲只留一条 partial，所以非空块直接落成 final，分析才能用上整句。
        result = to_dingbo_result(
            payload,
            session_id=self.session_id,
            start_ms=start,
            end_ms=end,
            provider_result_id=f"{self.service.model_id}-{self.index}",
            automodel_is_final=True,
        )
        if result["text"] == "":
            return []
        return [result]


def short_load_error(model_id: str, exc: BaseException) -> str:
    """把加载异常压成一句可展示的短话；完整堆栈只进 stderr。"""
    text = str(exc)
    roots = [name.split(".")[0] for name in re.findall(r"No module named ['\"]([\w.]+)", text)]
    module = next((name for name in roots if name in _CORE_MODULES), None) or next(
        (name for name in roots if name != "funasr"), None
    )
    if re.search(r"model(?:\s+'[^']+')?\s+is not registered", text, re.IGNORECASE):
        if module and module != "funasr":
            return f"本地识别模型加载失败：缺少 {module} 依赖，请修复 FunASR 环境后重试。"
        return "本地识别模型加载失败，请检查 FunASR 环境或模型下载后重试。"
    if "download" in text.lower() and "failed" in text.lower():
        return "本地识别模型下载失败，请检查网络后重试。"
    if module and module != "funasr":
        return f"缺少 Python 依赖 {module}，请安装后重试。"
    first_line = next((line.strip() for line in text.splitlines() if line.strip()), "")
    if not first_line:
        return f"加载 {model_id} 失败，请重试。"
    return f"加载 {model_id} 失败：{first_line[:80]}"


class Runtime:
    def __init__(self, *, stub: bool, loader: Callable[[str], ModelService] | None = None) -> None:
        self.stub = stub
        self.model_id = "stub" if stub else MODEL_ID
        self.service: ModelService | None = None
        self.error: str | None = None
        self.loaded = stub
        self.loader = loader or load_cpu_model
        self.settled: asyncio.Event | None = None

    def arm(self) -> None:
        if self.settled is None:
            self.settled = asyncio.Event()
        if self.stub or self.loaded or self.error:
            self.settled.set()

    def preload(self, service: ModelService) -> None:
        self.service = service
        self.model_id = service.model_id
        self.loaded = True
        self.error = None
        self.stub = False
        if self.settled is not None:
            self.settled.set()

    async def load(self) -> None:
        self.arm()
        if self.stub or self.loaded:
            return
        try:
            service = await _to_thread(self.loader, self.model_id)
            self.service = service
            self.model_id = service.model_id
            self.loaded = True
        except Exception as exc:
            traceback.print_exc()
            self.error = short_load_error(self.model_id, exc)
        finally:
            self.arm()
            assert self.settled is not None
            self.settled.set()

    def health_message(self) -> dict[str, Any]:
        if self.stub:
            return {"type": "health", "ok": True, "model": "stub", "detail": "FunASR 骨架在听，未加载模型"}
        if self.error:
            return {"type": "health", "ok": False, "model": self.model_id, "detail": self.error}
        if self.loaded and self.service is not None:
            return {
                "type": "health",
                "ok": True,
                "model": self.model_id,
                "detail": f"已加载 {self.model_id}（CPU）",
            }
        return {
            "type": "health",
            "ok": False,
            "model": self.model_id,
            "detail": f"正在加载 {self.model_id}（CPU）",
        }

    def ready_message(self) -> dict[str, Any]:
        if self.stub:
            return {"type": "ready", "model": "stub", "detail": "未加载模型，仅验证协议"}
        return {"type": "ready", "model": self.model_id, "detail": f"已加载 {self.model_id}（CPU）"}


def load_cpu_model(model_id: str = MODEL_ID, cache_dir: str | None = None) -> ModelService:
    """加载流式 Paraformer。只在调用时 import funasr，设备固定为 CPU。"""
    if model_id != MODEL_ID:
        raise ValueError(f"F1 只加载 {MODEL_ID}")
    configure_cache_dir(cache_dir)
    import numpy as np
    from funasr import AutoModel

    model = AutoModel(model=model_id, device="cpu", disable_update=True)

    def generate(waveform: list[float], cache: dict[str, Any], kwargs: dict[str, Any]) -> object:
        speech = np.asarray(waveform, dtype=np.float32)
        if speech.ndim != 1:
            speech = speech.reshape(-1)
        if speech.size == 0 and kwargs.get("is_final") is True:
            speech = np.zeros(160, dtype=np.float32)
        return model.generate(input=speech, cache=cache, batch_size=1, **kwargs)

    return ModelService(model_id, generate)


async def _to_thread(func: Callable[[str], ModelService], model_id: str) -> ModelService:
    return await asyncio.to_thread(func, model_id)
