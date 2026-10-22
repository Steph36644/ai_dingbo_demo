#!/usr/bin/env python3
"""FunASR sidecar。

对主进程只说盯播方言：health / start / flush / stop、长度前缀 PCM、isFinal、127.0.0.1 token。
默认在 CPU 上加载 paraformer-zh-streaming，并用 bridge.py 把音频和结果译过去。
`--stub` 仍回“未加载模型”，给不下载权重的测试用。
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import hashlib
import hmac
import json
import os
import struct
import sys

from bridge import hotwords_to_weighted_json, strip_pcm_header
from engine import Runtime, StreamingSession
from punc import PunctuationHost, PunctuationSession

GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
PARTIAL_EVERY_MS = 500
FINAL_EVERY_MS = 2_000
MAX_FRAME = 1_000_000


def accept_key(key: str) -> str:
    digest = hashlib.sha1((key + GUID).encode("ascii")).digest()
    return base64.b64encode(digest).decode("ascii")


def tokens_match(provided: str, expected: str) -> bool:
    left = provided.encode("utf-8")
    right = expected.encode("utf-8")
    if len(left) != len(right):
        return False
    return hmac.compare_digest(left, right)


class Connection:
    def __init__(
        self,
        reader: asyncio.StreamReader,
        writer: asyncio.StreamWriter,
        token: str,
        runtime: Runtime,
        punc_host: PunctuationHost,
    ) -> None:
        self.reader = reader
        self.writer = writer
        self.token = token
        self.runtime = runtime
        self.punc_host = punc_host
        self.punc_session: PunctuationSession | None = None
        self.authenticated = False
        self.session_id = ""
        self.audio_ms = 0
        self.next_partial_ms = PARTIAL_EVERY_MS
        self.next_final_ms = FINAL_EVERY_MS
        self.partial_index = 0
        self.final_index = 0
        self.funasr_hotwords = "{}"
        self.recognizer: StreamingSession | None = None

    async def run(self) -> None:
        try:
            if not await self.handshake():
                return
            while True:
                opcode, payload = await self.read_frame()
                if opcode == 0x8:
                    return
                if opcode == 0x9:
                    await self.send_frame(0xA, payload)
                    continue
                if opcode == 0x1:
                    await self.on_text(payload)
                elif opcode == 0x2:
                    await self.on_binary(payload)
        except (asyncio.IncompleteReadError, ConnectionError, ValueError, json.JSONDecodeError):
            return
        finally:
            self.writer.close()
            try:
                await self.writer.wait_closed()
            except ConnectionError:
                pass

    async def handshake(self) -> bool:
        raw = await self.reader.readuntil(b"\r\n\r\n")
        text = raw.decode("latin1", errors="replace")
        headers: dict[str, str] = {}
        for line in text.split("\r\n")[1:]:
            if ":" not in line:
                continue
            key, value = line.split(":", 1)
            headers[key.strip().lower()] = value.strip()
        if headers.get("upgrade", "").lower() != "websocket" or "sec-websocket-key" not in headers:
            self.writer.write(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n")
            await self.writer.drain()
            return False
        accept = accept_key(headers["sec-websocket-key"])
        response = (
            "HTTP/1.1 101 Switching Protocols\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Accept: {accept}\r\n"
            "\r\n"
        )
        self.writer.write(response.encode("ascii"))
        await self.writer.drain()
        return True

    async def read_frame(self) -> tuple[int, bytes]:
        head = await self.reader.readexactly(2)
        opcode = head[0] & 0x0F
        masked = (head[1] & 0x80) != 0
        length = head[1] & 0x7F
        if length == 126:
            length = struct.unpack("!H", await self.reader.readexactly(2))[0]
        elif length == 127:
            length = struct.unpack("!Q", await self.reader.readexactly(8))[0]
        if length > MAX_FRAME:
            raise ValueError("frame too large")
        mask = await self.reader.readexactly(4) if masked else b""
        payload = await self.reader.readexactly(length) if length else b""
        if masked:
            payload = bytes(payload[i] ^ mask[i % 4] for i in range(len(payload)))
        return opcode, payload

    async def send_frame(self, opcode: int, payload: bytes) -> None:
        header = bytearray([0x80 | opcode])
        size = len(payload)
        if size < 126:
            header.append(size)
        elif size < 65536:
            header.append(126)
            header.extend(struct.pack("!H", size))
        else:
            header.append(127)
            header.extend(struct.pack("!Q", size))
        self.writer.write(bytes(header) + payload)
        await self.writer.drain()

    async def send_json(self, payload: dict) -> None:
        await self.send_frame(0x1, json.dumps(payload, ensure_ascii=False).encode("utf-8"))

    async def on_text(self, payload: bytes) -> None:
        message = json.loads(payload.decode("utf-8"))
        kind = message.get("type")
        if kind == "health":
            if not tokens_match(str(message.get("token", "")), self.token):
                await self.send_json({"type": "error", "code": "unauthorized", "message": "令牌无效"})
                return
            await self.send_json(self.runtime.health_message())
            return
        if kind == "start":
            if not tokens_match(str(message.get("token", "")), self.token):
                await self.send_json({"type": "error", "code": "unauthorized", "message": "令牌无效"})
                return
            self.runtime.arm()
            assert self.runtime.settled is not None
            await self.runtime.settled.wait()
            if not self.runtime.stub and (self.runtime.error or self.runtime.service is None):
                await self.send_json(
                    {
                        "type": "error",
                        "code": "model",
                        "message": self.runtime.error or f"加载 {self.runtime.model_id} 失败",
                    }
                )
                return
            self.authenticated = True
            self.session_id = str(message.get("sessionId", ""))
            self.funasr_hotwords = _remember_hotwords(message.get("hotwords"))
            if self.runtime.service is not None:
                self.recognizer = StreamingSession(self.runtime.service, self.session_id)
            self.punc_session = self.punc_host.session()
            await self.send_json(self.runtime.ready_message())
            return
        if not self.authenticated:
            await self.send_json({"type": "error", "code": "unauthorized", "message": "尚未 start"})
            return
        if kind == "flush":
            if self.recognizer is not None:
                try:
                    results = self.recognizer.flush()
                except Exception as exc:
                    await self.send_json({"type": "error", "code": "model", "message": f"识别失败：{exc}"})
                    return
                await self._emit_recognized(results)
            else:
                await self.emit_final(force=True)
        elif kind == "stop":
            self.recognizer = None
            self.punc_session = None
            await self.send_json({"type": "stopped"})
        elif kind == "punctuate":
            await self.on_punctuate(message)

    async def on_binary(self, payload: bytes) -> None:
        if not self.authenticated or len(payload) < 4:
            return
        try:
            header, pcm = strip_pcm_header(payload)
        except json.JSONDecodeError:
            raise
        except ValueError:
            await self.send_json({"type": "error", "code": "protocol", "message": "音频帧头非法"})
            return
        duration = int(header.get("durationMs") or max(1, len(pcm) // 32))
        self.audio_ms += duration
        self.session_id = str(header.get("sessionId") or self.session_id)
        if self.recognizer is not None:
            try:
                results = self.recognizer.accept_pcm(pcm, duration)
            except Exception as exc:
                await self.send_json({"type": "error", "code": "model", "message": f"识别失败：{exc}"})
                return
            await self._emit_recognized(results)
            return
        while self.audio_ms >= self.next_partial_ms:
            await self.emit_partial(self.next_partial_ms)
            self.next_partial_ms += PARTIAL_EVERY_MS
        while self.audio_ms >= self.next_final_ms:
            await self.emit_final(force=False)
            self.next_final_ms += FINAL_EVERY_MS

    async def emit_partial(self, at_ms: int) -> None:
        self.partial_index += 1
        await self.send_json(
            {
                "type": "result",
                "sessionId": self.session_id,
                "providerResultId": f"stub-partial-{self.partial_index}",
                "startMs": max(0, at_ms - PARTIAL_EVERY_MS),
                "endMs": at_ms,
                "text": f"（FunASR 骨架，未加载模型）已接收 {at_ms} 毫秒音频",
                "isFinal": False,
                "confidence": 0,
            }
        )

    async def emit_final(self, force: bool) -> None:
        at_ms = self.audio_ms if force else self.next_final_ms
        if at_ms <= 0:
            return
        self.final_index += 1
        await self.send_json(
            {
                "type": "result",
                "sessionId": self.session_id,
                "providerResultId": f"stub-final-{self.final_index}",
                "startMs": max(0, at_ms - FINAL_EVERY_MS),
                "endMs": at_ms,
                "text": f"（FunASR 骨架，非真实转写）累计接收 {at_ms} 毫秒 PCM。",
                "isFinal": True,
                "confidence": 0,
            }
        )

    async def on_punctuate(self, message: dict) -> None:
        request_id = message.get("requestId")
        text = message.get("text", "")
        mode = message.get("mode", "realtime")
        reset = message.get("reset", False)
        cache = message.get("cache", None)
        if not isinstance(request_id, str) or request_id == "":
            await self.send_json({"type": "error", "code": "protocol", "message": "punctuate 缺少 requestId"})
            return
        if not isinstance(text, str) or mode not in {"realtime", "offline"} or not isinstance(reset, bool):
            await self._send_punctuated(request_id, False, text if isinstance(text, str) else "", "realtime", "标点请求不合法")
            return
        if cache is not None and not isinstance(cache, dict):
            await self._send_punctuated(request_id, False, text, mode, "cache 必须是对象")
            return
        session = self.punc_session
        if session is None:
            await self._send_punctuated(request_id, False, text, mode, "尚未 start")
            return
        try:
            result = await asyncio.to_thread(session.punctuate, text, mode, reset, cache)
        except Exception as exc:
            await self._send_punctuated(request_id, False, text, mode, f"标点失败：{exc}")
            return
        await self._send_punctuated(
            request_id,
            bool(result.get("ok")),
            str(result.get("text", text)),
            mode,
            str(result.get("detail", "")),
        )

    async def _send_punctuated(self, request_id: str, ok: bool, text: str, mode: str, detail: str) -> None:
        await self.send_json(
            {
                "type": "punctuated",
                "requestId": request_id,
                "ok": ok,
                "text": text,
                "mode": mode if mode in {"realtime", "offline"} else "realtime",
                "detail": detail,
            }
        )

    async def _emit_recognized(self, results: list[dict]) -> None:
        for result in results:
            await self.send_json(result)


async def serve(host: str, port: int, token: str, runtime: Runtime) -> None:
    punc_host = PunctuationHost(stub=runtime.stub)

    async def client(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        await Connection(reader, writer, token, runtime, punc_host).run()

    server = await asyncio.start_server(client, host, port)
    bound = server.sockets[0].getsockname()
    print(f"SIDECAR listening host={bound[0]} port={bound[1]}", flush=True)
    runtime.arm()
    loader: asyncio.Task[None] | None = None
    if not runtime.stub and not runtime.loaded:
        print(f"正在加载 {runtime.model_id}（CPU）", file=sys.stderr, flush=True)
        loader = asyncio.create_task(_load_model(runtime))
    try:
        async with server:
            await server.serve_forever()
    finally:
        if loader is not None and not loader.done():
            loader.cancel()


async def _load_model(runtime: Runtime) -> None:
    await runtime.load()
    if runtime.error:
        print(runtime.error, file=sys.stderr, flush=True)
    elif runtime.loaded:
        print(f"已加载 {runtime.model_id}（CPU）", file=sys.stderr, flush=True)


def _remember_hotwords(raw: object) -> str:
    """start 里的热词译成官方加权 JSON 字符串。坏输入不改变 stub 的 ready。"""
    try:
        return hotwords_to_weighted_json(raw if isinstance(raw, list) or raw is None else [])
    except (TypeError, ValueError):
        return "{}"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="FunASR sidecar")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--token", default="")
    parser.add_argument("--stub", action="store_true", help="不加载模型，只回骨架文本")
    parser.add_argument("--cache-dir", default="", help="模型缓存目录，必须在仓库外")
    return parser.parse_args()


def _stub_requested(args: argparse.Namespace) -> bool:
    if args.stub:
        return True
    return os.environ.get("FUNASR_SIDECAR_STUB") == "1"


def main() -> None:
    args = parse_args()
    if args.host not in {"127.0.0.1", "localhost"}:
        print("sidecar 只能绑定 127.0.0.1", file=sys.stderr)
        sys.exit(2)
    token = args.token or os.environ.get("FUNASR_SIDECAR_TOKEN", "")
    if not token:
        print("缺少令牌", file=sys.stderr)
        sys.exit(2)
    host = "127.0.0.1"
    runtime = Runtime(stub=_stub_requested(args))
    if args.cache_dir and not runtime.stub:
        os.environ["FUNASR_CACHE_DIR"] = args.cache_dir
    try:
        asyncio.run(serve(host, args.port, token, runtime))
    except KeyboardInterrupt:
        return


if __name__ == "__main__":
    main()
