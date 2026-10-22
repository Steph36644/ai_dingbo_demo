import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { encodeAudioMessage } from "../../src/main/asr/funasrProtocol";
import { AUDIO } from "../../src/shared/config/defaults";
import type { AudioFrame } from "../../src/shared/contracts/audio";
import { pythonArgs, pythonEnv } from "../helpers/python";

const root = path.resolve(__dirname, "../..");
const fixturePath = path.join(root, "python/funasr_sidecar/fixtures/mapping_cases.json");

type ResultCase = {
  name: string;
  payload: { mode?: string; text?: string; is_final?: boolean };
  automodelIsFinal?: boolean;
  expected: {
    type: string;
    sessionId: string;
    providerResultId: string;
    startMs: number;
    endMs: number;
    text: string;
    isFinal: boolean;
  };
};

function expectedIsFinal(item: ResultCase): boolean {
  if (typeof item.automodelIsFinal === "boolean") return item.automodelIsFinal;
  if (item.payload.mode === "online" || item.payload.mode === "2pass-online") return false;
  if (item.payload.mode === "offline" || item.payload.mode === "2pass-offline") return true;
  throw new Error(`fixture ${item.name} 没有 mode`);
}

function frame(seq: number): AudioFrame {
  const samples = new Int16Array(AUDIO.frameSamples);
  samples[0] = 1234;
  return {
    sessionId: "sid",
    seq,
    startMs: seq * 20,
    durationMs: 20,
    sampleRate: 16000,
    channels: 1,
    encoding: "pcm_s16le",
    samples,
    rms: 0,
  };
}

describe("FunASR 协议桥 fixture", () => {
  it("Python 纯函数按 fixture 完成热词、首包和 online/offline 映射", () => {
    const python = pythonArgs(["python/funasr_sidecar/test_bridge.py"]);
    const run = spawnSync(python.command, python.args, {
      cwd: root,
      encoding: "utf8",
      env: pythonEnv(),
    });
    expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
    expect(run.stdout).toMatch(/funasr bridge fixtures ok/);
    expect(`${run.stdout}\n${run.stderr}`).not.toMatch(/modelscope|snapshot_download|Downloading/);
  });

  it("Python 标点在不下载模型时复用 cache，stub 明确不可用", () => {
    const python = pythonArgs(["python/funasr_sidecar/test_punc.py"]);
    const run = spawnSync(python.command, python.args, {
      cwd: root,
      encoding: "utf8",
      env: pythonEnv(),
    });
    expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
    expect(run.stdout).toMatch(/funasr punc fixtures ok/);
    expect(`${run.stdout}\n${run.stderr}`).not.toMatch(/modelscope|snapshot_download|Downloading/);
  });

  it("Python 引擎在不下载模型时报告 paraformer-zh-streaming", () => {
    const python = pythonArgs(["python/funasr_sidecar/test_engine.py"]);
    const run = spawnSync(python.command, python.args, {
      cwd: root,
      encoding: "utf8",
      env: pythonEnv(),
    });
    expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
    expect(run.stdout).toMatch(/funasr engine fixtures ok/);
  });

  it("fixture 中的盯播 result 与 isFinal 规则一致，且不含官方字段", () => {
    const cases = JSON.parse(readFileSync(fixturePath, "utf8")) as {
      hotwords: Array<{ expected: string }>;
      results: ResultCase[];
      wsStart: Array<{ expected: { mode: string; hotwords: string; chunk_size: number[]; itn: boolean; is_speaking: boolean } }>;
    };
    for (const item of cases.hotwords) {
      const weighted = JSON.parse(item.expected) as Record<string, number>;
      for (const weight of Object.values(weighted)) expect(weight).toBeGreaterThan(0);
    }
    for (const item of cases.results) {
      expect(Object.keys(item.expected).sort()).toEqual([
        "endMs",
        "isFinal",
        "providerResultId",
        "sessionId",
        "startMs",
        "text",
        "type",
      ]);
      expect(item.expected.type).toBe("result");
      expect(item.expected.isFinal).toBe(expectedIsFinal(item));
      expect(JSON.stringify(item.expected)).not.toMatch(/"mode"|"is_final"|"timestamp"|"wav_name"/);
    }
    expect(cases.wsStart[0]?.expected).toMatchObject({
      mode: "2pass",
      is_speaking: true,
      chunk_size: [5, 10, 5],
      itn: true,
    });
    expect(JSON.parse(cases.wsStart[0]!.expected.hotwords)).toMatchObject({ 阿里巴巴: 20 });
  });

  it("encodeAudioMessage 的长度头能被 Python 剥成 raw PCM", () => {
    const encoded = encodeAudioMessage(frame(3));
    const python = pythonArgs([
      "-c",
      [
        "import base64, json, sys",
        "sys.path.insert(0, 'python/funasr_sidecar')",
        "from bridge import strip_pcm_header",
        "header, pcm = strip_pcm_header(base64.b64decode(sys.stdin.read()))",
        "json.dump({'header': header, 'pcmHex': pcm.hex()}, sys.stdout)",
      ].join("\n"),
    ]);
    const run = spawnSync(
      python.command,
      python.args,
      { cwd: root, input: encoded.toString("base64"), encoding: "utf8", env: pythonEnv() },
    );
    expect(run.status, run.stderr).toBe(0);
    const parsed = JSON.parse(run.stdout) as { header: Record<string, unknown>; pcmHex: string };
    expect(parsed.header).toMatchObject({ type: "audio", sessionId: "sid", seq: 3, startMs: 60, durationMs: 20 });
    expect(Buffer.from(parsed.pcmHex, "hex").readInt16LE(0)).toBe(1234);
    expect(Buffer.from(parsed.pcmHex, "hex")).toHaveLength(AUDIO.frameBytes);
  });
});
