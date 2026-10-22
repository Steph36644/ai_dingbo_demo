"""协议桥 fixture。不导入 funasr，不访问网络。"""

from __future__ import annotations

import json
import struct
import sys
from pathlib import Path

import bridge
from bridge import (
    AUTOMODEL_CHUNK_SIZE,
    WS_CHUNK_SIZE,
    automodel_generate_kwargs,
    hotwords_to_weighted_json,
    is_final_from_mode,
    strip_pcm_header,
    to_dingbo_result,
    ws_end_message,
    ws_start_message,
)

ROOT = Path(__file__).resolve().parent
FIXTURE = ROOT / "fixtures" / "mapping_cases.json"


def _cases() -> dict:
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


def _expect_error(fn, exc: type[BaseException]) -> None:
    try:
        fn()
    except exc:
        return
    raise AssertionError(f"expected {exc.__name__}")


def test_fixture_file_exists() -> None:
    data = _cases()
    assert data["hotwords"]
    assert data["results"]
    assert data["wsStart"]


def test_hotwords_match_fixture() -> None:
    for case in _cases()["hotwords"]:
        weight = case.get("weight", 20)
        assert hotwords_to_weighted_json(case["input"], weight) == case["expected"]
        parsed = json.loads(case["expected"])
        assert isinstance(parsed, dict)


def test_hotwords_escape_and_reject_bad_input() -> None:
    assert hotwords_to_weighted_json(None) == "{}"
    encoded = hotwords_to_weighted_json(['他说"好"'], 30)
    assert json.loads(encoded) == {'他说"好"': 30}
    wire = json.dumps({"hotwords": encoded}, ensure_ascii=False)
    assert json.loads(json.loads(wire)["hotwords"]) == {'他说"好"': 30}
    _expect_error(lambda: hotwords_to_weighted_json("直播间"), TypeError)
    _expect_error(lambda: hotwords_to_weighted_json([1]), TypeError)
    _expect_error(lambda: hotwords_to_weighted_json(["词"], 0), ValueError)
    _expect_error(lambda: hotwords_to_weighted_json(["词"], True), ValueError)


def test_results_match_fixture_and_drop_official_fields() -> None:
    for case in _cases()["results"]:
        kwargs = {}
        if "automodelIsFinal" in case:
            kwargs["automodel_is_final"] = case["automodelIsFinal"]
        actual = to_dingbo_result(
            case["payload"],
            session_id=case["sessionId"],
            start_ms=case["startMs"],
            end_ms=case["endMs"],
            provider_result_id=case["providerResultId"],
            **kwargs,
        )
        assert actual == case["expected"]
        assert "mode" not in actual
        assert "is_final" not in actual
        assert "timestamp" not in actual
        assert "stamp_sents" not in actual
        assert "wav_name" not in actual


def test_mode_polarity() -> None:
    assert is_final_from_mode("online") is False
    assert is_final_from_mode("2pass-online") is False
    assert is_final_from_mode("offline") is True
    assert is_final_from_mode("2pass-offline") is True
    _expect_error(lambda: is_final_from_mode("2pass"), ValueError)
    _expect_error(
        lambda: to_dingbo_result(
            {"mode": "2pass-online", "text": "甲"},
            session_id="sid",
            start_ms=0,
            end_ms=1,
            provider_result_id="id",
            automodel_is_final=False,
        ),
        ValueError,
    )
    _expect_error(
        lambda: to_dingbo_result(
            {"text": "甲"},
            session_id="sid",
            start_ms=0,
            end_ms=1,
            provider_result_id="id",
        ),
        ValueError,
    )
    _expect_error(
        lambda: to_dingbo_result(
            {"mode": "offline", "text": "甲"},
            session_id="sid",
            start_ms=5,
            end_ms=4,
            provider_result_id="id",
        ),
        ValueError,
    )


def test_ws_start_and_end_match_fixture() -> None:
    for case in _cases()["wsStart"]:
        actual = ws_start_message(case["sessionId"], case["hotwords"])
        assert actual == case["expected"]
        assert actual["chunk_size"] == list(WS_CHUNK_SIZE)
        inner = json.loads(actual["hotwords"])
        assert inner["阿里巴巴"] == 20
    assert ws_end_message() == {"is_speaking": False}


def test_automodel_kwargs_use_streaming_chunk_not_ws_chunk() -> None:
    partial = automodel_generate_kwargs(is_final=False)
    final = automodel_generate_kwargs(is_final=True)
    assert partial["chunk_size"] == list(AUTOMODEL_CHUNK_SIZE)
    assert partial["chunk_size"] != list(WS_CHUNK_SIZE)
    assert partial["encoder_chunk_look_back"] == 4
    assert partial["decoder_chunk_look_back"] == 1
    assert partial["is_final"] is False
    assert final["is_final"] is True
    assert "cache" not in partial
    assert "model" not in partial
    _expect_error(lambda: automodel_generate_kwargs(is_final=1), TypeError)  # type: ignore[arg-type]


def test_strip_pcm_header_roundtrip() -> None:
    header = {"type": "audio", "sessionId": "sid", "seq": 3, "startMs": 60, "durationMs": 20}
    pcm = struct.pack("<h", 1234) + b"\x00" * 638
    header_bytes = json.dumps(header, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    payload = struct.pack("!I", len(header_bytes)) + header_bytes + pcm
    parsed, raw = strip_pcm_header(payload)
    assert parsed == header
    assert raw == pcm
    _expect_error(lambda: strip_pcm_header(b"\x00\x00"), ValueError)
    _expect_error(lambda: strip_pcm_header(struct.pack("!I", 0) + pcm), ValueError)
    _expect_error(lambda: strip_pcm_header(struct.pack("!I", 20) + b"{}"), ValueError)
    truncated = struct.pack("!I", 8) + b"[1,2,3]"
    array_header = struct.pack("!I", 7) + b"[1,2,3]"
    _expect_error(lambda: strip_pcm_header(truncated), ValueError)
    _expect_error(lambda: strip_pcm_header(array_header), ValueError)


def test_bridge_does_not_import_funasr() -> None:
    assert "funasr" not in sys.modules
    assert "modelscope" not in sys.modules
    source = (ROOT / "bridge.py").read_text(encoding="utf-8")
    server = (ROOT / "server.py").read_text(encoding="utf-8")
    for text in (source, server):
        assert "import funasr" not in text
        assert "AutoModel(" not in text
        assert "snapshot_download" not in text
    assert "未加载模型" in server


def main() -> None:
    tests = [value for name, value in globals().items() if name.startswith("test_") and callable(value)]
    for test in tests:
        test()
    print(f"funasr bridge fixtures ok ({len(tests)})")


if __name__ == "__main__":
    main()
