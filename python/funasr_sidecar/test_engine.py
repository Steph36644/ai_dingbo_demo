"""F1 流式会话与 health 模型 id。不下载权重。"""

from __future__ import annotations

import asyncio
import json
import os
import struct
import sys
from pathlib import Path

import engine
from engine import (
    CHUNK_BYTES,
    MODEL_ID,
    ModelService,
    Runtime,
    StreamingSession,
    pcm_s16le_to_float32,
    resolve_cache_dir,
    short_load_error,
)

ROOT = Path(__file__).resolve().parents[2]


def _expect_error(fn, exc: type[BaseException]) -> None:
    try:
        fn()
    except exc:
        return
    raise AssertionError(f"expected {exc.__name__}")


def _fake_generate(waveform: list[float], cache: dict, kwargs: dict) -> list[dict[str, str]]:
    cache.setdefault("calls", 0)
    cache["calls"] += 1
    assert kwargs["chunk_size"] == [0, 10, 5]
    assert kwargs["encoder_chunk_look_back"] == 4
    assert kwargs["decoder_chunk_look_back"] == 1
    assert "hotwords" not in kwargs
    if kwargs["is_final"]:
        return [{"text": "定稿"}]
    assert len(waveform) == 9600
    return [{"text": "片段"}]


def test_import_engine_does_not_import_funasr() -> None:
    assert "funasr" not in sys.modules
    assert "modelscope" not in sys.modules
    assert "torch" not in sys.modules
    source = Path(engine.__file__).read_text(encoding="utf-8")
    assert "from funasr import AutoModel" in source
    assert 'device="cpu"' in source
    assert "snapshot_download" not in source


def test_cache_dir_stays_outside_the_repo() -> None:
    saved = {name: os.environ.pop(name, None) for name in ("MODELSCOPE_CACHE", "FUNASR_CACHE_DIR")}
    try:
        home_cache = resolve_cache_dir(None)
        assert home_cache == (Path.home() / ".cache" / "modelscope").resolve()
        assert home_cache != ROOT and ROOT not in home_cache.parents
    finally:
        for name, value in saved.items():
            if value is not None:
                os.environ[name] = value
    _expect_error(lambda: resolve_cache_dir(str(ROOT / "modelscope_cache")), RuntimeError)
    _expect_error(lambda: resolve_cache_dir(str(ROOT)), RuntimeError)


def test_short_load_error_keeps_one_actionable_line() -> None:
    unregistered = (
        "model 'paraformer-zh-streaming' is not registered.\n"
        "Registered model keys (51): BAT, CAT, ...\n"
        " - funasr.models.ctc: No module named 'funasr.models.ctc'\n"
        " - torch: No module named 'torch'"
    )
    assert short_load_error(MODEL_ID, RuntimeError(unregistered)) == (
        "本地识别模型加载失败：缺少 torch 依赖，请修复 FunASR 环境后重试。"
    )
    download = "Download: iic/speech_paraformer-large failed!: Max retries exceeded"
    assert short_load_error(MODEL_ID, RuntimeError(download)) == "本地识别模型下载失败，请检查网络后重试。"
    assert len(short_load_error(MODEL_ID, RuntimeError("未知原因"))) < 40


def test_streaming_session_maps_partial_and_final() -> None:
    service = ModelService(MODEL_ID, _fake_generate)
    session = StreamingSession(service, "sid")
    frame = b"\x01\x00" * 320
    partials: list[dict] = []
    for _ in range(30):
        partials.extend(session.accept_pcm(frame, 20))
    assert len(partials) == 1
    assert partials[0]["type"] == "result"
    assert partials[0]["isFinal"] is True
    assert partials[0]["text"] == "片段"
    assert partials[0]["startMs"] == 0
    assert partials[0]["endMs"] == 600
    assert partials[0]["providerResultId"] == f"{MODEL_ID}-1"
    assert "mode" not in partials[0]
    assert len(session.pending) == 0
    finals = session.flush()
    assert finals[0]["isFinal"] is True
    assert finals[0]["text"] == "定稿"
    assert finals[0]["startMs"] == 600
    assert session.cache == {}
    assert session.flush() == []


def test_short_utterance_is_only_final() -> None:
    service = ModelService(MODEL_ID, _fake_generate)
    session = StreamingSession(service, "sid")
    assert session.accept_pcm(b"\x00\x00" * 320, 20) == []
    finals = session.flush()
    assert len(finals) == 1
    assert finals[0]["isFinal"] is True
    assert finals[0]["endMs"] == 20


def test_empty_text_is_not_emitted() -> None:
    def silent(waveform: list[float], cache: dict, kwargs: dict) -> list[dict[str, str]]:
        return [{"text": ""}]

    session = StreamingSession(ModelService(MODEL_ID, silent), "sid")
    assert session.accept_pcm(b"\x00" * CHUNK_BYTES, 600) == []
    assert session.flush() == []


def test_pcm_conversion_matches_s16le() -> None:
    pcm = struct.pack("<hh", 16384, -32768)
    assert pcm_s16le_to_float32(pcm) == [0.5, -1.0]
    assert pcm_s16le_to_float32(b"\x00") == []


def test_health_reports_real_model_id_when_loaded() -> None:
    loading = Runtime(stub=False)
    loading_message = loading.health_message()
    assert loading_message["ok"] is False
    assert loading_message["model"] == MODEL_ID
    assert MODEL_ID in loading_message["detail"]

    loaded = Runtime(stub=False)
    loaded.preload(ModelService(MODEL_ID, _fake_generate))
    ready = loaded.health_message()
    assert ready["ok"] is True
    assert ready["model"] == MODEL_ID
    assert ready["detail"] == f"已加载 {MODEL_ID}（CPU）"
    assert loaded.ready_message()["model"] == MODEL_ID

    failed = Runtime(stub=False)
    failed.error = f"加载 {MODEL_ID} 失败：找不到 funasr"
    failed_message = failed.health_message()
    assert failed_message["ok"] is False
    assert failed_message["model"] == MODEL_ID
    assert "找不到 funasr" in failed_message["detail"]

    stub = Runtime(stub=True)
    assert stub.health_message()["model"] == "stub"
    assert stub.health_message()["ok"] is True


def test_wire_health_and_results_use_model_id() -> None:
    asyncio.run(_wire())


async def _wire() -> None:
    from punc import PunctuationHost
    from server import Connection

    runtime = Runtime(stub=False)
    runtime.preload(ModelService(MODEL_ID, _fake_generate))
    punc_host = PunctuationHost(stub=True)

    async def client(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        await Connection(reader, writer, "tok", runtime, punc_host).run()

    server = await asyncio.start_server(client, "127.0.0.1", 0)
    sockets = server.sockets
    assert sockets is not None
    port = sockets[0].getsockname()[1]
    try:
        reader, writer = await asyncio.open_connection("127.0.0.1", port)
        key = "dGhlIHNhbXBsZSBub25jZQ=="
        writer.write(
            (
                "GET / HTTP/1.1\r\n"
                "Host: 127.0.0.1\r\n"
                "Upgrade: websocket\r\n"
                "Connection: Upgrade\r\n"
                f"Sec-WebSocket-Key: {key}\r\n"
                "Sec-WebSocket-Version: 13\r\n\r\n"
            ).encode("ascii")
        )
        await writer.drain()
        handshake = await reader.readuntil(b"\r\n\r\n")
        assert b"101" in handshake

        writer.write(_frame(0x1, json.dumps({"type": "health", "token": "tok"}).encode()))
        await writer.drain()
        health = await _read_json(reader)
        assert health["ok"] is True
        assert health["model"] == MODEL_ID

        writer.write(
            _frame(
                0x1,
                json.dumps(
                    {
                        "type": "start",
                        "token": "tok",
                        "sessionId": "sid",
                        "language": "zh-CN",
                        "sampleRate": 16000,
                        "hotwords": ["直播间"],
                    }
                ).encode(),
            )
        )
        await writer.drain()
        ready = await _read_json(reader)
        assert ready["type"] == "ready"
        assert ready["model"] == MODEL_ID

        for seq in range(30):
            writer.write(_frame(0x2, _audio_frame(seq)))
        await writer.drain()
        partial = await _read_json(reader)
        assert partial["isFinal"] is True
        assert partial["text"] == "片段"
        assert partial["sessionId"] == "sid"

        writer.write(_frame(0x1, json.dumps({"type": "flush", "sessionId": "sid"}).encode()))
        await writer.drain()
        final = await _read_json(reader)
        assert final["isFinal"] is True
        assert final["text"] == "定稿"
        assert "mode" not in final

        writer.write(_frame(0x1, json.dumps({"type": "stop", "sessionId": "sid"}).encode()))
        await writer.drain()
        stopped = await _read_json(reader)
        assert stopped["type"] == "stopped"
        writer.close()
        await writer.wait_closed()
    finally:
        server.close()
        await server.wait_closed()


def _audio_frame(seq: int) -> bytes:
    header = json.dumps(
        {"type": "audio", "sessionId": "sid", "seq": seq, "startMs": seq * 20, "durationMs": 20},
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")
    pcm = b"\x00\x01" * 320
    return struct.pack("!I", len(header)) + header + pcm


def _frame(opcode: int, payload: bytes) -> bytes:
    header = bytearray([0x80 | opcode])
    size = len(payload)
    if size < 126:
        header.append(size)
    else:
        header.append(126)
        header.extend(struct.pack("!H", size))
    return bytes(header) + payload


async def _read_json(reader: asyncio.StreamReader) -> dict:
    head = await asyncio.wait_for(reader.readexactly(2), timeout=2)
    length = head[1] & 0x7F
    if length == 126:
        length = struct.unpack("!H", await reader.readexactly(2))[0]
    payload = await reader.readexactly(length)
    return json.loads(payload.decode("utf-8"))


def main() -> None:
    tests = [value for name, value in globals().items() if name.startswith("test_") and callable(value)]
    for test in tests:
        test()
    print(f"funasr engine fixtures ok ({len(tests)})")


if __name__ == "__main__":
    main()
