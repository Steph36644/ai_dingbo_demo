"""标点 cache 与 stub。不下载权重，不 import funasr。"""

from __future__ import annotations

import sys
from pathlib import Path

import punc
from punc import (
    OFFLINE_PUNC_ID,
    REALTIME_PUNC_ID,
    PunctuationHost,
    StreamingPunctuator,
    text_of,
)


def _expect_error(fn, exc: type[BaseException]) -> None:
    try:
        fn()
    except exc:
        return
    raise AssertionError(f"expected {exc.__name__}")


def test_import_punc_does_not_import_funasr() -> None:
    assert "funasr" not in sys.modules
    assert "modelscope" not in sys.modules
    assert "torch" not in sys.modules
    source = Path(punc.__file__).read_text(encoding="utf-8")
    assert "from funasr import AutoModel" in source
    assert 'device="cpu"' in source
    assert REALTIME_PUNC_ID in source
    assert OFFLINE_PUNC_ID in source
    assert "snapshot_download" not in source


def test_text_of_keeps_leading_punctuation() -> None:
    assert text_of([{"text": "。我们"}, {"text": "继续"}]) == "。我们继续"
    assert text_of({"text": "你好。"}) == "你好。"
    assert text_of("直接") == "直接"
    _expect_error(lambda: text_of({"text": 1}), TypeError)
    _expect_error(lambda: text_of(3), TypeError)


def test_realtime_reuses_one_cache_and_keeps_spill() -> None:
    holder: dict = {}

    def generate(text: str, cache: dict) -> list[dict[str, str]]:
        assert cache is holder["cache"]
        cache["n"] = cache.get("n", 0) + 1
        prefix = cache.pop("spill", "")
        if "价" in text:
            cache["spill"] = "。"
            return [{"text": prefix + text}]
        return [{"text": prefix + text + "。"}]

    cache: dict = {}
    holder["cache"] = cache
    punctuator = StreamingPunctuator(generate, cache=cache)
    first = punctuator.punctuate("今天讲价", "realtime")
    assert first["ok"] is True
    assert first["text"] == "今天讲价"
    assert cache["spill"] == "。"
    assert cache["n"] == 1
    second = punctuator.punctuate("下一句", "realtime")
    assert second["text"] == "。下一句。"
    assert punctuator.cache is cache
    assert cache["n"] == 2
    assert "spill" not in cache


def test_reset_replaces_cache_and_optional_cache_is_kept() -> None:
    seen: list[dict] = []

    def generate(text: str, cache: dict) -> str:
        seen.append(cache)
        cache["used"] = text
        return text

    punctuator = StreamingPunctuator(generate)
    punctuator.punctuate("甲", "realtime")
    first = punctuator.cache
    assert first.get("used") == "甲"
    punctuator.punctuate("乙", "realtime", reset=True)
    assert punctuator.cache is not first
    assert "used" in punctuator.cache
    assert first.get("used") == "甲"
    external = {"seed": 1}
    punctuator.punctuate("丙", "realtime", cache=external)
    assert punctuator.cache is external
    assert external["used"] == "丙"


def test_offline_does_not_require_realtime_cache() -> None:
    def realtime(text: str, cache: dict) -> str:
        raise AssertionError("offline 不应调用实时模型")

    def offline(text: str) -> dict[str, str]:
        return {"text": text + "。"}

    punctuator = StreamingPunctuator(realtime, offline)
    punctuator.cache["keep"] = True
    result = punctuator.punctuate("全文没有句号", "offline")
    assert result == {"ok": True, "text": "全文没有句号。", "mode": "offline", "detail": ""}
    assert punctuator.cache == {"keep": True}
    missing = StreamingPunctuator(realtime, None)
    skipped = missing.punctuate("全文", "offline")
    assert skipped["ok"] is False
    assert skipped["text"] == "全文"
    assert skipped["detail"] == "离线标点不可用"


def test_empty_text_does_not_call_model() -> None:
    def generate(text: str, cache: dict) -> str:
        raise AssertionError("空文本不应调用模型")

    punctuator = StreamingPunctuator(generate)
    assert punctuator.punctuate("", "realtime")["text"] == ""
    assert punctuator.punctuate("", "offline")["ok"] is True


def test_stub_host_reports_model_unavailable() -> None:
    host = PunctuationHost(stub=True)
    host.kickoff()
    result = host.session().punctuate("你好", "realtime", False, None)
    assert result["ok"] is False
    assert result["text"] == "你好"
    assert result["detail"] == "未加载标点模型"
    assert host.models is None
    assert "funasr" not in sys.modules


def test_model_failure_returns_original_text() -> None:
    def generate(text: str, cache: dict) -> str:
        raise RuntimeError("boom")

    result = StreamingPunctuator(generate).punctuate("原文", "realtime")
    assert result["ok"] is False
    assert result["text"] == "原文"
    assert "boom" in result["detail"]


def main() -> None:
    tests = [value for name, value in globals().items() if name.startswith("test_") and callable(value)]
    for test in tests:
        test()
    print(f"funasr punc fixtures ok ({len(tests)})")


if __name__ == "__main__":
    main()
